import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import * as readline from "readline";
import { chromium } from "playwright";
import { getCtx } from "./context";
import { ProxyRotator } from "./proxy-rotator";
import {
  PROBE_TIMEOUT_MS,
  PROBE_INTEL_PATH,
  KATANA_BIN_NAME,
  KATANA_CRAWL_DEPTH,
  STEALTH_SCRIPT,
} from "../constants";
import type {
  ProbeIntel,
  ProbeButtonHint,
  AntiBotStack,
  QueueSystem,
  CapturedRequest,
} from "./types";

const BUNDLE_SCAN_URL_RE =
  /['"`](\/(?:api|v\d+|graphql)[^'"`\s]{0,200})['"`]/gi;
const BUNDLE_MAX_BYTES = 1_000_000;

export class ProbeWorker {
  private katanaAvailable: boolean | null = null;
  private abortRequested = false;
  private activeBrowser: import("playwright").Browser | null = null;
  private activeKatanaProc: ReturnType<typeof spawn> | null = null;

  constructor(private rotator: ProxyRotator) {}

  abort(): void {
    this.abortRequested = true;
    this.activeBrowser?.close().catch(() => {});
    this.activeKatanaProc?.kill();
  }

  async runProbe(): Promise<ProbeIntel> {
    const { config, bus } = getCtx();
    const proxy = this.rotator.next();
    this.abortRequested = false;

    bus.emit("system:log", {
      scope: "probe",
      message: `starting probe of ${config.targetUrl} via ${proxy ?? "direct"}`,
    });

    const [playwrightResult, katanaEndpoints] = await Promise.all([
      this.runPlaywrightScan(config.targetUrl, proxy).catch((err) => {
        bus.emit("system:log", {
          scope: "probe",
          message: `playwright scan failed: ${err}`,
        });
        return null;
      }),
      this.runKatanaIfAvailable(config.targetUrl, proxy).catch(
        () => [] as string[],
      ),
    ]);

    if (this.abortRequested) {
      throw new Error("probe aborted");
    }

    if (!playwrightResult) {
      if (proxy) this.rotator.markBad(proxy);
      throw new Error("probe playwright scan failed");
    }

    const existingUrls = new Set(
      playwrightResult.apiRequests.map((r) => r.url),
    );
    for (const url of katanaEndpoints) {
      if (!existingUrls.has(url)) {
        playwrightResult.apiRequests.push({
          url,
          method: "GET",
          source: "xhr",
        });
      }
    }

    const inventoryEndpoint = playwrightResult.apiRequests.find((r) =>
      /availab|inventory|stock|ticket.*count|seat.*avail/i.test(r.url),
    )?.url;

    const checkoutEndpoint = playwrightResult.apiRequests.find((r) =>
      /checkout|order|payment|purchase/i.test(r.url),
    );

    const checkoutFlow = checkoutEndpoint
      ? {
          endpoint: checkoutEndpoint.url,
          method: checkoutEndpoint.method,
          requiredHeaders: [],
          payloadShape: {},
        }
      : undefined;

    const intel: ProbeIntel = {
      ts: Date.now(),
      targetUrl: config.targetUrl,
      isSpa: playwrightResult.isSpa,
      buttonHints: playwrightResult.buttonHints,
      checkoutFlow,
      queueSystem: playwrightResult.queueSystem,
      antiBot: playwrightResult.antiBot,
      inventoryEndpoint,
      apiRequests: playwrightResult.apiRequests,
    };

    const dumpPath = path.resolve(PROBE_INTEL_PATH);
    fs.mkdirSync(path.dirname(dumpPath), { recursive: true });
    fs.writeFileSync(dumpPath, JSON.stringify(intel, null, 2));

    bus.emit("probe:intel", intel);
    bus.emit("system:log", {
      scope: "probe",
      message: `done — ${intel.buttonHints.length} button hint(s), antiBot: ${intel.antiBot.vendor}, queue: ${intel.queueSystem.type}, spa: ${intel.isSpa}`,
    });

    return intel;
  }

  loadPersistedIntel(): ProbeIntel | null {
    try {
      const dumpPath = path.resolve(PROBE_INTEL_PATH);
      if (!fs.existsSync(dumpPath)) return null;
      const raw = JSON.parse(fs.readFileSync(dumpPath, "utf-8")) as ProbeIntel;
      if (!raw.apiRequests && raw.apiEndpoints) {
        raw.apiRequests = raw.apiEndpoints.map((url) => ({
          url,
          method: "GET",
          source: "xhr" as const,
        }));
      }
      raw.apiRequests ??= [];
      return raw;
    } catch {
      return null;
    }
  }

  private async runPlaywrightScan(
    targetUrl: string,
    proxy: string | null,
  ): Promise<
    Omit<
      ProbeIntel,
      "ts" | "targetUrl" | "apiRequests" | "inventoryEndpoint" | "checkoutFlow"
    > & { apiRequests: CapturedRequest[] }
  > {
    const browser = await chromium.launch({ headless: true });
    this.activeBrowser = browser;
    try {
      const contextOpts: Parameters<typeof browser.newContext>[0] = {};
      if (proxy) contextOpts.proxy = { server: proxy };

      const context = await browser.newContext(contextOpts);
      await context.addInitScript(STEALTH_SCRIPT);
      const page = await context.newPage();

      const capturedRequests = new Map<string, CapturedRequest>();
      const bundleEndpoints: string[] = [];

      page.on("request", (req) => {
        const type = req.resourceType();
        if (type === "xhr" || type === "fetch") {
          capturedRequests.set(req.url(), {
            url: req.url(),
            method: req.method(),
            requestBody: req.postData() ?? undefined,
            source: "xhr",
          });
        }
      });

      page.on("response", async (res) => {
        const type = res.request().resourceType();

        if (type === "xhr" || type === "fetch") {
          const entry = capturedRequests.get(res.url());
          if (entry) {
            entry.responseStatus = res.status();
            try {
              const text = await res.text();
              if (text) {
                try {
                  const json = JSON.parse(text);
                  if (
                    typeof json === "object" &&
                    json !== null &&
                    !Array.isArray(json)
                  ) {
                    entry.responseShape = Object.keys(json).slice(0, 30);
                  } else if (
                    Array.isArray(json) &&
                    json.length > 0 &&
                    typeof json[0] === "object"
                  ) {
                    entry.responseShape = Object.keys(json[0]).slice(0, 30);
                  }
                } catch {}
              }
            } catch {}
          }
        }

        if (type === "script") {
          try {
            const buf = await res.body();
            if (buf.length > BUNDLE_MAX_BYTES) return;
            const text = buf.toString("utf-8");
            BUNDLE_SCAN_URL_RE.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = BUNDLE_SCAN_URL_RE.exec(text)) !== null) {
              bundleEndpoints.push(m[1]);
            }
          } catch {}
        }
      });

      let status429 = false;
      let status403 = false;
      const capturedUrls: string[] = [];

      page.on("request", (req) => {
        capturedUrls.push(req.url());
      });

      page.on("response", (res) => {
        if (res.status() === 429) status429 = true;
        if (res.status() === 403) status403 = true;
      });

      await page.goto(targetUrl, {
        waitUntil: "load",
        timeout: PROBE_TIMEOUT_MS,
      });
      await page
        .waitForLoadState("networkidle", { timeout: 5000 })
        .catch(() => {});

      const cookies = await context.cookies();
      const cookieNames = cookies.map((c) => c.name);
      const scripts = await page.evaluate(() =>
        Array.from(document.querySelectorAll("script[src]")).map(
          (s) => (s as HTMLScriptElement).src,
        ),
      );
      const htmlContent = await page.content();

      const antiBot = detectAntiBot(
        cookieNames,
        scripts,
        htmlContent,
        status429,
        status403,
      );
      const queueSystem = detectQueueSystem(capturedUrls, htmlContent, scripts);
      const isSpa = detectSpa(scripts, htmlContent);

      const buttonHints = await extractButtonHints(page);

      const uniqueBundleUrls = [...new Set(bundleEndpoints)].filter(
        (u) => !capturedRequests.has(u),
      );
      for (const url of uniqueBundleUrls) {
        capturedRequests.set(url, { url, method: "GET", source: "bundle" });
      }

      const { bus } = getCtx();
      bus.emit("system:log", {
        scope: "probe",
        message: `playwright done — ${capturedRequests.size - uniqueBundleUrls.length} xhr/fetch, ${uniqueBundleUrls.length} bundle endpoint(s), ${buttonHints.length} button(s)`,
      });

      await context.close();
      this.activeBrowser = null;

      return {
        isSpa,
        buttonHints,
        queueSystem,
        antiBot,
        apiRequests: [...capturedRequests.values()],
      };
    } finally {
      await browser.close().catch(() => {});
      this.activeBrowser = null;
    }
  }

  private async runKatanaIfAvailable(
    targetUrl: string,
    proxy: string | null,
  ): Promise<string[]> {
    const { config, bus } = getCtx();
    if (!config.katanaEnabled) return [];
    if (this.katanaAvailable === null) {
      this.katanaAvailable = await checkBinaryExists(KATANA_BIN_NAME);
    }
    if (!this.katanaAvailable) {
      bus.emit("system:log", {
        scope: "probe",
        message: "failed running katana JS crawl",
      });
      return [];
    }

    bus.emit("system:log", {
      scope: "probe",
      message: "running katana JS crawl",
    });

    return new Promise((resolve) => {
      const args = [
        "-u",
        targetUrl,
        "-jc",
        "-kf",
        "all",
        "-d",
        String(KATANA_CRAWL_DEPTH),
        "-f",
        "url",
        "-o",
        "json",
        "-silent",
      ];
      if (proxy) args.push("-proxy", proxy);

      const proc = spawn(KATANA_BIN_NAME, args);
      this.activeKatanaProc = proc;
      const urls: string[] = [];
      const rl = readline.createInterface({ input: proc.stdout });

      rl.on("line", (line: string) => {
        try {
          const record = JSON.parse(line) as {
            request?: { endpoint?: string };
          };
          const url = record?.request?.endpoint;
          if (url) urls.push(url);
        } catch {}
      });

      const timer = setTimeout(() => {
        proc.kill();
        resolve(urls);
      }, PROBE_TIMEOUT_MS);

      proc.on("close", () => {
        clearTimeout(timer);
        this.activeKatanaProc = null;
        bus.emit("system:log", {
          scope: "probe",
          message: `katana complete — ${urls.length} endpoint(s) found`,
        });
        resolve(urls);
      });
    });
  }
}

async function checkBinaryExists(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(name, ["-version"]);
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0 || code === 1));
  });
}

async function extractButtonHints(
  page: import("playwright").Page,
): Promise<ProbeButtonHint[]> {
  const hints = await page.evaluate(() => {
    function cssPath(el: Element): string {
      const tag = el.tagName.toLowerCase();
      if ((el as HTMLElement).id)
        return `#${CSS.escape((el as HTMLElement).id)}`;
      for (const attr of ["data-testid", "data-cy", "data-test", "data-qa"]) {
        const v = el.getAttribute(attr);
        if (v) return `[${attr}="${v}"]`;
      }
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return `${tag}[aria-label="${ariaLabel}"]`;
      const name = el.getAttribute("name");
      if (name) return `${tag}[name="${name}"]`;
      const text = (el.textContent ?? "").trim().slice(0, 40);
      if (text && text.length < 40) return `${tag}:contains("${text}")`;
      const parts: string[] = [];
      let cur: Element | null = el;
      while (cur && cur.tagName !== "BODY") {
        const parent: Element | null = cur.parentElement;
        if (!parent) break;
        const idx = Array.from(parent.children).indexOf(cur) + 1;
        parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${idx})`);
        cur = parent;
      }
      return parts.join(" > ");
    }

    const BUY_TEXT =
      /buy|purchase|checkout|get ticket|beli|pesan|book|add to cart/i;
    const tags =
      "button, input[type='button'], input[type='submit'], [role='button'], a, [onclick]";
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(tags));
    const results: Array<{
      selector: string;
      confidence: number;
      text: string;
      classes: string;
      dataAttrs: string[];
    }> = [];
    let maxArea = 0;

    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      )
        continue;
      const area = rect.width * rect.height;
      if (area > maxArea) maxArea = area;
    }

    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      )
        continue;

      const area = rect.width * rect.height;
      const text = (el.textContent ?? "").trim().slice(0, 80);
      const textMatch = BUY_TEXT.test(text) ? 0.4 : 0;
      const sizeScore = maxArea > 0 ? (area / maxArea) * 0.6 : 0;
      const confidence = Math.min(1, textMatch + sizeScore);

      const dataAttrs: string[] = [];
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.startsWith("data-")) {
          dataAttrs.push(`${attr.name}=${attr.value}`);
        }
      }

      results.push({
        selector: cssPath(el),
        confidence,
        text,
        classes: el.className,
        dataAttrs,
      });
    }

    return results.sort((a, b) => b.confidence - a.confidence);
  });

  return hints.map((h) => ({ ...h, source: "playwright" as const }));
}

function detectAntiBot(
  cookieNames: string[],
  scripts: string[],
  html: string,
  status429: boolean,
  status403: boolean,
): AntiBotStack {
  const scriptSrc = scripts.join(" ");
  const cookieStr = cookieNames.join(" ");

  if (
    cookieStr.includes("_abck") ||
    scriptSrc.includes("akam") ||
    html.includes("bm_sz")
  ) {
    return {
      vendor: "akamai",
      cookieName: "_abck",
      recommendedRefreshMs: 3_000,
    };
  }
  if (cookieStr.includes("cf_clearance") || html.includes("__cf_bm")) {
    return {
      vendor: "cloudflare",
      cookieName: "cf_clearance",
      recommendedRefreshMs: 2_000,
    };
  }
  if (
    scriptSrc.includes("px.js") ||
    cookieStr.includes("_px3") ||
    html.includes("PerimeterX")
  ) {
    return {
      vendor: "perimeterx",
      cookieName: "_px3",
      recommendedRefreshMs: 2_500,
    };
  }
  if (cookieStr.includes("datadome") || scriptSrc.includes("datadome")) {
    return {
      vendor: "datadome",
      cookieName: "datadome",
      recommendedRefreshMs: 2_000,
    };
  }

  const recommendedRefreshMs = status429 ? 1_500 : status403 ? 1_200 : 800;
  return { vendor: "none", recommendedRefreshMs };
}

function detectQueueSystem(
  capturedUrls: string[],
  html: string,
  scripts: string[],
): QueueSystem {
  const urlStr = capturedUrls.join(" ");
  const scriptSrc = scripts.join(" ");

  if (
    urlStr.includes("queue-it.net") ||
    html.includes("QueueIT") ||
    scriptSrc.includes("queue-it")
  ) {
    const positionUrl = capturedUrls.find(
      (u) => u.includes("queue-it.net") && u.includes("status"),
    );
    return {
      type: "queue-it",
      positionEndpoint: positionUrl,
      passedSignal: "QueueITCallback",
    };
  }
  if (
    urlStr.includes("waiting-room") ||
    html.includes("akamai-waiting-room") ||
    scriptSrc.includes("waiting-room")
  ) {
    return { type: "akamai-waiting-room" };
  }
  if (/queue|waiting.room|virtual.queue/i.test(urlStr)) {
    return { type: "custom" };
  }
  return { type: "none" };
}

function detectSpa(scripts: string[], html: string): boolean {
  const scriptSrc = scripts.join(" ");
  if (
    scriptSrc.includes("react") ||
    scriptSrc.includes("vue") ||
    scriptSrc.includes("angular")
  )
    return true;
  if (
    html.includes("__NEXT_DATA__") ||
    html.includes("__NUXT__") ||
    html.includes("ng-version")
  )
    return true;
  const bundleCount = scripts.filter((s) =>
    /chunk|bundle|main\.[a-f0-9]+\.js/i.test(s),
  ).length;
  return bundleCount >= 2;
}

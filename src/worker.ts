import path from "path";
import fs from "fs";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Frame,
} from "playwright";
import { detectState, findPrimaryButton } from "./detector";
import { getCtx } from "./context";
import {
  STEALTH_SCRIPT,
  SESSION_DIR,
  WORKER_STATES,
  WORKER_COMMANDS,
  CLICK_JITTER_MIN_MS,
  CLICK_JITTER_MAX_MS,
  RELOAD_JITTER_MIN_MS,
  RELOAD_JITTER_MAX_MS,
} from "../constants";
import type { WorkerCredential, WorkerState, ControllerMessage, ProbeIntel } from "./types";

export class Worker {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private state: WorkerState = WORKER_STATES.UNSPAWNED;
  private running = false;
  private frameNavRegistered = false;
  private _closed = false;
  private consecutiveErrors = 0;
  private unsubscribeCmd: (() => void) | null = null;
  private unsubscribeIntel: (() => void) | null = null;
  private currentFocus = "";
  private lastNet: { status: number; url: string } | null = null;
  private latestIntel: ProbeIntel | null = null;
  private inventoryPollRunning = false;

  constructor(
    private id: number,
    private credential: WorkerCredential,
    private targetUrl: string,
    private userAgent: string,
    private onCrash: () => void,
  ) {}

  isLaunched(): boolean {
    return this.browser !== null;
  }

  setTargetUrl(url: string): void {
    this.targetUrl = url;
    this.emitState();
  }

  async launch(): Promise<void> {
    if (this.isLaunched()) return;

    const { config } = getCtx();
    const sessionPath = path.resolve(SESSION_DIR, `worker-${this.id}`);
    fs.mkdirSync(sessionPath, { recursive: true });

    this.setFocus("launching browser");

    this.browser = await chromium.launch({
      headless: config.headless,
      args: [
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--window-size=1280,800",
      ],
    });

    this.browser.on("disconnected", () => {
      if (this._closed) return;
      this._closed = true;
      this.browser = null;
      this.context = null;
      this.page = null;
      this.running = false;
      this.setState(WORKER_STATES.ERROR);
      this.onCrash();
    });

    const contextOptions: Parameters<Browser["newContext"]>[0] = {
      userAgent: this.userAgent,
      viewport: { width: 1280, height: 800 },
      locale: config.locale,
      timezoneId: config.timezoneId,
      storageState: this.loadSession(sessionPath),
    };

    if (this.credential.proxy) {
      contextOptions.proxy = { server: this.credential.proxy };
    }

    this.context = await this.browser.newContext(contextOptions);
    await this.context.addInitScript(STEALTH_SCRIPT);
    this.page = await this.context.newPage();

    this.page.on("response", (res) => {
      const type = res.request().resourceType();
      if (type !== "xhr" && type !== "fetch") return;
      const status = res.status();
      const url = res.url();
      this.lastNet = { status, url };
      if (status === 429) {
        this.setFocus(`rate limited (429) — ${this.urlShort(url)}`);
        this.consecutiveErrors++;
      } else if (status === 401 || status === 403) {
        this.setFocus(`auth failure (${status}) — session may be dead`);
        this.log(`account health warning: ${status} from ${url}`);
      } else if (status >= 500) {
        this.log(`server error ${status}: ${url}`);
      }
    });

    const { bus } = getCtx();
    this.unsubscribeCmd = bus.on(`cmd:${this.id}`, (msg) =>
      this.handleCommand(msg),
    );
    this.unsubscribeIntel = bus.on("probe:intel", (intel) => {
      this.latestIntel = intel;
      this.log(`received probe intel: ${intel.buttonHints.length} hint(s), antiBot: ${intel.antiBot.vendor}`);
    });

    this.setState(WORKER_STATES.IDLE);
    this.setFocus("idle");
    this.log("launch");
  }

  async preNavigate(): Promise<void> {
    if (!this.page) return;
    this.setState(WORKER_STATES.NAVIGATING);
    this.setFocus(`navigating to ${this.targetUrl}`);
    try {
      await this.page.goto(this.targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      this.setState(WORKER_STATES.PRE_QUEUE);
      this.setFocus("waiting for sale");
      this.log(`pre navigating to ${this.targetUrl}`);
    } catch (err) {
      this.log(`pre navigate failed, fuckkkkkkk: ${err}`);
      this.setState(WORKER_STATES.ERROR);
    }
  }

  setIntel(intel: ProbeIntel): void {
    this.latestIntel = intel;
  }

  async start(): Promise<void> {
    if (!this.page) return;
    this.running = true;

    if (!this.frameNavRegistered) {
      this.frameNavRegistered = true;
      this.page.on("framenavigated", (frame: Frame) => {
        if (frame !== this.page?.mainFrame()) return;
        if (!this.running) return;
        this.onPageChange().catch(() => {});
      });
    }

    if (this.latestIntel?.inventoryEndpoint && !this.inventoryPollRunning) {
      this.startInventoryPoll(this.latestIntel.inventoryEndpoint);
    }

    this.log("starting loop");
    await this.pollLoop();
  }

  stop(): void {
    this.inventoryPollRunning = false;
    this.running = false;
    if (
      this.state !== WORKER_STATES.CHECKOUT &&
      this.state !== WORKER_STATES.DONE
    ) {
      this.setState(WORKER_STATES.IDLE);
    }
    this.setFocus("stopped");
    this.log("stopped");
  }

  async handleCommand(msg: ControllerMessage): Promise<void> {
    if (!this.page) return;
    try {
      switch (msg.command) {
        case WORKER_COMMANDS.START:
          if (!this.running) this.start().catch(() => {});
          break;
        case WORKER_COMMANDS.STOP:
          this.stop();
          break;
        case WORKER_COMMANDS.REFRESH:
          await this.refresh();
          break;
        case WORKER_COMMANDS.CLICK_PRIMARY:
          await this.clickPrimary();
          break;
        case WORKER_COMMANDS.NAVIGATE:
          if (msg.url)
            await this.page.goto(msg.url, { waitUntil: "domcontentloaded" });
          break;
        case WORKER_COMMANDS.FOCUS: {
          const btn = await findPrimaryButton(this.page, this.latestIntel);
          if (btn) {
            const info = await btn.evaluate((el: Element) => ({
              tag: el.tagName.toLowerCase(),
              text: el.textContent?.trim().slice(0, 60) ?? "",
            })).catch(() => null);
            await btn.evaluate((el: Element) => {
              (el as HTMLElement).style.outline = "3px solid #00ff88";
              (el as HTMLElement).style.boxShadow = "0 0 14px rgba(0,255,136,0.6)";
            }).catch(() => {});
            if (info) {
              this.setFocus(`<${info.tag}> "${info.text}"`);
              this.log(`focus: <${info.tag}> "${info.text}"`);
            }
          } else {
            this.setFocus("focus: no element found");
            this.log("focus: no primary button found on page");
          }
          break;
        }
      }
    } catch {}
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    try {
      if (this.context) {
        const sessionPath = path.resolve(SESSION_DIR, `worker-${this.id}`);
        await this.context.storageState({
          path: path.join(sessionPath, "state.json"),
        });
      }
    } catch {}
    this.inventoryPollRunning = false;
    try {
      await this.browser?.close();
    } catch {}
    this.browser = null;
    this.context = null;
    this.page = null;
    this.unsubscribeCmd?.();
    this.unsubscribeIntel?.();
  }

  private async onPageChange(): Promise<void> {
    if (!this.page || !this.running) return;
    const prevState = this.state;
    const newState = await detectState(this.page, this.latestIntel).catch(() => this.state);
    if (newState !== prevState) this.setState(newState);

    if (newState === WORKER_STATES.ACTIVE_SALE) {
      if (newState !== prevState)
        await this.page.bringToFront().catch(() => {});
      await this.clickPrimary();
    } else if (
      newState === WORKER_STATES.CHECKOUT ||
      newState === WORKER_STATES.DONE
    ) {
      await this.page.bringToFront().catch(() => {});
      this.log("CHECKOUT BABY CHECKOUT BABY CHECKOUT BABY");
      this.stop();
    } else if (newState === WORKER_STATES.SOLD_OUT) {
      const { config } = getCtx();
      if (config.stopOnSoldOut) this.stop();
    }
  }

  private async pollLoop(): Promise<void> {
    const { config } = getCtx();
    const staggerMs = Math.min(
      Math.floor(
        config.refreshIntervalMs / Math.max(config.workerCount || 50, 1),
      ),
      20,
    );
    await this.sleep(this.id * staggerMs);

    while (this.running) {
      if (!this.page) break;

      try {
        this.setFocus("detecting state");
        const prevState = this.state;
        const newState = await detectState(this.page, this.latestIntel);
        if (newState !== prevState) this.setState(newState);

        if (
          newState === WORKER_STATES.WAITING_ROOM ||
          newState === WORKER_STATES.IN_QUEUE
        ) {
          if (config.stopOnQueueDetected) {
            this.log("QUEUED");
            await this.waitForQueueExit();
            continue;
          }
        }

        if (newState === WORKER_STATES.ACTIVE_SALE) {
          if (newState !== prevState)
            await this.page.bringToFront().catch(() => {});
          await this.clickPrimary();
          await this.sleep(300);
          continue;
        }

        if (
          newState === WORKER_STATES.CHECKOUT ||
          newState === WORKER_STATES.DONE
        ) {
          await this.page.bringToFront().catch(() => {});
          this.log("WERE IN FUCKERS, stop the loop");
          this.stop();
          break;
        }

        if (newState === WORKER_STATES.SOLD_OUT && config.stopOnSoldOut) {
          this.stop();
          break;
        }

        this.setFocus("sleeping");
        const refreshMs = this.latestIntel?.antiBot.recommendedRefreshMs ?? config.refreshIntervalMs;
        await this.sleep(refreshMs);

        if (
          newState !== WORKER_STATES.WAITING_ROOM &&
          newState !== WORKER_STATES.IN_QUEUE
        ) {
          await this.refresh();
        }
      } catch (err) {
        const msg = String(err);
        const isTransient =
          msg.includes("Execution context was destroyed") ||
          msg.includes("Target closed") ||
          msg.includes("frame was detached");

        if (isTransient) {
          this.consecutiveErrors = 0;
          await this.sleep(200);
          continue;
        }

        this.consecutiveErrors++;
        this.log(`FUCK #${this.consecutiveErrors}: ${err}`);
        if (this.consecutiveErrors >= 3) {
          this.consecutiveErrors = 0;
          this.running = false;
          this.setState(WORKER_STATES.ERROR);
          this.setFocus("crashed — triggering recovery");
          this._closed = true;
          this.browser?.close().catch(() => {});
          this.onCrash();
          break;
        }
        await this.sleep(3_000);
      }
    }
  }

  private async waitForQueueExit(): Promise<void> {
    while (this.running) {
      this.setFocus("waiting in queue");
      await this.sleep(1_500);
      if (!this.page) break;
      const state = await detectState(this.page, this.latestIntel).catch(() => this.state);
      if (
        state !== WORKER_STATES.WAITING_ROOM &&
        state !== WORKER_STATES.IN_QUEUE
      ) {
        this.setState(state);
        return;
      }
      if (state !== this.state) this.setState(state);
    }
  }

  private async refresh(): Promise<void> {
    if (!this.page) return;
    this.setState(WORKER_STATES.RELOADING);
    this.setFocus("refreshing page");
    await this.sleep(this.jitter(RELOAD_JITTER_MIN_MS, RELOAD_JITTER_MAX_MS));
    try {
      await this.page.reload({ waitUntil: "commit", timeout: 8_000 });
    } catch {}
  }

  private async clickPrimary(): Promise<void> {
    if (!this.page) return;
    this.setFocus("finding buy button");
    const btn = await findPrimaryButton(this.page, this.latestIntel);
    if (!btn) {
      this.log("no primary button found");
      return;
    }
    this.setFocus("clicking buy button");
    await this.sleep(this.jitter(CLICK_JITTER_MIN_MS, CLICK_JITTER_MAX_MS));
    try {
      await btn.click({ timeout: 2_000 });
      this.log("CLICK");
    } catch (err) {
      this.log(`i cant fucking click: ${err}`);
    }
  }

  private startInventoryPoll(endpoint: string): void {
    this.inventoryPollRunning = true;
    const poll = async () => {
      while (this.inventoryPollRunning && this.running) {
        try {
          const res = await fetch(endpoint);
          const text = await res.text();
          const available = /"available"\s*:\s*true|"inStock"\s*:\s*true|"count"\s*:\s*[1-9]/i.test(text);
          if (available) {
            this.log("inventory endpoint signals available — firing clickPrimary");
            await this.clickPrimary();
          }
        } catch {}
        await this.sleep(200);
      }
    };
    poll().catch(() => {});
  }

  private setFocus(text: string): void {
    this.currentFocus = text;
    this.emitState();
  }

  private setState(state: WorkerState): void {
    this.state = state;
    this.emitState();
  }

  private emitState(): void {
    try {
      const { bus } = getCtx();
      bus.emit("worker:state", {
        id: this.id,
        state: this.state,
        url: this.page?.url() ?? "",
        targetUrl: this.targetUrl,
        focus: this.currentFocus,
        proxy: this.credential.proxy ?? null,
        lastNet: this.lastNet,
      });
    } catch {}
  }

  private log(message: string): void {
    try {
      const { bus } = getCtx();
      bus.emit("worker:log", { id: this.id, message });
    } catch {}
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private jitter(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min)) + min;
  }

  private urlShort(url: string): string {
    return url.length > 40 ? "…" + url.slice(-40) : url;
  }

  private loadSession(sessionPath: string): string | undefined {
    const file = path.join(sessionPath, "state.json");
    return fs.existsSync(file) ? file : undefined;
  }
}

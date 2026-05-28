import type { Page, Locator } from "playwright";
import {
  QUEUE_PATTERNS,
  QUEUE_TEXT_PATTERNS,
  SOLD_OUT_PATTERNS,
  CHECKOUT_URL_PATTERNS,
  CHECKOUT_TEXT_PATTERNS,
  BUY_BUTTON_TEXT,
  COMMON_PRIMARY_SELECTORS,
  BUY_DATA_ATTRS,
  WORKER_STATES,
} from "../constants";
import type { WorkerState, ProbeIntel } from "./types";

export async function detectState(page: Page, intel?: ProbeIntel | null): Promise<WorkerState> {
  const url = page.url();

  const queueUrlPatterns = [
    ...QUEUE_PATTERNS,
    ...(intel?.queueSystem.positionEndpoint ? [new URL(intel.queueSystem.positionEndpoint).hostname] : []),
    ...(intel?.queueSystem.type !== "none" && intel?.queueSystem.type ? [intel.queueSystem.type] : []),
  ];

  if (queueUrlPatterns.some((p) => url.includes(p))) return WORKER_STATES.WAITING_ROOM;

  const checkoutPatterns = intel?.checkoutFlow?.endpoint
    ? new RegExp(CHECKOUT_URL_PATTERNS.source + "|" + escapeRegex(intel.checkoutFlow.endpoint), "i")
    : CHECKOUT_URL_PATTERNS;
  if (checkoutPatterns.test(url)) return WORKER_STATES.CHECKOUT;

  const btn = await findPrimaryButton(page, intel);
  if (btn) {
    const enabled = await btn.isEnabled().catch(() => false);
    if (enabled) return WORKER_STATES.ACTIVE_SALE;
  }

  let bodyText = "";
  try {
    bodyText = await page.innerText("body", { timeout: 2_000 });
  } catch {
    return WORKER_STATES.NAVIGATING;
  }

  if (QUEUE_TEXT_PATTERNS.test(bodyText)) return WORKER_STATES.IN_QUEUE;
  if (SOLD_OUT_PATTERNS.test(bodyText)) return WORKER_STATES.SOLD_OUT;
  if (CHECKOUT_TEXT_PATTERNS.test(bodyText)) return WORKER_STATES.CHECKOUT;

  return WORKER_STATES.PRE_QUEUE;
}

export async function findPrimaryButton(page: Page, intel?: ProbeIntel | null): Promise<Locator | null> {
  const intelStrategies: (() => Locator)[] = (intel?.buttonHints ?? [])
    .slice(0, 2)
    .map((hint) => () => page.locator(hint.selector).first());

  const strategies: (() => Locator)[] = [
    ...intelStrategies,
    () => page.getByRole("button", { name: BUY_BUTTON_TEXT }),
    () => page.locator(COMMON_PRIMARY_SELECTORS.join(", ")).first(),
    () => page.locator(BUY_DATA_ATTRS.join(", ")).first(),
    () => page.locator("form button[type='submit']").first(),
  ];

  const results = await Promise.all(
    strategies.map(async (s) => {
      const loc = s();
      const count = await loc.count().catch(() => 0);
      return count > 0 ? loc : null;
    })
  );

  const found = results.find((r) => r !== null) ?? null;
  if (found) return found;

  return findMostProminentButton(page);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findMostProminentButton(page: Page): Promise<Locator | null> {
  const selector = await getSelectorForButton(page);
  if (!selector) return null;
  const loc = page.locator(selector).first();
  const count = await loc.count().catch(() => 0);
  return count > 0 ? loc : null;
}

async function getSelectorForButton(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    function cssPath(el: Element): string {
      if (el.id) return `#${CSS.escape(el.id)}`;
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

    const tags = "button, input[type='button'], input[type='submit'], a[role='button']";
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(tags));
    let bestArea = 0;
    let bestEl: HTMLElement | null = null;

    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        bestEl = el;
      }
    }

    return bestEl ? cssPath(bestEl) : null;
  });
}

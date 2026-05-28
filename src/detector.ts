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
import type { WorkerState } from "./types";

export async function detectState(page: Page): Promise<WorkerState> {
  const url = page.url();

  if (QUEUE_PATTERNS.some((p) => url.includes(p))) return WORKER_STATES.WAITING_ROOM;
  if (CHECKOUT_URL_PATTERNS.test(url)) return WORKER_STATES.CHECKOUT;

  // Check for buy button before doing the expensive full-body text scan
  const btn = await findPrimaryButton(page);
  if (btn) {
    const enabled = await btn.isEnabled().catch(() => false);
    if (enabled) return WORKER_STATES.ACTIVE_SALE;
  }

  // Only do the expensive body scan when we need to distinguish queue/soldout/pre-queue
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

export async function findPrimaryButton(page: Page): Promise<Locator | null> {
  // Race all strategies in parallel — return whichever finds a match first
  const strategies: (() => Locator)[] = [
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

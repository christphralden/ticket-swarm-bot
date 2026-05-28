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
} from "../constants";
import type { WorkerCredential, WorkerState, ControllerMessage } from "./types";

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

    const { bus } = getCtx();
    this.unsubscribeCmd = bus.on(`cmd:${this.id}`, (msg) =>
      this.handleCommand(msg),
    );

    this.setState(WORKER_STATES.IDLE);
    this.log("launch");
  }

  async preNavigate(): Promise<void> {
    if (!this.page) return;
    this.setState(WORKER_STATES.NAVIGATING);
    try {
      await this.page.goto(this.targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      this.setState(WORKER_STATES.PRE_QUEUE);
      this.log(`pre navigating to ${this.targetUrl}`);
    } catch (err) {
      this.log(`pre navigate failed, fuckkkkkkk: ${err}`);
      this.setState(WORKER_STATES.ERROR);
    }
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

    this.log("starting loop");
    await this.pollLoop();
  }

  stop(): void {
    this.running = false;
    if (
      this.state !== WORKER_STATES.CHECKOUT &&
      this.state !== WORKER_STATES.DONE
    ) {
      this.setState(WORKER_STATES.IDLE);
    }
    this.log("stopped");
  }

  async handleCommand(msg: ControllerMessage): Promise<void> {
    if (!this.page) return;

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
      case WORKER_COMMANDS.FOCUS:
        await this.page.bringToFront();
        break;
    }
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
    try {
      await this.browser?.close();
    } catch {}
    this.browser = null;
    this.context = null;
    this.page = null;
    this.unsubscribeCmd?.();
  }

  private async onPageChange(): Promise<void> {
    if (!this.page || !this.running) return;
    const prevState = this.state;
    const newState = await detectState(this.page).catch(() => this.state);
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
        const prevState = this.state;
        const newState = await detectState(this.page);
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

        await this.sleep(config.refreshIntervalMs);

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
        if (this.consecutiveErrors >= 5) {
          this.setState(WORKER_STATES.ERROR);
          this.consecutiveErrors = 0;
        }
        await this.sleep(3_000);
      }
    }
  }

  private async waitForQueueExit(): Promise<void> {
    while (this.running) {
      await this.sleep(1_500);
      if (!this.page) break;
      const state = await detectState(this.page).catch(() => this.state);
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
    try {
      await this.page.reload({ waitUntil: "commit", timeout: 8_000 });
    } catch {}
  }

  private async clickPrimary(): Promise<void> {
    if (!this.page) return;
    const btn = await findPrimaryButton(this.page);
    if (!btn) {
      this.log("no primary button found");
      return;
    }
    try {
      await btn.click({ timeout: 2_000 });
      this.log("CLICK");
    } catch (err) {
      this.log(`i cant fucking click: ${err}`);
    }
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
        lastAction: `set to ${this.state}`,
        proxy: this.credential.proxy ?? null,
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

  private loadSession(sessionPath: string): string | undefined {
    const file = path.join(sessionPath, "state.json");
    return fs.existsSync(file) ? file : undefined;
  }
}

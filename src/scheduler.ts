import { PRE_NAVIGATE_MS, PRECISION_POLL_MS } from "../constants";
import { getCtx } from "./context";

export class Scheduler {
  private preNavigated = false;
  private fired = false;
  private interval: ReturnType<typeof setInterval>;

  constructor(
    private getTargetTime: () => Date,
    private onPreNavigate: () => void,
    private onFire: () => void,
  ) {
    this.logInit();
    this.interval = setInterval(() => this.tick(), PRECISION_POLL_MS);
  }

  reset(): void {
    this.preNavigated = false;
    this.fired = false;
    this.logInit();
  }

  stop(): void {
    clearInterval(this.interval);
  }

  private tick(): void {
    const target = this.getTargetTime();
    const now = Date.now();

    if (!this.preNavigated && now >= target.getTime() - PRE_NAVIGATE_MS) {
      getCtx().bus.emit("system:log", { scope: "scheduler", message: "T-30s" });
      this.onPreNavigate();
      this.preNavigated = true;
    }

    if (!this.fired && now >= target.getTime()) {
      getCtx().bus.emit("system:log", { scope: "scheduler", message: "make it rain" });
      this.onFire();
      this.fired = true;
    }
  }

  private logInit(): void {
    const { bus } = getCtx();
    const target = this.getTargetTime();
    bus.emit("system:log", {
      scope: "scheduler",
      message: `sale opens at ${target.toISOString()}`,
    });
    bus.emit("system:log", {
      scope: "scheduler",
      message: `pre-navigate fires at ${new Date(target.getTime() - PRE_NAVIGATE_MS).toISOString()}`,
    });
  }
}

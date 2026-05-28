import { PRE_NAVIGATE_MS, PRECISION_POLL_MS } from "../constants";
import { getCtx } from "./context";

export async function waitUntil(
  getTargetTime: () => Date,
  onPreNavigate: () => void,
  onFire: () => void,
): Promise<void> {
  let preNavigated = false;

  const { bus } = getCtx();
  bus.emit("system:log", {
    scope: "scheduler",
    message: `sale opens at ${getTargetTime().toISOString()}`,
  });
  bus.emit("system:log", {
    scope: "scheduler",
    message: `pre-navigate fires at ${new Date(getTargetTime().getTime() - PRE_NAVIGATE_MS).toISOString()}`,
  });

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      const target = getTargetTime();
      const now = Date.now();

      if (!preNavigated && now >= target.getTime() - PRE_NAVIGATE_MS) {
        getCtx().bus.emit("system:log", {
          scope: "scheduler",
          message: "T-30s",
        });
        onPreNavigate();
        preNavigated = true;
      }

      if (now >= target.getTime()) {
        clearInterval(interval);
        resolve();
      }
    }, PRECISION_POLL_MS);
  });

  getCtx().bus.emit("system:log", {
    scope: "scheduler",
    message: "make it rain",
  });
  onFire();
}

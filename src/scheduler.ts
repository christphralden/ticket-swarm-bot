import { PRE_NAVIGATE_MS, PRECISION_POLL_MS } from "../constants";

export async function waitUntil(
  getTargetTime: () => Date,
  onPreNavigate: () => void,
  onFire: () => void
): Promise<void> {
  let preNavigated = false;

  console.log(`[scheduler] sale opens at ${getTargetTime().toISOString()}`);
  console.log(`[scheduler] pre-navigate at ${new Date(getTargetTime().getTime() - PRE_NAVIGATE_MS).toISOString()}`);

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      const target = getTargetTime();
      const now = Date.now();

      if (!preNavigated && now >= target.getTime() - PRE_NAVIGATE_MS) {
        console.log("[scheduler] T-30s: pre-navigating all workers");
        onPreNavigate();
        preNavigated = true;
      }

      if (now >= target.getTime()) {
        clearInterval(interval);
        resolve();
      }
    }, PRECISION_POLL_MS);
  });

  console.log("[scheduler] FIRE — sale is open");
  onFire();
}

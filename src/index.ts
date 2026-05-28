import fs from "fs";
import path from "path";
import { TypedEventBus } from "./event-bus";
import { runWithCtx, type AppContext } from "./context";
import { WorkerPool } from "./worker-pool";
import { Controller } from "./controller";
import { startDashboard } from "./dashboard";
import { Scheduler } from "./scheduler";
import { ProbeWorker } from "./probe-worker";
import { ProxyRotator } from "./proxy-rotator";
import { WORKER_COMMANDS, PROBE_RUN_OFFSET_MS } from "../constants";
import type { Config } from "./types";

async function main() {
  const configPath = path.resolve("config.json");
  if (!fs.existsSync(configPath)) {
    console.error("config.json not found");
    process.exit(1);
  }

  const config: Config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  if (isNaN(new Date(config.saleOpenTime).getTime())) {
    console.error("Invalid saleOpenTime in config.json");
    process.exit(1);
  }

  console.log(`[main] target: ${config.targetUrl}`);
  console.log(`[main] sale opens: ${new Date(config.saleOpenTime).toLocaleString()}`);
  console.log(`[main] dashboard: http://localhost:3000`);

  const bus = new TypedEventBus();
  const ctx: AppContext = { bus, config };

  await runWithCtx(ctx, async () => {
    const pool = new WorkerPool();
    const controller = new Controller();

    const scheduler = new Scheduler(
      () => new Date(config.saleOpenTime),
      () => {
        pool.setPhase("navigate");
        for (const w of pool.getAll()) {
          if (w.isLaunched()) w.preNavigate();
        }
      },
      () => {
        pool.setPhase("fire");
        for (const w of pool.getAll()) {
          if (w.isLaunched()) w.start().catch(() => {});
        }
      },
    );

    const probeRotator = new ProxyRotator(config.probeProxies ?? []);
    const probeWorker = new ProbeWorker(probeRotator);

    {

      const persistedIntel = probeWorker.loadPersistedIntel();
      if (persistedIntel) {
        bus.emit("probe:intel", persistedIntel);
        bus.emit("system:log", { scope: "probe", message: `loaded persisted intel from disk (ts: ${new Date(persistedIntel.ts).toLocaleString()})` });
      }

      const saleTime = new Date(config.saleOpenTime).getTime();
      const autoProbeAt = saleTime - PROBE_RUN_OFFSET_MS;
      const delayMs = autoProbeAt - Date.now();

      if (delayMs > 0) {
        setTimeout(() => {
          probeWorker!.runProbe().catch((err) => {
            bus.emit("system:log", { scope: "probe", message: `auto probe failed: ${err}` });
          });
        }, delayMs);
        bus.emit("system:log", { scope: "probe", message: `auto probe scheduled for T-15min (${new Date(autoProbeAt).toLocaleString()})` });
      } else {
        probeWorker.runProbe().catch((err) => {
          bus.emit("system:log", { scope: "probe", message: `initial probe failed: ${err}` });
        });
      }
    }

    startDashboard(controller, pool, scheduler, probeWorker);

    controller.setOnCheckout((id) => {
      bus.emit("system:log", { scope: "main", message: `worker ${id} is in CHECKOUT — take over manually in the browser` });
    });

    process.on("SIGINT", async () => {
      console.log("\n[main] shutting down...");
      scheduler.stop();
      bus.emit("cmd:all", { command: WORKER_COMMANDS.STOP });
      await Promise.all(pool.getAll().map((w) => w.close()));
      controller.close();
      process.exit(0);
    });
  });
}

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

main().catch((err) => {
  console.error("[main] fatal:", err);
  process.exit(1);
});

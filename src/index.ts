import fs from "fs";
import path from "path";
import { TypedEventBus } from "./event-bus";
import { runWithCtx, type AppContext } from "./context";
import { WorkerPool } from "./worker-pool";
import { Controller } from "./controller";
import { startDashboard } from "./dashboard";
import { waitUntil } from "./scheduler";
import { WORKER_COMMANDS } from "../constants";
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
    startDashboard(controller, pool);

    controller.setOnCheckout((id) => {
      bus.emit("system:log", { scope: "main", message: `worker ${id} is in CHECKOUT — take over manually in the browser` });
    });

    process.on("SIGINT", async () => {
      console.log("\n[main] shutting down...");
      bus.emit("cmd:all", { command: WORKER_COMMANDS.STOP });
      await Promise.all(pool.getAll().map((w) => w.close()));
      controller.close();
      process.exit(0);
    });

    await waitUntil(
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
      }
    );
  });
}

main().catch((err) => {
  console.error("[main] fatal:", err);
  process.exit(1);
});

import { Worker } from "./worker";
import { getCtx } from "./context";
import { WORKER_STATES, PRE_NAVIGATE_MS } from "../constants";
import type { SpawnOptions } from "./types";

type SalePhase = "pre" | "navigate" | "fire";

export class WorkerPool {
  private workers = new Map<number, { worker: Worker; retries: number }>();
  private nextId = 0;
  private phase: SalePhase = "pre";

  constructor() {
    const { bus } = getCtx();
    bus.on("cmd:all", (msg) => {
      for (const { worker } of this.workers.values()) {
        worker.handleCommand(msg).catch(() => {});
      }
    });
  }

  setPhase(phase: SalePhase): void {
    this.phase = phase;
  }

  async spawn(
    opts: SpawnOptions,
  ): Promise<{ spawned: number; errors: string[] }> {
    const errors: string[] = [];
    let spawned = 0;

    const ids =
      opts.workerId !== undefined
        ? [opts.workerId]
        : Array.from({ length: opts.count ?? 1 }, () => this.nextId++);

    for (const id of ids) {
      try {
        await this.spawnOne(id, opts.targetUrl);
        spawned++;
      } catch (err) {
        errors.push(String(err));
      }
    }

    return { spawned, errors };
  }

  async destroy(id: number): Promise<{ ok: boolean; error?: string }> {
    const entry = this.workers.get(id);
    if (!entry) return { ok: false, error: `Worker ${id} not found` };
    entry.worker.stop();
    await entry.worker.close();
    this.workers.delete(id);
    const { bus } = getCtx();
    bus.emit("worker:removed", { id });
    bus.emit("system:log", {
      scope: "pool",
      message: `worker ${id} has been killed`,
    });
    return { ok: true };
  }

  async spawnAll(): Promise<{ spawned: number; errors: string[] }> {
    const { config, bus } = getCtx();
    const errors: string[] = [];
    let spawned = 0;
    bus.emit("system:log", {
      scope: "pool",
      message: `spawning all ${config.workerCount} workers`,
    });
    for (let id = 0; id < config.workerCount; id++) {
      if (this.workers.has(id)) continue;
      try {
        await this.spawnOne(id, undefined);
        spawned++;
      } catch (err) {
        errors.push(String(err));
      }
    }
    if (this.nextId < config.workerCount) this.nextId = config.workerCount;
    bus.emit("system:log", {
      scope: "pool",
      message: `${spawned} spawned, ${errors.length} failed`,
    });
    return { spawned, errors };
  }

  getAll(): Worker[] {
    return [...this.workers.values()].map((e) => e.worker);
  }

  private async spawnOne(id: number, targetUrl?: string): Promise<void> {
    const { config } = getCtx();
    const credential = config.credentials[id % config.credentials.length];
    const ua = config.userAgents?.[id % (config.userAgents?.length ?? 1)] ?? "";
    const url = targetUrl ?? config.targetUrl;

    const worker = new Worker(id, credential, url, ua, () => this.recover(id));
    this.workers.set(id, { worker, retries: 0 });

    await worker.launch();

    const now = Date.now();
    const saleTime = new Date(config.saleOpenTime).getTime();
    if (now >= saleTime - PRE_NAVIGATE_MS || this.phase !== "pre") {
      await worker.preNavigate();
    }
    if (now >= saleTime || this.phase === "fire") {
      worker.start().catch(() => {});
    }
  }

  private async recover(id: number): Promise<void> {
    const { bus } = getCtx();
    const entry = this.workers.get(id);
    if (!entry || entry.retries >= 3) {
      bus.emit("system:log", {
        scope: "pool",
        message: `worker ${id} gave up`,
      });
      return;
    }
    entry.retries++;
    bus.emit("system:log", {
      scope: "pool",
      message: `trying to resurrect worker ${id} (attempt ${entry.retries})`,
    });
    await new Promise((r) => setTimeout(r, 1_000));
    try {
      await this.spawnOne(id);
    } catch (err) {
      bus.emit("system:log", {
        scope: "pool",
        message: `failed to recover worker ${id}: ${err}`,
      });
    }
  }
}

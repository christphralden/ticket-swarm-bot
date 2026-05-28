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

  async spawn(opts: SpawnOptions): Promise<{ spawned: number; errors: string[] }> {
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
    console.log(`[pool] worker ${id} destroyed`);
    return { ok: true };
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
    const entry = this.workers.get(id);
    if (!entry || entry.retries >= 3) {
      console.log(`[pool] worker ${id} exceeded max retries — giving up`);
      return;
    }
    entry.retries++;
    console.log(`[pool] recovering worker ${id} (attempt ${entry.retries})`);
    await new Promise((r) => setTimeout(r, 1_000));
    try {
      await this.spawnOne(id);
    } catch (err) {
      console.log(`[pool] recovery failed for worker ${id}: ${err}`);
    }
  }
}

import { WebSocketServer, WebSocket } from "ws";
import { getCtx } from "./context";
import { buildWsUpdate } from "./renderer";
import { WS_PORT, WORKER_COMMANDS, WORKER_STATES } from "../constants";
import type { WorkerStatus, ControllerMessage, WorkerState } from "./types";

export class Controller {
  private wss: WebSocketServer;
  private statuses = new Map<number, WorkerStatus>();
  private onCheckoutCb: ((workerId: number) => void) | null = null;

  constructor() {
    this.wss = new WebSocketServer({ port: WS_PORT });
    this.wss.on("connection", (socket) => this.onClientConnect(socket));
    console.log(`[controller] dashboard WS on ws://localhost:${WS_PORT}`);

    const { bus } = getCtx();
    bus.on("worker:state", (status) => this.onWorkerState(status));
    bus.on("worker:removed", ({ id }) => {
      this.statuses.delete(id);
      this.pushUpdate();
    });
  }

  getStatuses(): WorkerStatus[] {
    return [...this.statuses.values()].sort((a, b) => a.id - b.id);
  }

  setOnCheckout(cb: (workerId: number) => void): void {
    this.onCheckoutCb = cb;
  }

  close(): void {
    this.wss.close();
  }

  private onWorkerState(status: WorkerStatus): void {
    this.statuses.set(status.id, { ...this.statuses.get(status.id), ...status });
    this.pushUpdate();

    if (status.state === WORKER_STATES.CHECKOUT) {
      console.log(`\n[controller] Worker ${status.id} reached CHECKOUT!\n`);
      process.stdout.write("\x07");
      this.onCheckoutCb?.(status.id);
    }

    if (this.allInState(WORKER_STATES.SOLD_OUT)) {
      console.log("[controller] all workers hit SOLD_OUT — stopping all");
      const { bus } = getCtx();
      bus.emit("cmd:all", { command: WORKER_COMMANDS.STOP });
    }
  }

  private onClientConnect(socket: WebSocket): void {
    socket.send(buildWsUpdate(this.getStatuses()));

    socket.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ControllerMessage;
        if (!("command" in msg)) return;
        const { bus } = getCtx();
        if (msg.workerId !== undefined) {
          bus.emit(`cmd:${msg.workerId}`, msg);
        } else {
          bus.emit("cmd:all", msg);
        }
      } catch {}
    });
  }

  private pushUpdate(): void {
    const html = buildWsUpdate(this.getStatuses());
    this.wss.clients.forEach((c) => {
      if (c.readyState === WebSocket.OPEN) c.send(html);
    });
  }

  private allInState(state: WorkerState): boolean {
    return (
      this.statuses.size > 0 &&
      [...this.statuses.values()].every((s) => s.state === state)
    );
  }
}

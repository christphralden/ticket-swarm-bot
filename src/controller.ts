import { WebSocketServer, WebSocket } from "ws";
import { getCtx } from "./context";
import {
  WS_PORT,
  WORKER_COMMANDS,
  WORKER_STATES,
  LOG_BUFFER_SIZE,
} from "../constants";
import type {
  WorkerStatus,
  ControllerMessage,
  WorkerState,
  LogEntry,
} from "./types";

export class Controller {
  private wss: WebSocketServer;
  private statuses = new Map<number, WorkerStatus>();
  private logs: LogEntry[] = [];
  private onCheckoutCb: ((workerId: number) => void) | null = null;

  constructor() {
    this.wss = new WebSocketServer({ port: WS_PORT });
    this.wss.on("connection", (socket) => this.onClientConnect(socket));
    console.log(`[controller] dashboard WS on ws://localhost:${WS_PORT}`);

    const { bus } = getCtx();
    bus.on("worker:state", (status) => this.onWorkerState(status));
    bus.on("worker:removed", ({ id }) => {
      this.statuses.delete(id);
      this.broadcast({ type: "removed", id });
    });
    bus.on("worker:log", ({ id, message }) => {
      this.log({ scope: `worker-${id}`, message });
    });
    bus.on("system:log", ({ scope, message }) => {
      this.log({ scope, message });
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

  private log(entry: Omit<LogEntry, "ts">): void {
    const full: LogEntry = { ts: Date.now(), ...entry };
    this.logs.push(full);
    if (this.logs.length > LOG_BUFFER_SIZE) this.logs.shift();
    this.broadcast({ type: "log", entry: full });
  }

  private onWorkerState(status: WorkerStatus): void {
    this.statuses.set(status.id, {
      ...this.statuses.get(status.id),
      ...status,
    });
    this.broadcast({ type: "worker", status: this.statuses.get(status.id)! });

    if (status.state === WORKER_STATES.CHECKOUT) {
      process.stdout.write("\x07");
      this.log({
        scope: "controller",
        message: `CHEKCOUT BABY WORKER ${status.id} DA GOAT. GET UR WALLET OUT`,
      });
      this.onCheckoutCb?.(status.id);
    }

    if (this.allInState(WORKER_STATES.SOLD_OUT)) {
      this.log({
        scope: "controller",
        message: "SOLD OUT FUCK THIS",
      });
      const { bus } = getCtx();
      bus.emit("cmd:all", { command: WORKER_COMMANDS.STOP });
    }
  }

  private onClientConnect(socket: WebSocket): void {
    const snapshot = JSON.stringify({
      type: "snapshot",
      workers: this.getStatuses(),
      logs: this.logs.slice(-200),
    });
    socket.send(snapshot);

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

  private broadcast(payload: object): void {
    const msg = JSON.stringify(payload);
    this.wss.clients.forEach((c) => {
      if (c.readyState === WebSocket.OPEN) c.send(msg);
    });
  }

  private allInState(state: WorkerState): boolean {
    return (
      this.statuses.size > 0 &&
      [...this.statuses.values()].every((s) => s.state === state)
    );
  }
}

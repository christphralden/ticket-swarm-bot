import { EventEmitter } from "events";
import type { WorkerStatus, ControllerMessage, ProbeIntel } from "./types";

export type BusEvents = {
  "worker:state": WorkerStatus;
  "worker:log": { id: number; message: string };
  "worker:removed": { id: number };
  "system:log": { scope: string; message: string };
  "probe:intel": ProbeIntel;
  "cmd:all": ControllerMessage;
  [k: `cmd:${number}`]: ControllerMessage;
};

export class TypedEventBus {
  private em = new EventEmitter();

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    this.em.emit(event as string, payload);
  }

  on<K extends keyof BusEvents>(
    event: K,
    listener: (payload: BusEvents[K]) => void,
  ): () => void {
    this.em.on(event as string, listener);
    return () => this.em.off(event as string, listener);
  }
}

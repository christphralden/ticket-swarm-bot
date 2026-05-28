import { WORKER_STATES, WORKER_COMMANDS } from "../constants";
import type { TypedEventBus } from "./event-bus";

export type WorkerState = (typeof WORKER_STATES)[keyof typeof WORKER_STATES];
export type WorkerCommand = (typeof WORKER_COMMANDS)[keyof typeof WORKER_COMMANDS];

export interface WorkerCredential {
  email: string;
  password: string;
  proxy?: string | null;
}

export interface Config {
  targetUrl: string;
  saleOpenTime: string;
  credentials: WorkerCredential[];
  workerCount: number;
  refreshIntervalMs: number;
  stopOnQueueDetected: boolean;
  stopOnSoldOut: boolean;
  headless: boolean;
  locale: string;
  timezoneId: string;
  userAgents: string[];
}

export interface WorkerStatus {
  id: number;
  state: WorkerState;
  url: string;
  targetUrl: string;
  focus: string;
  proxy: string | null;
  lastNet: { status: number; url: string } | null;
}

export interface ControllerMessage {
  command: WorkerCommand;
  url?: string;
  workerId?: number;
}

export interface SpawnOptions {
  workerId?: number;
  count?: number;
  targetUrl?: string;
}

export interface LogEntry {
  ts: number;
  scope: string;
  message: string;
}

export interface AppContext {
  bus: TypedEventBus;
  config: Config;
}

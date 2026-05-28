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
  probeProxies?: string[];
  katanaEnabled?: boolean;
}

export interface ProbeButtonHint {
  selector: string;
  confidence: number;
  source: "katana" | "playwright";
  text?: string;
  classes?: string;
  dataAttrs?: string[];
}

export interface CapturedRequest {
  url: string;
  method: string;
  requestBody?: string;
  responseStatus?: number;
  responseShape?: string[];
  source?: "xhr" | "bundle";
}

export interface CheckoutFlow {
  endpoint: string;
  method: string;
  requiredHeaders: string[];
  csrfEndpoint?: string;
  payloadShape: Record<string, string>;
}

export interface QueueSystem {
  type: "queue-it" | "akamai-waiting-room" | "custom" | "none";
  positionEndpoint?: string;
  passedSignal?: string;
}

export interface AntiBotStack {
  vendor: "akamai" | "cloudflare" | "perimeterx" | "datadome" | "none";
  cookieName?: string;
  recommendedRefreshMs: number;
}

export interface ProbeIntel {
  ts: number;
  targetUrl: string;
  isSpa: boolean;
  buttonHints: ProbeButtonHint[];
  checkoutFlow?: CheckoutFlow;
  queueSystem: QueueSystem;
  antiBot: AntiBotStack;
  inventoryEndpoint?: string;
  apiRequests: CapturedRequest[];
  apiEndpoints?: string[];
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

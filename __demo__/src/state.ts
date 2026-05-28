export type SalePhase = "presale" | "queue" | "active" | "soldout";

export interface Session {
  id: string;
  queuePosition: number;
  phase: string;
  arrivedAt: number;
}

export class SaleState {
  phase: SalePhase = "presale";
  private sessions = new Map<string, Session>();
  private nextQueuePos = 1;
  private soldOutAt: number | null = null;
  readonly ticketCount: number;
  private ticketsSold = 0;

  constructor(ticketCount = 10) {
    this.ticketCount = ticketCount;
  }

  openQueue(): void {
    this.phase = "queue";
    console.log("[state] queue is now open");
  }

  openSale(): void {
    this.phase = "active";
    console.log("[state] sale is now ACTIVE");
  }

  sellOut(): void {
    this.phase = "soldout";
    this.soldOutAt = Date.now();
    console.log("[state] SOLD OUT");
  }

  getOrCreateSession(id: string): Session {
    if (!this.sessions.has(id)) {
      this.sessions.set(id, {
        id,
        queuePosition: this.nextQueuePos++,
        phase: this.phase,
        arrivedAt: Date.now(),
      });
    }
    return this.sessions.get(id)!;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  tryBuy(sessionId: string): "ok" | "soldout" | "invalid" {
    if (this.phase !== "active") return "invalid";
    if (this.ticketsSold >= this.ticketCount) {
      this.sellOut();
      return "soldout";
    }
    this.ticketsSold++;
    if (this.ticketsSold >= this.ticketCount) this.sellOut();
    return "ok";
  }

  get remaining(): number {
    return Math.max(0, this.ticketCount - this.ticketsSold);
  }
}

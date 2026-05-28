export class Metrics {
  private requestTimestamps: number[] = [];
  private clickTimestamps: number[] = [];
  private sessionStates = new Map<string, string>();
  private checkoutCount = 0;
  private firstCheckoutMs: number | null = null;
  private saleOpenedAt: number | null = null;
  private startTime = Date.now();
  private peakRps = 0;

  recordRequest(sessionId: string): void {
    this.requestTimestamps.push(Date.now());
    this.prune();
  }

  recordClick(sessionId: string): void {
    this.clickTimestamps.push(Date.now());
  }

  recordSaleOpen(): void {
    this.saleOpenedAt = Date.now();
  }

  recordCheckout(sessionId: string): void {
    this.checkoutCount++;
    if (this.firstCheckoutMs === null) {
      const ref = this.saleOpenedAt ?? this.startTime;
      this.firstCheckoutMs = Date.now() - ref;
    }
  }

  setSessionState(id: string, state: string): void {
    this.sessionStates.set(id, state);
  }

  removeSession(id: string): void {
    this.sessionStates.delete(id);
  }

  snapshot() {
    this.prune();
    const rps = this.requestTimestamps.length;
    if (rps > this.peakRps) this.peakRps = rps;

    const stateCounts: Record<string, number> = {};
    for (const s of this.sessionStates.values()) {
      stateCounts[s] = (stateCounts[s] ?? 0) + 1;
    }

    return {
      rps,
      cps: this.clickTimestamps.filter((t) => Date.now() - t <= 1000).length,
      peakRps: this.peakRps,
      sessions: this.sessionStates.size,
      checkouts: this.checkoutCount,
      firstCheckoutMs: this.firstCheckoutMs,
      stateCounts,
      uptimeS: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  private prune(): void {
    const cutoff = Date.now() - 1000;
    this.requestTimestamps = this.requestTimestamps.filter((t) => t > cutoff);
    this.clickTimestamps = this.clickTimestamps.filter((t) => t > cutoff);
  }
}

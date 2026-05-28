import { PROBE_PROXY_COOLDOWN_MS } from "../constants";

export class ProxyRotator {
  private cursor = 0;
  private badUntil = new Map<string, number>();

  constructor(private proxies: string[]) {}

  next(): string | null {
    if (this.proxies.length === 0) return null;
    const now = Date.now();
    for (let i = 0; i < this.proxies.length; i++) {
      const idx = (this.cursor + i) % this.proxies.length;
      const proxy = this.proxies[idx];
      const bad = this.badUntil.get(proxy) ?? 0;
      if (now >= bad) {
        this.cursor = (idx + 1) % this.proxies.length;
        return proxy;
      }
    }
    return null;
  }

  markBad(proxy: string): void {
    this.badUntil.set(proxy, Date.now() + PROBE_PROXY_COOLDOWN_MS);
  }

  hasProxies(): boolean {
    return this.proxies.length > 0;
  }
}

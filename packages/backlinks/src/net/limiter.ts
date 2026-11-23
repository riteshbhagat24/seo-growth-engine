/** Bounded concurrency + per-host politeness for all outbound HTTP. */

export class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
  get inFlight(): number {
    return this.active;
  }
}

/** Serialises requests per host and enforces a minimum interval (or robots crawl-delay). */
export class HostRateLimiter {
  private next = new Map<string, number>();
  constructor(private defaultIntervalMs: number) {}
  setDefaultInterval(ms: number): void {
    this.defaultIntervalMs = ms;
  }
  async wait(host: string, intervalMs = this.defaultIntervalMs): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.next.get(host) ?? 0);
    this.next.set(host, slot + intervalMs);
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  }
}

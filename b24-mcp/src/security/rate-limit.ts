/**
 * Token-bucket limiter serialising outbound Bitrix24 REST calls.
 * Portal limit is 2 requests/second; we stay at or below it by default.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private queue: Array<() => void> = [];
  private draining = false;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst = Math.max(1, Math.ceil(ratePerSecond)),
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    this.tokens = this.burst;
    this.lastRefill = this.now();
  }

  /** Resolves when a token is available. */
  async acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      void this.drain();
    });
  }

  private refill(): void {
    const t = this.now();
    const elapsed = (t - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSecond);
    this.lastRefill = t;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          this.queue.shift()?.();
          continue;
        }
        const deficit = 1 - this.tokens;
        await this.sleep(Math.ceil((deficit / this.ratePerSecond) * 1000));
      }
    } finally {
      this.draining = false;
    }
  }
}

/**
 * Per-caller call budget for MCP tools, guarding against an agent looping.
 * Sliding window, in-memory.
 */
export class CallBudget {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit = 120,
    private readonly windowMs = 60_000,
  ) {}

  /** Returns false when the caller exceeded its budget. */
  tryConsume(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
}

import { sleep } from './http.js';

/** Token bucket. Capacity tokens refill across one window. */
export class TokenBucket {
  private tokens: number;
  private updatedAt = Date.now();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private capacity: number,
    private windowMs: number,
  ) {
    this.tokens = capacity;
  }

  take(): Promise<void> {
    const run = this.chain.then(() => this.acquire());
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Pull the local budget down to what HubSpot just said is left in the window. */
  syncRemaining(remaining: number): void {
    if (!Number.isFinite(remaining)) return;
    if (remaining < this.tokens) this.tokens = Math.max(0, remaining);
  }

  syncWindow(max: number, intervalMs: number): void {
    if (Number.isFinite(max) && max > 0) this.capacity = max;
    if (Number.isFinite(intervalMs) && intervalMs > 0) this.windowMs = intervalMs;
    if (this.tokens > this.capacity) this.tokens = this.capacity;
  }

  private async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.max(1, Math.ceil((deficit / this.capacity) * this.windowMs));
      await sleep(waitMs);
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.updatedAt;
    if (elapsed <= 0) return;
    const gained = (elapsed / this.windowMs) * this.capacity;
    this.tokens = Math.min(this.capacity, this.tokens + gained);
    this.updatedAt = now;
  }
}

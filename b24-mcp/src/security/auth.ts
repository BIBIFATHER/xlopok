import { timingSafeEqual, createHash } from 'node:crypto';
import { AuthError } from '../domain/errors.js';

/** Constant-time comparison over fixed-width digests (avoids length leaks). */
export function tokensMatch(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Assert a bearer token from an HTTP request matches MCP_AUTH_TOKEN. */
export function assertBearer(authorizationHeader: string | undefined, expected: string): void {
  const raw = authorizationHeader?.startsWith('Bearer ')
    ? authorizationHeader.slice('Bearer '.length).trim()
    : undefined;
  if (!tokensMatch(raw, expected)) {
    // Message intentionally generic — no hint about which part failed.
    throw new AuthError('Unauthorized');
  }
}

/**
 * Replay protection for inbound Bitrix24 webhooks / idempotent write calls.
 * In-memory with a TTL; swap for Redis when running more than one instance.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs = 24 * 60 * 60 * 1000) {}

  /** Returns true if this key is new (and records it); false if already seen. */
  claim(key: string, now = Date.now()): boolean {
    this.sweep(now);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now + this.ttlMs);
    return true;
  }

  has(key: string, now = Date.now()): boolean {
    const exp = this.seen.get(key);
    return exp !== undefined && exp > now;
  }

  private sweep(now: number): void {
    for (const [k, exp] of this.seen) {
      if (exp <= now) this.seen.delete(k);
    }
  }
}

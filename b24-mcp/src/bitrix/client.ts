import { loadEnv, webhookBaseUrl, type Env } from '../config/env.js';
import { DomainError, mapBitrixError } from '../domain/errors.js';
import { RateLimiter } from '../security/rate-limit.js';
import { logger } from '../security/logger.js';
import { registerSecret } from '../security/redaction.js';

/**
 * The single Bitrix24 adapter. Nothing else in the codebase performs HTTP.
 *
 * Hard rules enforced here:
 *  - only methods on READ_METHODS / WRITE_METHODS may be called;
 *  - there is no generic passthrough ("bitrix_call") — the method name is not
 *    accepted from tool input, it is chosen by the calling module;
 *  - deletion methods are absent from both lists by construction;
 *  - retries happen only for read methods, and only on retryable failures;
 *  - the webhook URL never appears in a log line, an error or a return value.
 */

/** Read-only REST methods. Anything not listed cannot be reached. */
export const READ_METHODS = [
  'crm.item.list',
  'crm.item.get',
  'crm.item.fields',
  'crm.company.list',
  'crm.company.get',
  'crm.contact.list',
  'crm.contact.get',
  'crm.contact.company.items.get',
  'crm.deal.list',
  'crm.deal.get',
  'crm.deal.contact.items.get',
  'crm.activity.list',
  'crm.status.list',
  'crm.dealcategory.stage.list',
  'crm.duplicate.findbycomm',
  'crm.timeline.comment.list',
  'tasks.task.list',
  'tasks.task.get',
  'tasks.task.field.list',
  'user.get',
  'profile',
] as const;

/** Mutating methods. Reachable only when WRITE_ENABLED=true. Never includes *.delete. */
export const WRITE_METHODS = [
  'crm.item.add',
  'crm.item.update',
  'crm.company.add',
  'crm.contact.add',
  'crm.deal.add',
  'crm.deal.update',
  'crm.activity.todo.add',
  'crm.timeline.comment.add',
  'tasks.task.add',
] as const;

export type ReadMethod = (typeof READ_METHODS)[number];
export type WriteMethod = (typeof WRITE_METHODS)[number];
export type AllowedMethod = ReadMethod | WriteMethod;

const READ_SET: ReadonlySet<string> = new Set(READ_METHODS);
const WRITE_SET: ReadonlySet<string> = new Set(WRITE_METHODS);

export function isReadMethod(method: string): method is ReadMethod {
  return READ_SET.has(method);
}

export function isWriteMethod(method: string): method is WriteMethod {
  return WRITE_SET.has(method);
}

export interface BitrixListResponse<T> {
  result: T[];
  total?: number;
  next?: number;
}

/**
 * Which REST dialect to speak.
 *  - 'v1' — classic `<webhook>/<method>.json`, object filters, `start` paging;
 *  - 'v3' — `<portal>/rest/api/<user>/<token>/<method>`, array filters,
 *           `pagination` object, rows under `result.items`.
 * Only the tasks module currently has a v3 variant.
 */
export type BitrixApiVersion = 'v1' | 'v3';

export interface CallOptions {
  api?: BitrixApiVersion;
}

export interface BitrixClient {
  call<T = unknown>(
    method: AllowedMethod,
    params?: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<T>;
  /** Convenience wrapper preserving `total` / `next` from list endpoints. */
  callList<T = unknown>(
    method: ReadMethod,
    params?: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<BitrixListResponse<T>>;
  /** REST methods invoked so far — used to populate the audit log. */
  drainCallLog(): string[];
}

/** Methods reachable over the v3 endpoint. Strict subset of the read list. */
export const V3_METHODS = [
  'tasks.task.list',
  'tasks.task.get',
  'tasks.task.field.list',
] as const;

const V3_SET: ReadonlySet<string> = new Set(V3_METHODS);

export function isV3Method(method: string): boolean {
  return V3_SET.has(method);
}

interface RawBitrixEnvelope {
  result?: unknown;
  total?: number;
  next?: number;
  /** v1 returns a string code; v3 returns an object with `code`/`message`. */
  error?: string | { code?: string; message?: string };
  error_description?: string;
}

/** Normalise the two error shapes to a single code string. */
function errorCodeOf(error: RawBitrixEnvelope['error']): string | null {
  if (!error) return null;
  if (typeof error === 'string') return error;
  return error.code ?? 'UNKNOWN';
}

export interface HttpClientOptions {
  env?: Env;
  fetchImpl?: typeof fetch;
  limiter?: RateLimiter;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class HttpBitrixClient implements BitrixClient {
  private readonly env: Env;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private callLog: string[] = [];

  constructor(opts: HttpClientOptions = {}) {
    this.env = opts.env ?? loadEnv();
    this.baseUrl = webhookBaseUrl(this.env);
    registerSecret(this.env.BITRIX24_WEBHOOK_URL);
    registerSecret(this.baseUrl);
    registerSecret(this.env.MCP_AUTH_TOKEN);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.limiter = opts.limiter ?? new RateLimiter(this.env.RATE_LIMIT_RPS);
    this.maxRetries = opts.maxRetries ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  drainCallLog(): string[] {
    const log = this.callLog;
    this.callLog = [];
    return log;
  }

  async call<T = unknown>(
    method: AllowedMethod,
    params: Record<string, unknown> = {},
    options: CallOptions = {},
  ): Promise<T> {
    const envelope = await this.request(method, params, options.api ?? 'v1');
    return envelope.result as T;
  }

  async callList<T = unknown>(
    method: ReadMethod,
    params: Record<string, unknown> = {},
    options: CallOptions = {},
  ): Promise<BitrixListResponse<T>> {
    const envelope = await this.request(method, params, options.api ?? 'v1');
    const result = Array.isArray(envelope.result)
      ? (envelope.result as T[])
      : // crm.item.list nests its rows under result.items
        (((envelope.result as Record<string, unknown>)?.items as T[]) ?? []);
    return {
      result,
      ...(envelope.total !== undefined ? { total: envelope.total } : {}),
      ...(envelope.next !== undefined ? { next: envelope.next } : {}),
    };
  }

  /**
   * v1: `<portal>/rest/<user>/<token>/<method>.json`
   * v3: `<portal>/rest/api/<user>/<token>/<method>`
   * Both are derived from the same webhook secret; the URL is never logged.
   */
  private endpoint(method: string, api: BitrixApiVersion): string {
    if (api === 'v1') return `${this.baseUrl}${method}.json`;
    const match = /^(https:\/\/[^/]+)\/rest\/(\d+)\/([^/]+)\/$/.exec(this.baseUrl);
    if (!match) {
      throw new DomainError('INVALID_REQUEST', 'Webhook URL cannot be mapped to the v3 endpoint');
    }
    const [, origin, userId, token] = match as unknown as [string, string, string, string];
    return `${origin}/rest/api/${userId}/${token}/${method}`;
  }

  private assertAllowed(method: string, api: BitrixApiVersion): void {
    if (api === 'v3' && !isV3Method(method)) {
      throw new DomainError('FORBIDDEN', `Method is not available over the v3 endpoint: ${method}`);
    }
    if (isReadMethod(method)) return;
    if (isWriteMethod(method)) {
      if (!this.env.WRITE_ENABLED) {
        throw new DomainError('WRITE_DISABLED', 'Write operations are disabled on this gateway');
      }
      return;
    }
    // Includes every *.delete method and any arbitrary string.
    throw new DomainError('FORBIDDEN', `REST method is not on the allowlist: ${method}`);
  }

  private async request(
    method: AllowedMethod,
    params: Record<string, unknown>,
    api: BitrixApiVersion = 'v1',
  ): Promise<RawBitrixEnvelope> {
    this.assertAllowed(method, api);
    const retryable = isReadMethod(method);
    const attempts = retryable ? this.maxRetries + 1 : 1;
    let lastError: DomainError | null = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.limiter.acquire();
      const started = Date.now();
      try {
        const envelope = await this.attempt(method, params, api);
        this.callLog.push(api === 'v3' ? `${method}#v3` : method);
        logger.debug('bitrix call ok', { method, api, attempt, ms: Date.now() - started });
        return envelope;
      } catch (err) {
        const domainErr =
          err instanceof DomainError
            ? err
            : new DomainError('UPSTREAM_UNAVAILABLE', 'Bitrix24 request failed', undefined, true);
        lastError = domainErr;
        this.callLog.push(api === 'v3' ? `${method}#v3` : method);
        logger.warn('bitrix call failed', {
          method,
          api,
          attempt,
          code: domainErr.code,
          ms: Date.now() - started,
        });
        if (!retryable || !domainErr.retryable || attempt === attempts) throw domainErr;
        await this.sleep(backoffMs(attempt));
      }
    }
    throw lastError ?? new DomainError('INTERNAL', 'Bitrix24 request failed');
  }

  private async attempt(
    method: AllowedMethod,
    params: Record<string, unknown>,
    api: BitrixApiVersion,
  ): Promise<RawBitrixEnvelope> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.env.REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(this.endpoint(method, api), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });

      let payload: RawBitrixEnvelope;
      try {
        payload = (await response.json()) as RawBitrixEnvelope;
      } catch {
        throw new DomainError(
          'UPSTREAM_UNAVAILABLE',
          'Bitrix24 returned a non-JSON response',
          undefined,
          true,
        );
      }

      const errorCode = errorCodeOf(payload.error);
      if (errorCode) throw mapBitrixError(errorCode, response.status);
      if (!response.ok) throw mapBitrixError('', response.status);
      return payload;
    } catch (err) {
      if (err instanceof DomainError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new DomainError('UPSTREAM_UNAVAILABLE', 'Bitrix24 request timed out', undefined, true);
      }
      // Network-level failure: message may embed the URL, so it is dropped.
      throw new DomainError('UPSTREAM_UNAVAILABLE', 'Bitrix24 is unreachable', undefined, true);
    } finally {
      clearTimeout(timer);
    }
  }
}

function backoffMs(attempt: number): number {
  const base = 400 * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * 200);
}

/** Bitrix24 CRM entity type ids used by the universal crm.item.* API. */
export const ENTITY_TYPE = {
  LEAD: 1,
  DEAL: 2,
  CONTACT: 3,
  COMPANY: 4,
} as const;

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DomainError } from '../domain/errors.js';

/**
 * Idempotency for write operations.
 *
 * A retried agent (or a re-delivered webhook) must not create a second record.
 * The key is scoped by tool + caller-supplied key + a fingerprint of the
 * arguments: reusing a key with different arguments is a caller bug and is
 * rejected rather than silently replayed.
 */
export interface IdempotencyRecord {
  key: string;
  tool: string;
  fingerprint: string;
  status: 'in_progress' | 'succeeded' | 'failed';
  created_at: string;
  completed_at: string | null;
  result_summary?: unknown;
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>;
  put(record: IdempotencyRecord): Promise<void>;
  all(): Promise<IdempotencyRecord[]>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly rows = new Map<string, IdempotencyRecord>();
  async get(key: string): Promise<IdempotencyRecord | null> {
    return this.rows.get(key) ?? null;
  }
  async put(record: IdempotencyRecord): Promise<void> {
    this.rows.set(record.key, record);
  }
  async all(): Promise<IdempotencyRecord[]> {
    return [...this.rows.values()];
  }
}

export class FileIdempotencyStore implements IdempotencyStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'idempotency.json');
  }

  private async readAll(): Promise<Record<string, IdempotencyRecord>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, IdempotencyRecord>;
    } catch {
      return {};
    }
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    return (await this.readAll())[key] ?? null;
  }

  async put(record: IdempotencyRecord): Promise<void> {
    const rows = await this.readAll();
    rows[record.key] = record;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(rows, null, 2), 'utf8');
    await rename(tmp, this.file);
  }

  async all(): Promise<IdempotencyRecord[]> {
    return Object.values(await this.readAll());
  }
}

export function fingerprint(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(args ?? null)).digest('hex').slice(0, 32);
}

export class IdempotencyService {
  constructor(
    private readonly store: IdempotencyStore = new MemoryIdempotencyStore(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  private static scope(tool: string, key: string): string {
    return `${tool}:${key}`;
  }

  /**
   * Reserve a key before applying a write.
   * Returns the previous record when the operation already succeeded, so the
   * caller can return the earlier outcome instead of writing again.
   */
  async begin(
    tool: string,
    key: string,
    args: unknown,
  ): Promise<{ replayed: true; record: IdempotencyRecord } | { replayed: false }> {
    const scoped = IdempotencyService.scope(tool, key);
    const fp = fingerprint(args);
    const existing = await this.store.get(scoped);

    if (existing) {
      if (existing.fingerprint !== fp) {
        throw new DomainError(
          'INVALID_REQUEST',
          'idempotency_key was already used with different arguments',
          { tool },
        );
      }
      if (existing.status === 'succeeded') return { replayed: true, record: existing };
      if (existing.status === 'in_progress') {
        throw new DomainError('INVALID_REQUEST', 'An operation with this key is already running', {
          tool,
        });
      }
    }

    await this.store.put({
      key: scoped,
      tool,
      fingerprint: fp,
      status: 'in_progress',
      created_at: this.now().toISOString(),
      completed_at: null,
    });
    return { replayed: false };
  }

  async succeed(tool: string, key: string, resultSummary: unknown): Promise<void> {
    const scoped = IdempotencyService.scope(tool, key);
    const record = await this.store.get(scoped);
    if (!record) return;
    await this.store.put({
      ...record,
      status: 'succeeded',
      completed_at: this.now().toISOString(),
      result_summary: resultSummary,
    });
  }

  async fail(tool: string, key: string): Promise<void> {
    const scoped = IdempotencyService.scope(tool, key);
    const record = await this.store.get(scoped);
    if (!record) return;
    await this.store.put({ ...record, status: 'failed', completed_at: this.now().toISOString() });
  }
}

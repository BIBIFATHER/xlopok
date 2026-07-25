import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactValue } from '../security/redaction.js';

export interface AuditEntry {
  id: string;
  ts: string;
  actor: string;
  tool: string;
  mode: 'read' | 'write' | 'dry-run';
  outcome: 'ok' | 'denied' | 'error';
  /** Bitrix24 REST methods actually invoked while serving the call. */
  methods: string[];
  /** Redacted argument summary — never raw personal data or secrets. */
  args?: Record<string, unknown>;
  /** Planned or applied change, for write tools. */
  diff?: unknown;
  idempotencyKey?: string;
  durationMs?: number;
  error?: string;
}

const DEFAULT_PATH = process.env.AUDIT_LOG_PATH ?? resolve(process.cwd(), 'audit/audit.jsonl');

export interface AuditSink {
  write(entry: AuditEntry): Promise<void>;
}

/** Append-only JSONL sink. Every entry is redacted before it hits disk. */
export class FileAuditSink implements AuditSink {
  constructor(private readonly path: string = DEFAULT_PATH) {}

  async write(entry: AuditEntry): Promise<void> {
    const safe = redactValue(entry) as AuditEntry;
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(safe) + '\n', 'utf8');
  }
}

/** In-memory sink used by tests. */
export class MemoryAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];
  async write(entry: AuditEntry): Promise<void> {
    this.entries.push(redactValue(entry) as AuditEntry);
  }
}

export class AuditLog {
  constructor(private readonly sink: AuditSink = new FileAuditSink()) {}

  async record(entry: Omit<AuditEntry, 'id' | 'ts'>): Promise<string> {
    const id = randomUUID();
    await this.sink.write({ id, ts: new Date().toISOString(), ...entry });
    return id;
  }
}

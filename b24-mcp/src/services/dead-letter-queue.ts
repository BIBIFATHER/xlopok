import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactValue } from '../security/redaction.js';

/**
 * Dead-letter queue.
 *
 * A write that fails after its retries are exhausted is parked here instead of
 * being retried blindly or silently dropped. Replay is a deliberate human
 * action — the queue is inspected, not drained automatically.
 */
export interface DeadLetter {
  id: string;
  ts: string;
  actor: string;
  tool: string;
  idempotency_key: string | null;
  error_code: string;
  error_message: string;
  /** Redacted payload, enough to rebuild the call by hand. */
  payload: unknown;
  attempts: number;
}

export class DeadLetterQueue {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'dead-letter.jsonl');
  }

  async push(entry: Omit<DeadLetter, 'id' | 'ts'>): Promise<string> {
    const id = randomUUID();
    const record = redactValue({ id, ts: new Date().toISOString(), ...entry }) as DeadLetter;
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, JSON.stringify(record) + '\n', 'utf8');
    return id;
  }

  async list(limit = 100): Promise<DeadLetter[]> {
    try {
      const raw = await readFile(this.file, 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .slice(-limit)
        .map((line) => JSON.parse(line) as DeadLetter);
    } catch {
      return [];
    }
  }
}

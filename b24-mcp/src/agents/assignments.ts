import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DomainError } from '../domain/errors.js';
import type { AgentId } from './roles.js';

/**
 * `agent_assignments` — the single source of truth for who owns which account.
 *
 * Invariants enforced by the store (not by callers):
 *  1. at most one ACTIVE assignment per (entity_type, entity_id);
 *  2. claims are atomic — the read-modify-write cycle runs under an exclusive
 *     lock file, so two agents racing for the same account cannot both win;
 *  3. an active claim expires at `locked_until` and becomes claimable again;
 *  4. only the owning agent (or an admin) may mutate an assignment;
 *  5. after MAX_TRANSFERS hops the assignment goes to HUMAN_REVIEW instead of
 *     bouncing between agents forever.
 */

export type EntityType = 'company' | 'contact' | 'deal';

export type AssignmentStatus =
  | 'claimed'
  | 'completed'
  | 'released'
  | 'transferred'
  | 'expired'
  | 'human_review';

export interface AssignmentMetrics {
  /** Wall-clock seconds from claim to completion. */
  handling_seconds?: number;
  /** Tool calls issued while the assignment was held. */
  tool_calls?: number;
  /** Next actions created during the assignment. */
  next_actions_created?: number;
  /** Records created (company/contact/deal). */
  records_created?: number;
  /** Duplicates detected before creating anything. */
  duplicates_detected?: number;
  /** Operations refused by the policy layer. */
  risky_operations_blocked?: number;
  /** Corrections a human had to make afterwards. */
  manual_corrections?: number;
  /** Estimated processing cost, in the currency of the caller's choosing. */
  cost_units?: number;
  /** LLM tokens spent on the assignment, reported by the agent itself. */
  tokens_used?: number;
}

export type AssignmentResult =
  | 'qualified'
  | 'disqualified'
  | 'contacted'
  | 'no_answer'
  | 'order_discussion'
  | 'invoice_issued'
  | 'paid'
  | 'needs_human'
  | 'abandoned';

export interface TransferRecord {
  from: AgentId;
  to: AgentId;
  reason: string;
  at: string;
}

export interface Assignment {
  id: string;
  entity_type: EntityType;
  entity_id: number;
  assigned_agent: AgentId;
  assignment_reason: string;
  status: AssignmentStatus;
  locked_until: string | null;
  created_at: string;
  completed_at: string | null;
  result: AssignmentResult | null;
  metrics: AssignmentMetrics;
  /** Rule 7/8: bounded hand-offs. */
  transfer_count: number;
  transfer_history: TransferRecord[];
  /** A/B bucket the entity belongs to, when the experiment is running. */
  ab_bucket?: AgentId;
}

export function isActive(a: Assignment, now: Date): boolean {
  if (a.status !== 'claimed') return false;
  if (!a.locked_until) return true;
  return Date.parse(a.locked_until) > now.getTime();
}

export interface ClaimInput {
  entity_type: EntityType;
  entity_id: number;
  agent: AgentId;
  reason: string;
  lockMinutes: number;
  ab_bucket?: AgentId;
}

export interface AssignmentStore {
  /** Atomically claim an account; throws if another agent holds it. */
  claim(input: ClaimInput, now?: Date): Promise<Assignment>;
  release(id: string, agent: AgentId, isAdmin: boolean, now?: Date): Promise<Assignment>;
  complete(
    id: string,
    agent: AgentId,
    isAdmin: boolean,
    result: AssignmentResult,
    metrics: AssignmentMetrics,
    now?: Date,
  ): Promise<Assignment>;
  transfer(
    id: string,
    from: AgentId,
    to: AgentId,
    reason: string,
    maxTransfers: number,
    isAdmin: boolean,
    now?: Date,
  ): Promise<Assignment>;
  listForAgent(agent: AgentId, statuses?: AssignmentStatus[]): Promise<Assignment[]>;
  listAll(): Promise<Assignment[]>;
  /** Active owner of an entity, or null when it is free. */
  activeFor(entity_type: EntityType, entity_id: number, now?: Date): Promise<Assignment | null>;
}

/* -------------------------------------------------------------------------- */

abstract class BaseStore implements AssignmentStore {
  protected abstract read(): Promise<Assignment[]>;
  protected abstract mutate<T>(fn: (rows: Assignment[]) => T | Promise<T>): Promise<T>;

  async claim(input: ClaimInput, now = new Date()): Promise<Assignment> {
    return this.mutate((rows) => {
      const held = rows.find(
        (r) =>
          r.entity_type === input.entity_type &&
          r.entity_id === input.entity_id &&
          isActive(r, now),
      );
      if (held) {
        if (held.assigned_agent === input.agent) return held; // idempotent re-claim
        throw new DomainError('FORBIDDEN', 'Account is already claimed by another agent', {
          entity_type: input.entity_type,
          entity_id: input.entity_id,
          holder: held.assigned_agent,
          locked_until: held.locked_until,
        });
      }
      // Expire any stale claim on the same entity before creating a new one.
      for (const r of rows) {
        if (
          r.entity_type === input.entity_type &&
          r.entity_id === input.entity_id &&
          r.status === 'claimed'
        ) {
          r.status = 'expired';
        }
      }
      const assignment: Assignment = {
        id: randomUUID(),
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        assigned_agent: input.agent,
        assignment_reason: input.reason,
        status: 'claimed',
        locked_until: new Date(now.getTime() + input.lockMinutes * 60_000).toISOString(),
        created_at: now.toISOString(),
        completed_at: null,
        result: null,
        metrics: {},
        transfer_count: 0,
        transfer_history: [],
        ...(input.ab_bucket ? { ab_bucket: input.ab_bucket } : {}),
      };
      rows.push(assignment);
      return assignment;
    });
  }

  async release(id: string, agent: AgentId, isAdmin: boolean, now = new Date()): Promise<Assignment> {
    return this.mutate((rows) => {
      const a = this.require(rows, id);
      this.assertOwner(a, agent, isAdmin);
      a.status = 'released';
      a.locked_until = null;
      a.completed_at = now.toISOString();
      return a;
    });
  }

  async complete(
    id: string,
    agent: AgentId,
    isAdmin: boolean,
    result: AssignmentResult,
    metrics: AssignmentMetrics,
    now = new Date(),
  ): Promise<Assignment> {
    return this.mutate((rows) => {
      const a = this.require(rows, id);
      this.assertOwner(a, agent, isAdmin);
      a.status = 'completed';
      a.result = result;
      a.completed_at = now.toISOString();
      a.locked_until = null;
      a.metrics = {
        ...a.metrics,
        ...metrics,
        handling_seconds:
          metrics.handling_seconds ??
          Math.max(0, Math.round((now.getTime() - Date.parse(a.created_at)) / 1000)),
      };
      return a;
    });
  }

  async transfer(
    id: string,
    from: AgentId,
    to: AgentId,
    reason: string,
    maxTransfers: number,
    isAdmin: boolean,
    now = new Date(),
  ): Promise<Assignment> {
    if (from === to) {
      throw new DomainError('INVALID_REQUEST', 'Cannot transfer an account to its current owner');
    }
    if (!reason.trim()) {
      throw new DomainError('INVALID_REQUEST', 'Transfer requires a reason');
    }
    return this.mutate((rows) => {
      const a = this.require(rows, id);
      this.assertOwner(a, from, isAdmin);
      a.transfer_history.push({ from: a.assigned_agent, to, reason, at: now.toISOString() });
      a.transfer_count += 1;

      if (a.transfer_count > maxTransfers) {
        // Rule 8: stop the ping-pong and hand it to a human.
        a.status = 'human_review';
        a.locked_until = null;
        a.assignment_reason = `HUMAN_REVIEW after ${a.transfer_count} transfers: ${reason}`;
        return a;
      }

      a.assigned_agent = to;
      a.assignment_reason = reason;
      a.status = 'claimed';
      return a;
    });
  }

  async listForAgent(agent: AgentId, statuses?: AssignmentStatus[]): Promise<Assignment[]> {
    const rows = await this.read();
    return rows.filter(
      (r) => r.assigned_agent === agent && (!statuses || statuses.includes(r.status)),
    );
  }

  async listAll(): Promise<Assignment[]> {
    return this.read();
  }

  async activeFor(
    entity_type: EntityType,
    entity_id: number,
    now = new Date(),
  ): Promise<Assignment | null> {
    const rows = await this.read();
    return (
      rows.find((r) => r.entity_type === entity_type && r.entity_id === entity_id && isActive(r, now)) ??
      null
    );
  }

  protected require(rows: Assignment[], id: string): Assignment {
    const a = rows.find((r) => r.id === id);
    if (!a) throw new DomainError('NOT_FOUND', `Assignment ${id} not found`);
    return a;
  }

  /** Rule 3: an agent may not touch an assignment owned by the other agent. */
  protected assertOwner(a: Assignment, agent: AgentId, isAdmin: boolean): void {
    if (isAdmin) return;
    if (a.assigned_agent !== agent) {
      throw new DomainError('FORBIDDEN', 'Assignment belongs to another agent', {
        holder: a.assigned_agent,
      });
    }
    if (a.status === 'human_review') {
      throw new DomainError('FORBIDDEN', 'Assignment is escalated to human review');
    }
  }
}

/** In-memory store — tests and ephemeral runs. */
export class MemoryAssignmentStore extends BaseStore {
  private rows: Assignment[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  protected async read(): Promise<Assignment[]> {
    return structuredClone(this.rows);
  }

  protected async mutate<T>(fn: (rows: Assignment[]) => T | Promise<T>): Promise<T> {
    // Serialise mutations so concurrent claims cannot interleave.
    const run = this.chain.then(async () => fn(this.rows));
    this.chain = run.catch(() => undefined);
    return run as Promise<T>;
  }
}

/**
 * File-backed store with a cross-process exclusive lock.
 * Single-host only; move to Postgres (SELECT ... FOR UPDATE) or Redis when the
 * gateway runs more than one instance.
 */
export class FileAssignmentStore extends BaseStore {
  private readonly file: string;
  private readonly lockFile: string;

  constructor(dataDir: string) {
    super();
    this.file = join(dataDir, 'agent_assignments.json');
    this.lockFile = join(dataDir, 'agent_assignments.lock');
  }

  protected async read(): Promise<Assignment[]> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Assignment[]) : [];
    } catch {
      return [];
    }
  }

  protected async mutate<T>(fn: (rows: Assignment[]) => T | Promise<T>): Promise<T> {
    await mkdir(dirname(this.file), { recursive: true });
    await this.acquireLock();
    try {
      const rows = await this.read();
      const out = await fn(rows);
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(rows, null, 2), 'utf8');
      await rename(tmp, this.file); // atomic replace
      return out;
    } finally {
      await this.releaseLock();
    }
  }

  private async acquireLock(attempts = 50): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        const handle = await open(this.lockFile, 'wx');
        await handle.close();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 30)));
      }
    }
    throw new DomainError('INTERNAL', 'Could not acquire the assignment lock');
  }

  private async releaseLock(): Promise<void> {
    const { unlink } = await import('node:fs/promises');
    await unlink(this.lockFile).catch(() => undefined);
  }
}

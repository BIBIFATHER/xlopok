import type { AuditLog } from '../audit/audit-log.js';
import {
  isActive,
  type Assignment,
  type AssignmentMetrics,
  type AssignmentResult,
  type AssignmentStore,
  type EntityType,
} from '../agents/assignments.js';
import { routeWorkItem, type RoutingDecision, type WorkItem } from '../agents/routing.js';
import { computePerformance } from '../agents/metrics.js';
import { SALES_AGENTS, type AgentId } from '../agents/roles.js';
import { DomainError } from '../domain/errors.js';
import type { Env } from '../config/env.js';

/**
 * Work distribution. Wraps the store with routing, audit and the transfer cap,
 * so tool handlers never touch the raw store.
 */
export interface AvailableWorkItem extends WorkItem {
  title: string;
  reason: string;
  priority: number;
  suggested_agent: AgentId;
  routing: RoutingDecision;
  claimable_by_me: boolean;
  held_by: AgentId | null;
}

export class AssignmentService {
  constructor(
    private readonly store: AssignmentStore,
    private readonly audit: AuditLog,
    private readonly env: Env,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Route a batch of candidates and mark which are free for this caller. */
  async annotate(
    candidates: Array<WorkItem & { title: string; reason: string; priority: number }>,
    caller: AgentId,
  ): Promise<AvailableWorkItem[]> {
    const history = await this.store.listAll();
    const perf = computePerformance(history);
    const now = this.now();

    const out: AvailableWorkItem[] = [];
    for (const candidate of candidates) {
      const held = history.find(
        (a) =>
          a.entity_type === candidate.entity_type &&
          a.entity_id === candidate.entity_id &&
          isActive(a, now),
      );
      const routing = routeWorkItem({
        mode: this.env.ROUTING_MODE,
        item: candidate,
        history,
        performance: perf,
        minSample: this.env.ROUTING_MIN_SAMPLE,
        abTestEnabled: this.env.AB_TEST_ENABLED,
      });
      out.push({
        ...candidate,
        suggested_agent: routing.agent,
        routing,
        held_by: held?.assigned_agent ?? null,
        claimable_by_me:
          !held && (caller === 'admin' || routing.agent === caller || !this.env.AB_TEST_ENABLED),
      });
    }
    return out;
  }

  async claim(params: {
    entity_type: EntityType;
    entity_id: number;
    agent: AgentId;
    reason: string;
    idempotency_key: string;
  }): Promise<Assignment> {
    const history = await this.store.listAll();
    const routing = routeWorkItem({
      mode: this.env.ROUTING_MODE,
      item: { entity_type: params.entity_type, entity_id: params.entity_id },
      history,
      performance: computePerformance(history),
      minSample: this.env.ROUTING_MIN_SAMPLE,
      abTestEnabled: this.env.AB_TEST_ENABLED,
    });

    // Under an active A/B experiment the bucket is binding: an agent may not
    // pick up an account that belongs to the other arm.
    if (this.env.AB_TEST_ENABLED && params.agent !== 'admin' && routing.agent !== params.agent) {
      throw new DomainError('FORBIDDEN', 'Account belongs to the other A/B arm', {
        bucket: routing.agent,
      });
    }

    const assignment = await this.store.claim(
      {
        entity_type: params.entity_type,
        entity_id: params.entity_id,
        agent: params.agent,
        reason: params.reason,
        lockMinutes: this.env.ASSIGNMENT_LOCK_MINUTES,
        ...(this.env.AB_TEST_ENABLED ? { ab_bucket: routing.agent } : {}),
      },
      this.now(),
    );

    await this.audit.record({
      actor: params.agent,
      tool: 'sales_claim_account',
      mode: 'write',
      outcome: 'ok',
      methods: [],
      args: {
        entity_type: params.entity_type,
        entity_id: params.entity_id,
        routing_mode: routing.mode,
      },
      idempotencyKey: params.idempotency_key,
    });

    return assignment;
  }

  async release(id: string, agent: AgentId): Promise<Assignment> {
    const a = await this.store.release(id, agent, agent === 'admin', this.now());
    await this.audit.record({
      actor: agent,
      tool: 'sales_release_account',
      mode: 'write',
      outcome: 'ok',
      methods: [],
      args: { assignment_id: id },
    });
    return a;
  }

  async complete(
    id: string,
    agent: AgentId,
    result: AssignmentResult,
    metrics: AssignmentMetrics,
  ): Promise<Assignment> {
    const a = await this.store.complete(id, agent, agent === 'admin', result, metrics, this.now());
    await this.audit.record({
      actor: agent,
      tool: 'sales_complete_assignment',
      mode: 'write',
      outcome: 'ok',
      methods: [],
      args: { assignment_id: id, result },
    });
    return a;
  }

  async transfer(
    id: string,
    from: AgentId,
    to: AgentId,
    reason: string,
  ): Promise<Assignment> {
    if (!SALES_AGENTS.includes(to) && to !== 'admin') {
      throw new DomainError('INVALID_REQUEST', `Unknown transfer target: ${to}`);
    }
    const a = await this.store.transfer(
      id,
      from,
      to,
      reason,
      this.env.MAX_TRANSFERS,
      from === 'admin',
      this.now(),
    );
    await this.audit.record({
      actor: from,
      tool: 'sales_transfer_account',
      mode: 'write',
      outcome: a.status === 'human_review' ? 'denied' : 'ok',
      methods: [],
      args: { assignment_id: id, to, transfer_count: a.transfer_count, status: a.status },
    });
    return a;
  }

  async mine(agent: AgentId): Promise<Assignment[]> {
    return this.store.listForAgent(agent, ['claimed', 'human_review']);
  }

  async all(): Promise<Assignment[]> {
    return this.store.listAll();
  }
}

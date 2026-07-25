import { describe, expect, it, beforeEach } from 'vitest';
import { testEnv } from './helpers/env.js';
import { MemoryAssignmentStore, isActive } from '../src/agents/assignments.js';
import { AssignmentService } from '../src/services/assignment-service.js';
import { AuditLog, MemoryAuditSink } from '../src/audit/audit-log.js';
import { routeWorkItem, abBucket } from '../src/agents/routing.js';
import { computePerformance, compareAgents } from '../src/agents/metrics.js';
import type { Env } from '../src/config/env.js';

let store: MemoryAssignmentStore;
let sink: MemoryAuditSink;
let env: Env;
let now: Date;

function service(): AssignmentService {
  return new AssignmentService(store, new AuditLog(sink), env, () => now);
}

beforeEach(() => {
  store = new MemoryAssignmentStore();
  sink = new MemoryAuditSink();
  env = testEnv({ ASSIGNMENT_LOCK_MINUTES: '60', MAX_TRANSFERS: '2' });
  now = new Date('2026-07-24T10:00:00.000Z');
});

describe('atomic claim', () => {
  it('lets only one agent hold an account', async () => {
    const svc = service();
    await svc.claim({
      entity_type: 'company',
      entity_id: 42,
      agent: 'claude_sales_agent',
      reason: 'первичный контакт',
      idempotency_key: 'claim-42-claude',
    });

    await expect(
      svc.claim({
        entity_type: 'company',
        entity_id: 42,
        agent: 'codex_sales_agent',
        reason: 'тоже хочу',
        idempotency_key: 'claim-42-codex',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('survives a concurrent race — exactly one winner', async () => {
    const svc = service();
    const attempts = [
      svc.claim({
        entity_type: 'deal',
        entity_id: 7,
        agent: 'claude_sales_agent',
        reason: 'race',
        idempotency_key: 'race-1',
      }),
      svc.claim({
        entity_type: 'deal',
        entity_id: 7,
        agent: 'codex_sales_agent',
        reason: 'race',
        idempotency_key: 'race-2',
      }),
    ];
    const results = await Promise.allSettled(attempts);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('is idempotent for the current holder', async () => {
    const svc = service();
    const first = await svc.claim({
      entity_type: 'deal',
      entity_id: 8,
      agent: 'claude_sales_agent',
      reason: 'работа',
      idempotency_key: 'k1',
    });
    const second = await svc.claim({
      entity_type: 'deal',
      entity_id: 8,
      agent: 'claude_sales_agent',
      reason: 'работа',
      idempotency_key: 'k1',
    });
    expect(second.id).toBe(first.id);
  });
});

describe('lock TTL', () => {
  it('frees the account once the lock expires', async () => {
    const svc = service();
    await svc.claim({
      entity_type: 'company',
      entity_id: 1,
      agent: 'claude_sales_agent',
      reason: 'работа',
      idempotency_key: 'ttl-1',
    });

    expect(await store.activeFor('company', 1, now)).not.toBeNull();

    now = new Date('2026-07-24T11:30:00.000Z'); // +90 min, lock was 60
    expect(await store.activeFor('company', 1, now)).toBeNull();

    const reclaimed = await service().claim({
      entity_type: 'company',
      entity_id: 1,
      agent: 'codex_sales_agent',
      reason: 'блокировка истекла',
      idempotency_key: 'ttl-2',
    });
    expect(reclaimed.assigned_agent).toBe('codex_sales_agent');
  });

  it('marks an expired claim as inactive', () => {
    const assignment = {
      status: 'claimed' as const,
      locked_until: '2026-07-24T09:00:00.000Z',
    };
    expect(isActive(assignment as any, now)).toBe(false);
  });
});

describe('ownership', () => {
  it('prevents the other agent from mutating a held assignment', async () => {
    const svc = service();
    const a = await svc.claim({
      entity_type: 'deal',
      entity_id: 5,
      agent: 'claude_sales_agent',
      reason: 'работа',
      idempotency_key: 'own-1',
    });
    await expect(svc.release(a.id, 'codex_sales_agent')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('lets admin force-release', async () => {
    const svc = service();
    const a = await svc.claim({
      entity_type: 'deal',
      entity_id: 6,
      agent: 'claude_sales_agent',
      reason: 'работа',
      idempotency_key: 'own-2',
    });
    const released = await svc.release(a.id, 'admin');
    expect(released.status).toBe('released');
  });
});

describe('transfer limit', () => {
  it('escalates to HUMAN_REVIEW after the third transfer', async () => {
    const svc = service();
    const a = await svc.claim({
      entity_type: 'company',
      entity_id: 99,
      agent: 'claude_sales_agent',
      reason: 'работа',
      idempotency_key: 'tr-1',
    });

    const t1 = await svc.transfer(a.id, 'claude_sales_agent', 'codex_sales_agent', 'нужен другой подход');
    expect(t1.status).toBe('claimed');
    expect(t1.assigned_agent).toBe('codex_sales_agent');

    const t2 = await svc.transfer(a.id, 'codex_sales_agent', 'claude_sales_agent', 'верну обратно');
    expect(t2.status).toBe('claimed');
    expect(t2.transfer_count).toBe(2);

    const t3 = await svc.transfer(a.id, 'claude_sales_agent', 'codex_sales_agent', 'снова передаю');
    expect(t3.status).toBe('human_review');
    expect(t3.transfer_count).toBe(3);
  });

  it('refuses a transfer without a reason or to self', async () => {
    const svc = service();
    const a = await svc.claim({
      entity_type: 'company',
      entity_id: 100,
      agent: 'claude_sales_agent',
      reason: 'работа',
      idempotency_key: 'tr-2',
    });
    await expect(
      svc.transfer(a.id, 'claude_sales_agent', 'claude_sales_agent', 'причина'),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      svc.transfer(a.id, 'claude_sales_agent', 'codex_sales_agent', '   '),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('audit trail', () => {
  it('records every assignment operation', async () => {
    const svc = service();
    const a = await svc.claim({
      entity_type: 'deal',
      entity_id: 11,
      agent: 'claude_sales_agent',
      reason: 'работа',
      idempotency_key: 'aud-1',
    });
    await svc.complete(a.id, 'claude_sales_agent', 'qualified', { tokens_used: 1200 });

    const tools = sink.entries.map((e) => e.tool);
    expect(tools).toContain('sales_claim_account');
    expect(tools).toContain('sales_complete_assignment');
    expect(sink.entries.every((e) => e.actor === 'claude_sales_agent')).toBe(true);
  });
});

describe('routing', () => {
  it('defaults to round robin and alternates between the two agents', () => {
    const first = routeWorkItem({
      mode: 'round_robin',
      item: { entity_type: 'deal', entity_id: 1 },
      history: [],
      minSample: 50,
      abTestEnabled: false,
    });
    expect(first.agent).toBe('claude_sales_agent');

    const second = routeWorkItem({
      mode: 'round_robin',
      item: { entity_type: 'deal', entity_id: 2 },
      history: [{ assigned_agent: 'claude_sales_agent' } as any],
      minSample: 50,
      abTestEnabled: false,
    });
    expect(second.agent).toBe('codex_sales_agent');
  });

  it('does not switch to performance_based below the minimum sample', () => {
    const decision = routeWorkItem({
      mode: 'performance_based',
      item: { entity_type: 'deal', entity_id: 3 },
      history: [],
      performance: {
        claude_sales_agent: { completed_assignments: 3, paid: 3 } as any,
        codex_sales_agent: { completed_assignments: 1, paid: 0 } as any,
        admin: undefined,
      },
      minSample: 50,
      abTestEnabled: false,
    });
    expect(decision.fallback_from).toBe('performance_based');
    expect(decision.reason).toMatch(/Insufficient sample/);
  });

  it('keeps an entity in a single A/B arm', () => {
    const bucketA = abBucket({ entity_type: 'company', entity_id: 4242 });
    const bucketB = abBucket({ entity_type: 'company', entity_id: 4242 });
    expect(bucketA).toBe(bucketB);
  });
});

describe('A/B comparison', () => {
  it('declares no winner until both agents clear the sample', () => {
    const perf = computePerformance([]);
    const report = compareAgents(perf, 50, now);
    expect(report.winner).toBeNull();
    expect(report.sufficient_sample).toBe(false);
  });

  it('ranks by paid deals before activity volume', () => {
    const perf = computePerformance([]);
    perf.claude_sales_agent.completed_assignments = 60;
    perf.codex_sales_agent.completed_assignments = 60;
    perf.claude_sales_agent.paid = 2;
    perf.codex_sales_agent.paid = 9;
    perf.claude_sales_agent.next_actions_created = 500;
    perf.codex_sales_agent.next_actions_created = 10;

    const report = compareAgents(perf, 50, now);
    expect(report.winner).toBe('codex_sales_agent');
    expect(report.criteria[0]!.name).toBe('paid_deals');
  });
});

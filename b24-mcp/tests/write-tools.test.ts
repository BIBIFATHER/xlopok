import { describe, expect, it } from 'vitest';
import { harness } from './helpers/fixtures.js';
import { setFieldMaps } from '../src/bitrix/field-map.js';
import { ApprovalService } from '../src/services/approval-service.js';
import { IdempotencyService, MemoryIdempotencyStore } from '../src/services/idempotency-service.js';
import { DeadLetterQueue } from '../src/services/dead-letter-queue.js';
import { assertBatchSize, MAX_WRITE_BATCH } from '../src/mcp/permissions.js';

const KEY = 'idem-key-0001';

describe('write gating', () => {
  it('does not register write tools with WRITE_ENABLED=false', () => {
    const h = harness({ writeEnabled: false });
    expect(h.tools.has('crm_create_company')).toBe(false);
    expect(h.tools.has('crm_update_deal_stage')).toBe(false);
  });

  it('blocks the underlying REST method too, not only the tool', async () => {
    const h = harness({ writeEnabled: false });
    await expect(h.client.call('crm.item.add', {})).rejects.toMatchObject({
      code: 'WRITE_DISABLED',
    });
  });
});

describe('crm_create_company', () => {
  it('defaults to dry-run and returns a diff without writing', async () => {
    const h = harness({ writeEnabled: true });
    const result = await h.call('crm_create_company', {
      title: 'ООО "Новый Холст"',
      phones: ['+7 999 000-11-22'],
      idempotency_key: KEY,
    });
    expect(result.applied).toBe(false);
    expect(result.diff.operation).toBe('create');
    expect(result.diff.changes.some((c: any) => c.field === 'title')).toBe(true);
    expect(h.client.calls.some((c) => c.method === 'crm.item.add')).toBe(false);
  });

  it('refuses to create when a duplicate exists', async () => {
    const h = harness({ writeEnabled: true });
    await expect(
      h.call('crm_create_company', {
        title: 'ООО "Арт Багет"',
        phones: ['8 916 111-22-33'],
        idempotency_key: KEY,
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_FOUND' });
  });

  it('applies the change when dry_run is explicitly false', async () => {
    const h = harness({ writeEnabled: true });
    const result = await h.call('crm_create_company', {
      title: 'ООО "Новый Холст"',
      phones: ['+7 999 000-11-22'],
      idempotency_key: KEY,
      dry_run: false,
    });
    expect(result.applied).toBe(true);
    expect(h.client.calls.some((c) => c.method === 'crm.item.add')).toBe(true);
  });

  it('rejects a replayed idempotency key', async () => {
    const h = harness({ writeEnabled: true });
    const args = {
      title: 'ООО "Новый Холст"',
      phones: ['+7 999 000-11-22'],
      idempotency_key: KEY,
      dry_run: false,
    };
    await h.call('crm_create_company', args);
    await expect(h.call('crm_create_company', args)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(h.client.calls.filter((c) => c.method === 'crm.item.add')).toHaveLength(1);
  });

  it('requires an idempotency key', async () => {
    const h = harness({ writeEnabled: true });
    await expect(
      h.call('crm_create_company', { title: 'ООО "Тест"', idempotency_key: 'short' }),
    ).rejects.toThrowError(/idempotency_key/);
  });
});

describe('crm_update_deal_stage', () => {
  it('allows a normal forward move', async () => {
    const h = harness({ writeEnabled: true });
    const result = await h.call('crm_update_deal_stage', {
      deal_id: 100,
      target_stage_id: 'C0:PREPARATION',
      reason: 'клиент запросил счёт',
      idempotency_key: KEY,
    });
    expect(result.diff.changes[0]).toMatchObject({ field: 'stageId', from: 'C0:NEW' });
  });

  it('refuses to close a deal as lost without an approver', async () => {
    const h = harness({ writeEnabled: true });
    await expect(
      h.call('crm_update_deal_stage', {
        deal_id: 100,
        target_stage_id: 'C0:LOSE',
        reason: 'клиент отказался',
        idempotency_key: KEY,
      }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
  });

  it('refuses self-approval of a lost stage', async () => {
    const h = harness({ writeEnabled: true, agentId: 'claude_sales_agent' });
    await expect(
      h.call('crm_update_deal_stage', {
        deal_id: 100,
        target_stage_id: 'C0:LOSE',
        reason: 'клиент отказался',
        approved_by: 'claude_sales_agent',
        idempotency_key: KEY,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('accepts approval from another identity', async () => {
    const h = harness({ writeEnabled: true, agentId: 'claude_sales_agent' });
    const result = await h.call('crm_update_deal_stage', {
      deal_id: 100,
      target_stage_id: 'C0:LOSE',
      reason: 'клиент отказался',
      approved_by: 'admin',
      idempotency_key: KEY,
    });
    expect(result.diff.side_effects[0]).toContain('admin');
  });
});

describe('assignment ownership blocks cross-agent writes', () => {
  it('refuses a note on an account held by the other agent', async () => {
    const h = harness({ writeEnabled: true, agentId: 'claude_sales_agent' });
    await h.ctx.assignments.claim(
      {
        entity_type: 'deal',
        entity_id: 100,
        agent: 'codex_sales_agent',
        reason: 'взял в работу',
        lockMinutes: 60,
      },
      h.ctx.now(),
    );

    await expect(
      h.call('crm_add_note', {
        entity_type: 'deal',
        entity_id: 100,
        text: 'мой комментарий',
        idempotency_key: KEY,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('crm_update_next_step', () => {
  it('refuses when no Canvas Lab field is mapped yet', async () => {
    const h = harness({ writeEnabled: true });
    setFieldMaps({ company: {}, deal: {} });
    await expect(
      h.call('crm_update_next_step', {
        deal_id: 100,
        next_step: 'позвонить в четверг',
        idempotency_key: KEY,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('writes only the mapped fields once field-map is configured', async () => {
    const h = harness({ writeEnabled: true });
    setFieldMaps({ company: {}, deal: { next_step: 'UF_CRM_1000000001' } });
    const result = await h.call('crm_update_next_step', {
      deal_id: 100,
      next_step: 'позвонить в четверг',
      need: 'холсты 40x50',
      idempotency_key: KEY,
      dry_run: false,
    });
    const update = h.client.calls.find((c) => c.method === 'crm.item.update')!;
    expect(update.params.fields).toEqual({ UF_CRM_1000000001: 'позвонить в четверг' });
    expect(result.diff.side_effects[0]).toContain('need');
    setFieldMaps(null);
  });
});

describe('call summary and follow-up', () => {
  it('writes a structured call summary and never messages the client', async () => {
    const h = harness({ writeEnabled: true });
    const result = await h.call('crm_add_call_summary', {
      entity_type: 'deal',
      entity_id: 100,
      outcome: 'qualified',
      summary: 'Обсудили объём 200 холстов в месяц',
      agreements: ['Прислать прайс'],
      next_step: 'Отправить КП',
      idempotency_key: KEY,
      dry_run: false,
    });
    const call = h.client.calls.find((c) => c.method === 'crm.timeline.comment.add')!;
    const comment = String((call.params.fields as any).COMMENT);
    expect(comment).toContain('Итог звонка: qualified');
    expect(comment).toContain('claude_sales_agent');
    expect(result.diff.side_effects[0]).toContain('crm_create_followup');
  });

  it('rejects a follow-up with a deadline in the past', async () => {
    const h = harness({ writeEnabled: true });
    await expect(
      h.call('crm_create_followup', {
        entity_type: 'deal',
        entity_id: 100,
        title: 'Позвонить клиенту',
        deadline: '2020-01-01T10:00:00.000Z',
        responsible_id: 5,
        idempotency_key: KEY,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('bulk and prohibited operations', () => {
  it('caps batch size', () => {
    expect(MAX_WRITE_BATCH).toBe(1);
    expect(() => assertBatchSize(2)).toThrowError(/limited to 1/);
  });

  it('requires admin approval for a bulk operation', () => {
    const approvals = new ApprovalService(1);
    expect(() => approvals.assertBatchAllowed(50, undefined, 'claude_sales_agent')).toThrowError(
      /human approval/,
    );
    expect(() =>
      approvals.assertBatchAllowed(50, 'codex_sales_agent', 'claude_sales_agent'),
    ).toThrowError(/only be approved by admin/);
    expect(() => approvals.assertBatchAllowed(50, 'admin', 'claude_sales_agent')).not.toThrow();
  });

  it('permanently blocks deletion, messaging, invoicing and price changes', () => {
    const approvals = new ApprovalService();
    for (const op of [
      'delete_record',
      'send_client_message',
      'issue_invoice',
      'change_price',
      'call_arbitrary_rest_method',
    ]) {
      expect(() => approvals.assertNotProhibited(op)).toThrowError(/permanently disabled/);
    }
  });

  it('never lets an agent approve its own risky operation', () => {
    const approvals = new ApprovalService();
    expect(() =>
      approvals.request({
        operation: 'close_deal_as_lost',
        actor: 'claude_sales_agent',
        approver: 'claude_sales_agent',
        reason: 'нет ответа',
        affected_count: 1,
      }),
    ).toThrowError(/cannot approve its own/);
  });
});

describe('idempotency service', () => {
  it('replays a succeeded operation instead of repeating it', async () => {
    const svc = new IdempotencyService(new MemoryIdempotencyStore());
    const args = { title: 'ООО "Тест"' };
    expect(await svc.begin('crm_create_company', KEY, args)).toEqual({ replayed: false });
    await svc.succeed('crm_create_company', KEY, { id: 1 });
    const second = await svc.begin('crm_create_company', KEY, args);
    expect(second).toMatchObject({ replayed: true });
  });

  it('rejects the same key with different arguments', async () => {
    const svc = new IdempotencyService(new MemoryIdempotencyStore());
    await svc.begin('crm_create_company', KEY, { title: 'A' });
    await svc.succeed('crm_create_company', KEY, { id: 1 });
    await expect(svc.begin('crm_create_company', KEY, { title: 'B' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });
});

describe('dead-letter queue', () => {
  it('stores a redacted failure record', async () => {
    const dlq = new DeadLetterQueue('data/test');
    await dlq.push({
      actor: 'claude_sales_agent',
      tool: 'crm_create_company',
      idempotency_key: KEY,
      error_code: 'UPSTREAM_UNAVAILABLE',
      error_message: 'Bitrix24 is unreachable',
      payload: { phone: '+79161112233' },
      attempts: 3,
    });
    const rows = await dlq.list();
    const last = rows.at(-1)!;
    expect(last.tool).toBe('crm_create_company');
    expect(JSON.stringify(last.payload)).not.toContain('9161112233');
  });
});

import { describe, expect, it } from 'vitest';
import { harness } from './helpers/fixtures.js';

describe('crm_search_companies', () => {
  it('searches by title and returns a normalised summary', async () => {
    const h = harness();
    const result = await h.call('crm_search_companies', { query: 'Багет' });
    expect(result.matched_by).toBe('title');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: 1, title: 'ООО "Арт Багет"', city: 'Москва' });
  });

  it('routes a phone query through the duplicate index', async () => {
    const h = harness();
    const result = await h.call('crm_search_companies', { query: '8 916 111-22-33' });
    expect(result.matched_by).toBe('phone');
    expect(result.items[0].id).toBe(1);
    expect(h.client.calls.some((c) => c.method === 'crm.duplicate.findbycomm')).toBe(true);
  });

  it('rejects a query that is too broad', async () => {
    const h = harness();
    await expect(h.call('crm_search_companies', {})).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });
});

describe('crm_get_company', () => {
  it('returns the card with contacts, open deals and the next action', async () => {
    const h = harness();
    const result = await h.call('crm_get_company', { company_id: 1 });
    expect(result.company.title).toBe('ООО "Арт Багет"');
    expect(result.contacts).toHaveLength(1);
    expect(result.open_deals.map((d: any) => d.id)).toContain(100);
    expect(result.next_action).not.toBeNull();
  });

  it('maps a missing company to NOT_FOUND', async () => {
    const h = harness();
    await expect(h.call('crm_get_company', { company_id: 999 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('crm_search_contacts', () => {
  it('normalises a phone before searching', async () => {
    const h = harness();
    const result = await h.call('crm_search_contacts', { query: '89161112233' });
    expect(result.matched_by).toBe('phone');
    expect(result.normalized_query).toBe('+79161112233');
    expect(result.items[0].id).toBe(10);
  });

  it('searches by name across name parts', async () => {
    const h = harness();
    const result = await h.call('crm_search_contacts', { query: 'Филатова' });
    expect(result.items[0].fullName).toContain('Филатова');
  });

  it('refuses an empty query with no filters', async () => {
    const h = harness();
    await expect(h.call('crm_search_contacts', {})).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });
});

describe('crm_get_contact', () => {
  it('returns contact, company and deals', async () => {
    const h = harness();
    const result = await h.call('crm_get_contact', { contact_id: 10 });
    expect(result.contact.fullName).toBe('Филатова Ольга');
    expect(result.company.id).toBe(1);
    expect(result.deals.length).toBeGreaterThan(0);
  });
});

describe('crm_search_deals', () => {
  it('filters to open deals by default and returns safe fields only', async () => {
    const h = harness();
    const result = await h.call('crm_search_deals', {});
    expect(result.items.length).toBe(2);
    const keys = Object.keys(result.items[0]).sort();
    expect(keys).toEqual(
      [
        'assignedById',
        'companyId',
        'currencyId',
        'id',
        'opportunity',
        'stageChangedAt',
        'stageId',
        'title',
      ].sort(),
    );
  });

  it('filters by responsible manager', async () => {
    const h = harness();
    const result = await h.call('crm_search_deals', { assigned_by_id: 6 });
    expect(result.items.map((d: any) => d.id)).toEqual([101]);
  });
});

describe('crm_get_deal', () => {
  it('returns the deal with company, contacts, activities and next action', async () => {
    const h = harness();
    const result = await h.call('crm_get_deal', { deal_id: 100 });
    expect(result.deal.id).toBe(100);
    expect(result.company.id).toBe(1);
    expect(result.contacts).toHaveLength(1);
    expect(result.next_action).not.toBeNull();
    expect(result.loss_reason).toBeNull();
  });
});

describe('follow-up hygiene tools', () => {
  it('lists overdue follow-ups from both activities and tasks', async () => {
    const h = harness();
    const result = await h.call('crm_get_overdue_followups', {});
    expect(result.count).toBeGreaterThan(0);
    expect(result.items.some((i: any) => i.source === 'activity')).toBe(true);
    expect(result.items.some((i: any) => i.source === 'task')).toBe(true);
  });

  it('finds open deals with no planned next action', async () => {
    const h = harness();
    const result = await h.call('crm_get_deals_without_next_action', {});
    expect(result.items.map((d: any) => d.id)).toEqual([101]);
  });

  it('finds deals stuck in one stage beyond the threshold', async () => {
    const h = harness();
    const result = await h.call('crm_get_stale_deals', { threshold_days: 30 });
    expect(result.items.map((d: any) => d.id)).toEqual([100]);
    expect(result.items[0].daysInStage).toBeGreaterThan(30);
  });
});

describe('crm_get_sales_summary', () => {
  it('aggregates the portfolio', async () => {
    const h = harness();
    const result = await h.call('crm_get_sales_summary', { inactivity_days: 14 });
    expect(result.openDeals.count).toBe(2);
    expect(result.openDeals.totalOpportunity).toBe(200000);
    expect(result.byStage.length).toBe(2);
    expect(result.dealsWithoutNextAction).toBe(1);
    expect(result.truncated).toBe(false);
  });
});

describe('crm_find_duplicates', () => {
  it('reports matches by phone and email', async () => {
    const h = harness();
    const result = await h.call('crm_find_duplicates', {
      phones: ['8 916 111-22-33'],
      emails: [],
    });
    expect(result.safe_to_create).toBe(false);
    expect(result.matches.some((m: any) => m.entity === 'company' && m.id === 1)).toBe(true);
  });

  it('reports a clean check for an unknown number', async () => {
    const h = harness();
    const result = await h.call('crm_find_duplicates', { phones: ['+7 999 000-00-00'] });
    expect(result.safe_to_create).toBe(true);
  });

  it('requires at least one identifier', async () => {
    const h = harness();
    await expect(h.call('crm_find_duplicates', {})).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });
});

describe('crm_prepare_outreach', () => {
  it('produces a lead score and a draft that is never sent', async () => {
    const h = harness();
    const result = await h.call('crm_prepare_outreach', { company_id: 1 });
    expect(result.lead_score.score).toBeGreaterThanOrEqual(0);
    expect(result.delivery).toBe('draft_only');
    expect(result.draft_body).toContain('ЧЕРНОВИК');
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it('flags the Canvas Lab fields that are missing from the card', async () => {
    const h = harness();
    const result = await h.call('crm_prepare_outreach', { company_id: 2 });
    expect(result.lead_score.missing_data).toContain('estimated_monthly_volume');
  });
});

describe('audit', () => {
  it('records read calls with the REST methods used and masks personal data', async () => {
    const h = harness();
    await h.call('crm_search_companies', { query: 'Багет' });
    await h.ctx.audit.record({
      actor: 'claude_sales_agent',
      tool: 'crm_search_companies',
      mode: 'read',
      outcome: 'ok',
      methods: h.client.drainCallLog(),
      args: { query: '+7 916 111-22-33' },
    });
    const entry = h.sink.entries.at(-1)!;
    expect(entry.methods).toContain('crm.item.list');
    expect(JSON.stringify(entry.args)).not.toContain('9161112233');
  });
});

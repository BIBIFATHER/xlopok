import { describe, expect, it } from 'vitest';
import {
  testEnv,
  TEST_ADMIN_TOKEN,
  TEST_CLAUDE_TOKEN,
  TEST_CODEX_TOKEN,
} from './helpers/env.js';
import {
  capabilitiesOf,
  identityFromBearer,
  SHARED_SALES_CAPABILITIES,
} from '../src/agents/roles.js';
import { MockBitrixClient } from './mocks/bitrix-mock.js';
import { buildToolContext } from '../src/mcp/tools/context.js';
import { toolsForIdentity } from '../src/mcp/server.js';
import { MemoryAssignmentStore } from '../src/agents/assignments.js';
import { MemoryAuditSink, AuditLog } from '../src/audit/audit-log.js';

function toolNamesFor(agentId: 'claude_sales_agent' | 'codex_sales_agent' | 'admin', write: boolean) {
  const env = testEnv({ WRITE_ENABLED: write ? 'true' : 'false' });
  const ctx = buildToolContext({
    client: new MockBitrixClient(),
    env,
    identity: { agentId, via: 'bearer' },
    assignments: new MemoryAssignmentStore(),
    audit: new AuditLog(new MemoryAuditSink()),
  });
  return toolsForIdentity(ctx)
    .map((t) => t.name)
    .sort();
}

describe('agent roles', () => {
  it('gives Claude and Codex an identical sales toolset', () => {
    expect(toolNamesFor('claude_sales_agent', false)).toEqual(
      toolNamesFor('codex_sales_agent', false),
    );
    expect(toolNamesFor('claude_sales_agent', true)).toEqual(
      toolNamesFor('codex_sales_agent', true),
    );
  });

  it('gives Claude and Codex identical capabilities', () => {
    expect(capabilitiesOf('claude_sales_agent')).toEqual(capabilitiesOf('codex_sales_agent'));
    expect(capabilitiesOf('claude_sales_agent')).toEqual(SHARED_SALES_CAPABILITIES);
  });

  it('grants admin strictly more capabilities than a sales agent', () => {
    const admin = capabilitiesOf('admin');
    for (const cap of SHARED_SALES_CAPABILITIES) expect(admin).toContain(cap);
    expect(admin.length).toBeGreaterThan(SHARED_SALES_CAPABILITIES.length);
  });

  it('resolves each token to its own agent', () => {
    const env = testEnv();
    expect(identityFromBearer(`Bearer ${TEST_CLAUDE_TOKEN}`, env).agentId).toBe(
      'claude_sales_agent',
    );
    expect(identityFromBearer(`Bearer ${TEST_CODEX_TOKEN}`, env).agentId).toBe('codex_sales_agent');
    expect(identityFromBearer(`Bearer ${TEST_ADMIN_TOKEN}`, env).agentId).toBe('admin');
  });

  it('rejects an unknown or missing token', () => {
    const env = testEnv();
    expect(() => identityFromBearer('Bearer wrong-token-value', env)).toThrowError(/Unauthorized/);
    expect(() => identityFromBearer(undefined, env)).toThrowError(/Unauthorized/);
  });
});

describe('tool registration gating', () => {
  it('hides every write tool when WRITE_ENABLED=false', () => {
    const names = toolNamesFor('claude_sales_agent', false);
    for (const write of [
      'crm_create_company',
      'crm_create_contact',
      'crm_create_deal',
      'crm_add_note',
      'crm_add_call_summary',
      'crm_create_followup',
      'crm_update_next_step',
      'crm_update_deal_stage',
    ]) {
      expect(names).not.toContain(write);
    }
  });

  it('exposes the ten read tools plus duplicates/outreach and the sales tools', () => {
    const names = toolNamesFor('claude_sales_agent', false);
    for (const read of [
      'crm_search_companies',
      'crm_get_company',
      'crm_search_contacts',
      'crm_get_contact',
      'crm_search_deals',
      'crm_get_deal',
      'crm_get_overdue_followups',
      'crm_get_deals_without_next_action',
      'crm_get_stale_deals',
      'crm_get_sales_summary',
      'crm_find_duplicates',
      'crm_prepare_outreach',
      'sales_get_available_work',
      'sales_claim_account',
      'sales_release_account',
      'sales_complete_assignment',
      'sales_transfer_account',
      'sales_get_my_assignments',
      'sales_get_agent_metrics',
    ]) {
      expect(names).toContain(read);
    }
  });

  it('registers write tools when the flag is on', () => {
    const names = toolNamesFor('claude_sales_agent', true);
    expect(names).toContain('crm_create_company');
    expect(names).toContain('crm_update_deal_stage');
  });
});

import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { harness } from './helpers/fixtures.js';

/**
 * End-to-end over a real MCP transport: the client sees exactly what an agent
 * would see through Claude Code or Codex.
 */
async function connect(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  const server = createMcpServer(h.ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server, h };
}

describe('MCP server (integration)', () => {
  it('lists read and sales tools but no write tools in read-only mode', async () => {
    const { client, server } = await connect({ writeEnabled: false });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain('crm_search_companies');
    expect(names).toContain('sales_claim_account');
    expect(names.filter((n) => n.startsWith('crm_create'))).toHaveLength(0);
    expect(names).not.toContain('crm_update_deal_stage');
    await server.close();
  });

  it('exposes write tools once the flag is on', async () => {
    const { client, server } = await connect({ writeEnabled: true });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('crm_create_company');
    expect(names).toContain('crm_add_call_summary');
    await server.close();
  });

  it('executes a read tool and returns normalised JSON', async () => {
    const { client, server } = await connect();
    const result = await client.callTool({
      name: 'crm_get_deal',
      arguments: { deal_id: 100 },
    });
    const payload = JSON.parse((result.content as any)[0].text);
    expect(payload.deal.id).toBe(100);
    expect(payload.company.title).toBe('ООО "Арт Багет"');
    await server.close();
  });

  it('returns a structured error envelope instead of throwing', async () => {
    const { client, server } = await connect();
    const result = await client.callTool({
      name: 'crm_get_company',
      arguments: { company_id: 4242 },
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content as any)[0].text);
    expect(payload.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(payload)).not.toContain('bitrix24.ru/rest');
    await server.close();
  });

  it('rejects an unknown tool name', async () => {
    const { client, server } = await connect();
    const result = await client.callTool({ name: 'bitrix_call', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toMatch(/not found/i);
    await server.close();
  });

  it('drives a full claim → work → complete cycle for one agent', async () => {
    const { client, server, h } = await connect({ agentId: 'claude_sales_agent' });

    const claim = JSON.parse(
      (
        (await client.callTool({
          name: 'sales_claim_account',
          arguments: {
            entity_type: 'company',
            entity_id: 1,
            reason: 'первичная квалификация',
            idempotency_key: 'integration-claim-1',
          },
        })) as any
      ).content[0].text,
    );
    expect(claim.assignment.assigned_agent).toBe('claude_sales_agent');

    const mine = JSON.parse(
      ((await client.callTool({ name: 'sales_get_my_assignments', arguments: {} })) as any)
        .content[0].text,
    );
    expect(mine.count).toBe(1);

    const done = JSON.parse(
      (
        (await client.callTool({
          name: 'sales_complete_assignment',
          arguments: {
            assignment_id: claim.assignment.id,
            result: 'qualified',
            metrics: { next_actions_created: 1, tokens_used: 4200 },
          },
        })) as any
      ).content[0].text,
    );
    expect(done.status).toBe('completed');
    expect(done.metrics.tokens_used).toBe(4200);

    const tools = h.sink.entries.map((e) => e.tool);
    expect(tools).toContain('sales_claim_account');
    expect(tools).toContain('sales_complete_assignment');
    await server.close();
  });

  it('stops the second agent from claiming an account already held', async () => {
    const first = await connect({ agentId: 'claude_sales_agent' });
    await first.client.callTool({
      name: 'sales_claim_account',
      arguments: {
        entity_type: 'deal',
        entity_id: 100,
        reason: 'работа',
        idempotency_key: 'integration-claim-2',
      },
    });

    // Same shared state, different identity.
    const server2 = createMcpServer({ ...first.h.ctx, identity: { agentId: 'codex_sales_agent', via: 'bearer' } });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client2 = new Client({ name: 'codex', version: '1.0.0' });
    await Promise.all([client2.connect(ct), server2.connect(st)]);

    const result = await client2.callTool({
      name: 'sales_claim_account',
      arguments: {
        entity_type: 'deal',
        entity_id: 100,
        reason: 'тоже хочу',
        idempotency_key: 'integration-claim-3',
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as any)[0].text).error.code).toBe('FORBIDDEN');

    await first.server.close();
    await server2.close();
  });
});

import { MockBitrixClient, emptyFixtures, type MockFixtures } from '../mocks/bitrix-mock.js';
import { buildToolContext, type ToolContext } from '../../src/mcp/tools/context.js';
import { buildReadTools, type ReadToolDefinition } from '../../src/mcp/tools/read-tools.js';
import { buildWriteTools } from '../../src/mcp/tools/write-tools.js';
import { buildSalesTools } from '../../src/mcp/tools/sales-tools.js';
import { MemoryAssignmentStore } from '../../src/agents/assignments.js';
import { AuditLog, MemoryAuditSink } from '../../src/audit/audit-log.js';
import { MemoryIdempotencyStore } from '../../src/services/idempotency-service.js';
import { testEnv } from './env.js';
import type { AgentId } from '../../src/agents/roles.js';

export const NOW = new Date('2026-07-24T12:00:00.000Z');

export function sampleFixtures(): MockFixtures {
  return {
    ...emptyFixtures(),
    companies: [
      {
        id: 1,
        title: 'ООО "Арт Багет"',
        assignedById: 5,
        addressCity: 'Москва',
        phone: [{ VALUE: '+7 916 111-22-33', VALUE_TYPE: 'WORK' }],
        email: [{ VALUE: 'buyer@artbaget.ru', VALUE_TYPE: 'WORK' }],
        webUrl: 'https://artbaget.ru',
        createdTime: '2025-01-10T09:00:00+03:00',
        updatedTime: '2026-06-01T09:00:00+03:00',
      },
      {
        id: 2,
        title: 'GALACENTER',
        assignedById: 6,
        addressCity: 'Санкт-Петербург',
        phone: [{ VALUE: '+7 495 663-39-62', VALUE_TYPE: 'WORK' }],
        email: [],
        createdTime: '2025-02-10T09:00:00+03:00',
        updatedTime: '2026-05-01T09:00:00+03:00',
      },
    ],
    contacts: [
      {
        id: 10,
        name: 'Ольга',
        lastName: 'Филатова',
        post: 'Закупки',
        companyId: 1,
        assignedById: 5,
        phone: [{ VALUE: '+7 916 111-22-33', VALUE_TYPE: 'WORK' }],
        email: [{ VALUE: 'buyer@artbaget.ru', VALUE_TYPE: 'WORK' }],
        createdTime: '2025-01-10T09:00:00+03:00',
      },
    ],
    deals: [
      {
        id: 100,
        title: 'Холсты, первая партия',
        categoryId: 0,
        stageId: 'C0:NEW',
        opportunity: 120000,
        currencyId: 'RUB',
        companyId: 1,
        contactId: 10,
        contactIds: [10],
        assignedById: 5,
        createdTime: '2026-05-01T09:00:00+03:00',
        updatedTime: '2026-05-20T09:00:00+03:00',
        movedTime: '2026-05-02T09:00:00+03:00',
        closed: 'N',
      },
      {
        id: 101,
        title: 'Повторная поставка',
        categoryId: 0,
        stageId: 'C0:PREPARATION',
        opportunity: 80000,
        currencyId: 'RUB',
        companyId: 2,
        contactIds: [],
        assignedById: 6,
        createdTime: '2026-07-01T09:00:00+03:00',
        updatedTime: '2026-07-10T09:00:00+03:00',
        movedTime: '2026-07-20T09:00:00+03:00',
        closed: 'N',
      },
    ],
    activities: [
      {
        ID: 500,
        OWNER_ID: 100,
        OWNER_TYPE_ID: 2,
        TYPE_ID: 2,
        SUBJECT: 'Звонок по образцам',
        COMPLETED: 'N',
        DIRECTION: 2,
        RESPONSIBLE_ID: 5,
        CREATED: '2026-06-01T09:00:00+03:00',
        DEADLINE: '2026-06-10T09:00:00+03:00',
      },
    ],
    tasks: [
      {
        id: 900,
        title: 'Отправить прайс',
        deadline: '2026-06-15T09:00:00+03:00',
        responsibleId: 5,
        status: 2,
        ufCrmTask: ['D_100'],
        createdDate: '2026-06-01T09:00:00+03:00',
      },
    ],
    duplicates: {
      '+79161112233': { COMPANY: [1], CONTACT: [10] },
      'buyer@artbaget.ru': { COMPANY: [1], CONTACT: [10] },
    },
  };
}

export interface TestHarness {
  ctx: ToolContext;
  client: MockBitrixClient;
  sink: MemoryAuditSink;
  tools: Map<string, ReadToolDefinition>;
  call: (name: string, args: Record<string, unknown>) => Promise<any>;
}

export function harness(
  options: {
    agentId?: AgentId;
    writeEnabled?: boolean;
    fixtures?: MockFixtures;
    envOverrides?: Record<string, string>;
  } = {},
): TestHarness {
  const writeEnabled = options.writeEnabled ?? false;
  const env = testEnv({
    WRITE_ENABLED: writeEnabled ? 'true' : 'false',
    ...options.envOverrides,
  });
  const client = new MockBitrixClient(options.fixtures ?? sampleFixtures(), writeEnabled);
  const sink = new MemoryAuditSink();

  const ctx = buildToolContext({
    client,
    env,
    identity: { agentId: options.agentId ?? 'claude_sales_agent', via: 'bearer' },
    assignments: new MemoryAssignmentStore(),
    audit: new AuditLog(sink),
    idempotencyStore: new MemoryIdempotencyStore(),
    now: () => NOW,
  });

  const definitions = [
    ...buildReadTools(ctx),
    ...buildSalesTools(ctx),
    ...(writeEnabled ? buildWriteTools(ctx) : []),
  ];
  const tools = new Map(definitions.map((t) => [t.name, t]));

  return {
    ctx,
    client,
    sink,
    tools,
    call: async (name, args) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} is not registered`);
      const parsed = parseArgs(tool, args);
      return tool.handler(parsed);
    },
  };
}

/** Apply the tool's Zod shape so defaults and validation behave as on the wire. */
function parseArgs(tool: ReadToolDefinition, args: Record<string, unknown>): unknown {
  const shape = tool.schema as Record<string, { parse: (v: unknown) => unknown }>;
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(shape)) {
    const value = args[key];
    const parsed = (schema as any).safeParse(value);
    if (!parsed.success) {
      if (value === undefined) continue;
      throw new Error(`Invalid argument "${key}": ${parsed.error.issues[0]?.message}`);
    }
    if (parsed.data !== undefined) out[key] = parsed.data;
  }
  return out;
}

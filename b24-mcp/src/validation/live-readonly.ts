import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadEnv, describeConfig, type Env } from '../config/env.js';
import { isEntrypoint } from '../config/entrypoint.js';
import { HttpBitrixClient, type BitrixClient } from '../bitrix/client.js';
import { LegacyTasksApi, V3TasksApi, type TasksApiMode } from '../bitrix/tasks.js';
import { buildToolContext } from '../mcp/tools/context.js';
import { buildReadTools } from '../mcp/tools/read-tools.js';
import { buildWriteTools } from '../mcp/tools/write-tools.js';
import { identityFromEnv, registerAgentSecrets } from '../agents/roles.js';
import { logger, setLogLevel } from '../security/logger.js';
import { DomainError } from '../domain/errors.js';
import { redactValue } from '../security/redaction.js';
import { anonymize } from './anonymize.js';

/**
 * Live read-only validation against a TEST Bitrix24 portal.
 *
 * Hard guarantees of this runner:
 *  - it refuses to start unless WRITE_ENABLED=false;
 *  - it only ever calls read tools; write tools are asserted to be absent;
 *  - nothing is created, updated or deleted;
 *  - the webhook URL and tokens never reach the report, the fixtures or stdout.
 *
 * Run:  npm run validate:live
 */

export interface ProbeResult {
  id: string;
  group: string;
  description: string;
  status: 'ok' | 'failed' | 'skipped';
  /** Short, secret-free observation worth recording in the report. */
  note?: string;
  errorCode?: string;
  errorMessage?: string;
  durationMs: number;
  /** Shape summary — keys and types, never values. */
  shape?: unknown;
  count?: number;
}

export interface ValidationReport {
  generated_at: string;
  portal: 'test';
  config: Record<string, unknown>;
  tasks_api: {
    legacy: 'ok' | 'failed' | 'skipped';
    v3: 'ok' | 'failed' | 'skipped';
    confirmed_mode: TasksApiMode | null;
    notes: string[];
  };
  probes: ProbeResult[];
  summary: { total: number; ok: number; failed: number; skipped: number };
}

/** Structure of a value: keys and types only, so no data leaks into the report. */
export function shapeOf(value: unknown, depth = 0): unknown {
  if (depth > 4) return '…';
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0], depth + 1)];
  if (typeof value !== 'object') return typeof value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
    out[k] = shapeOf(v, depth + 1);
  }
  return out;
}

class Runner {
  readonly probes: ProbeResult[] = [];
  readonly fixtures = new Map<string, unknown>();

  async run(
    id: string,
    group: string,
    description: string,
    fn: () => Promise<{ note?: string; sample?: unknown; count?: number }>,
  ): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const { note, sample, count } = await fn();
      const probe: ProbeResult = {
        id,
        group,
        description,
        status: 'ok',
        durationMs: Date.now() - started,
        ...(note ? { note } : {}),
        ...(sample !== undefined ? { shape: shapeOf(sample) } : {}),
        ...(count !== undefined ? { count } : {}),
      };
      if (sample !== undefined) this.fixtures.set(id, anonymize(sample));
      this.probes.push(probe);
      logger.info(`probe ok: ${id}`, { group, ms: probe.durationMs });
      return probe;
    } catch (err) {
      const domain = err instanceof DomainError ? err : null;
      const probe: ProbeResult = {
        id,
        group,
        description,
        status: 'failed',
        durationMs: Date.now() - started,
        errorCode: domain?.code ?? 'UNKNOWN',
        errorMessage: String(redactValue(err instanceof Error ? err.message : 'unknown error')),
      };
      this.probes.push(probe);
      logger.warn(`probe failed: ${id}`, { group, code: probe.errorCode });
      return probe;
    }
  }

  /**
   * Negative probe: the call is EXPECTED to be rejected. It passes when the
   * gateway raises an error (optionally with a specific domain code) and fails
   * only if the call unexpectedly succeeds.
   */
  async expectError(
    id: string,
    group: string,
    description: string,
    fn: () => Promise<unknown>,
    wantCode?: string,
  ): Promise<ProbeResult> {
    const started = Date.now();
    try {
      await fn();
      const probe: ProbeResult = {
        id,
        group,
        description,
        status: 'failed',
        durationMs: Date.now() - started,
        note: 'Ожидалась ошибка, но запрос прошёл',
      };
      this.probes.push(probe);
      return probe;
    } catch (err) {
      const code = err instanceof DomainError ? err.code : 'UNKNOWN';
      const ok = !wantCode || code === wantCode;
      const probe: ProbeResult = {
        id,
        group,
        description,
        status: ok ? 'ok' : 'failed',
        durationMs: Date.now() - started,
        errorCode: code,
        note: ok ? `Отклонено как и ожидалось (${code})` : `Ожидался ${wantCode}, получен ${code}`,
      };
      this.probes.push(probe);
      logger.info(`probe ok (expected error): ${id}`, { group, code });
      return probe;
    }
  }

  skip(id: string, group: string, description: string, note: string): void {
    this.probes.push({ id, group, description, status: 'skipped', note, durationMs: 0 });
  }
}

export async function validateLive(env: Env, client: BitrixClient): Promise<{
  report: ValidationReport;
  fixtures: Map<string, unknown>;
}> {
  if (env.WRITE_ENABLED) {
    throw new DomainError(
      'FORBIDDEN',
      'Live validation refuses to run with WRITE_ENABLED=true — set it to false',
    );
  }

  const ctx = buildToolContext({ client, env, identity: identityFromEnv(env) });
  const tools = new Map(buildReadTools(ctx).map((t) => [t.name, t]));
  const runner = new Runner();

  // Guard: the write toolset must not be reachable in this run.
  await runner.run('guard.write_tools_absent', 'guard', 'Write tools are not registered', async () => {
    if (env.WRITE_ENABLED) throw new DomainError('FORBIDDEN', 'WRITE_ENABLED must be false');
    const writeNames = buildWriteTools(ctx).map((t) => t.name);
    for (const name of writeNames) {
      if (tools.has(name)) throw new DomainError('FORBIDDEN', `Write tool ${name} is reachable`);
    }
    return { note: `${writeNames.length} write tools built but none registered` };
  });

  /* ---------------------------- service account ---------------------------- */

  await runner.run('rights.profile', 'rights', 'Service user identity and rights', async () => {
    const profile = await client.call<Record<string, unknown>>('profile');
    return {
      note: `user id ${profile?.ID ?? '?'}, admin=${profile?.ADMIN ?? 'n/a'}`,
      sample: profile,
    };
  });

  await runner.run('rights.crm_fields', 'rights', 'crm scope readable (crm.item.fields)', async () => {
    const fields = await client.call<Record<string, unknown>>('crm.item.fields', {
      entityTypeId: 4,
    });
    const names = Object.keys((fields?.fields as object) ?? fields ?? {});
    const uf = names.filter((n) => /^(uf|UF_)/i.test(n));
    return {
      note: `${names.length} company fields, ${uf.length} custom`,
      sample: { fieldNames: names.slice(0, 20), customCount: uf.length },
    };
  });

  // tasks.task.field.list exists only over the REST v3 endpoint; calling it
  // over the classic webhook returns ERROR_METHOD_NOT_FOUND.
  await runner.run('rights.tasks_fields', 'rights', 'tasks scope readable (tasks.task.field.list, v3)', async () => {
    const fields = await client.call<unknown>(
      'tasks.task.field.list',
      { select: ['name', 'type', 'filterable', 'sortable'] },
      { api: 'v3' },
    );
    return { note: 'tasks scope available (v3 field list)', sample: fields };
  });

  /* ------------------------------- discovery ------------------------------- */

  let companyId: number | null = null;
  let contactId: number | null = null;
  let dealId: number | null = null;

  await runner.run('discover.companies', 'discovery', 'Read a page of companies', async () => {
    const page = await client.callList<Record<string, unknown>>('crm.item.list', {
      entityTypeId: 4,
      select: ['id', 'title', 'phone', 'email', 'addressCity', 'assignedById'],
      order: { id: 'ASC' },
      start: 0,
    });
    companyId = page.result[0] ? Number(page.result[0].id) : null;
    return {
      note: `total=${page.total ?? 'n/a'}, next=${page.next ?? 'none'}`,
      sample: page.result[0] ?? null,
      count: page.result.length,
    };
  });

  await runner.run('discover.contacts', 'discovery', 'Read a page of contacts', async () => {
    const page = await client.callList<Record<string, unknown>>('crm.item.list', {
      entityTypeId: 3,
      select: ['id', 'name', 'lastName', 'phone', 'email', 'companyId'],
      order: { id: 'ASC' },
      start: 0,
    });
    contactId = page.result[0] ? Number(page.result[0].id) : null;
    return { sample: page.result[0] ?? null, count: page.result.length };
  });

  await runner.run('discover.deals', 'discovery', 'Read a page of deals', async () => {
    const page = await client.callList<Record<string, unknown>>('crm.item.list', {
      entityTypeId: 2,
      select: ['id', 'title', 'stageId', 'companyId', 'movedTime', 'opportunity'],
      order: { id: 'ASC' },
      start: 0,
    });
    dealId = page.result[0] ? Number(page.result[0].id) : null;
    return { sample: page.result[0] ?? null, count: page.result.length };
  });

  /* ------------------------------ pagination ------------------------------- */

  await runner.run('paging.crm_item_list', 'pagination', 'crm.item.list page size and next', async () => {
    const first = await client.callList<Record<string, unknown>>('crm.item.list', {
      entityTypeId: 4,
      select: ['id'],
      order: { id: 'ASC' },
      start: 0,
    });
    const second =
      first.next !== undefined
        ? await client.callList<Record<string, unknown>>('crm.item.list', {
            entityTypeId: 4,
            select: ['id'],
            order: { id: 'ASC' },
            start: first.next,
          })
        : null;
    const overlap =
      second === null
        ? 'n/a'
        : String(
            first.result.some((a) => second.result.some((b) => String(a.id) === String(b.id))),
          );
    return {
      note: `page=${first.result.length}, next=${first.next ?? 'none'}, overlap=${overlap}`,
      count: first.result.length,
    };
  });

  /* ------------------------------ empty result ----------------------------- */

  await runner.run('empty.crm_item_list', 'edge', 'Filter that matches nothing', async () => {
    const page = await client.callList<Record<string, unknown>>('crm.item.list', {
      entityTypeId: 4,
      select: ['id'],
      filter: { id: 999_999_999 },
    });
    return {
      note: `rows=${page.result.length}, total=${String(page.total)}, next=${String(page.next)}`,
      sample: page,
      count: page.result.length,
    };
  });

  await runner.run('unknown_field.crm_item_list', 'edge', 'Select a field that does not exist', async () => {
    const page = await client.callList<Record<string, unknown>>('crm.item.list', {
      entityTypeId: 4,
      select: ['id', 'zzzNonExistentField'],
      filter: {},
    });
    return {
      note: `accepted unknown select field, rows=${page.result.length}`,
      sample: page.result[0] ?? null,
    };
  });

  // Bitrix rejects an unknown filter field (INVALID_ARG_VALUE → INVALID_REQUEST)
  // rather than silently ignoring it — a rejection is the expected outcome.
  await runner.expectError(
    'unknown_filter.crm_item_list',
    'edge',
    'Filter by a field that does not exist is rejected',
    () =>
      client.callList('crm.item.list', {
        entityTypeId: 4,
        select: ['id'],
        filter: { zzzNonExistentField: 'x' },
      }),
    'INVALID_REQUEST',
  );

  /* --------------------------- tasks: two dialects -------------------------- */

  const tasksNotes: string[] = [];
  const legacyApi = new LegacyTasksApi(client);
  const v3Api = new V3TasksApi(client);

  const legacyProbe = await runner.run(
    'tasks.legacy.list',
    'tasks',
    'tasks.task.list — classic object filter, start paging',
    async () => {
      const page = await legacyApi.list({ openOnly: true });
      return {
        note: `rows=${page.items.length}, total=${String(page.total)}, next=${String(page.nextOffset)}`,
        sample: page.items[0] ?? null,
        count: page.items.length,
      };
    },
  );

  // v3 filters only accept fields flagged Filterable; `status` is not, so the
  // openOnly variant (which filters by status) is probed separately as a known
  // limitation. This probe proves the endpoint + pagination with no filter.
  const v3Probe = await runner.run(
    'tasks.v3.list',
    'tasks',
    'tasks.task.list — REST v3 endpoint, pagination object, no status filter',
    async () => {
      const page = await v3Api.list({});
      return {
        note: `rows=${page.items.length}, total=${String(page.total)}, next=${String(page.nextOffset)}`,
        sample: page.items[0] ?? null,
        count: page.items.length,
      };
    },
  );

  await runner.run('tasks.legacy.raw_envelope', 'tasks', 'Classic response envelope', async () => {
    const raw = await client.call<unknown>('tasks.task.list', {
      select: ['ID', 'TITLE', 'DEADLINE', 'STATUS'],
      filter: { '@STATUS': [1, 2, 3] },
      start: 0,
    });
    return { note: `envelope keys: ${Object.keys((raw as object) ?? {}).join(', ')}`, sample: raw };
  });

  await runner.run('tasks.v3.raw_envelope', 'tasks', 'REST v3 response envelope', async () => {
    const raw = await client.call<unknown>(
      'tasks.task.list',
      { select: ['id', 'title', 'deadline', 'status'], pagination: { limit: 5, offset: 0 } },
      { api: 'v3' },
    );
    const root = (raw as Record<string, unknown>)?.result ?? raw;
    return {
      note: `envelope keys: ${Object.keys((root as object) ?? {}).join(', ')}`,
      sample: raw,
    };
  });

  await runner.run('tasks.v3.pagination', 'tasks', 'REST v3 pagination limit/offset', async () => {
    const first = await v3Api.list({ offset: 0 });
    const second = await v3Api.list({ offset: first.items.length });
    const overlap = first.items.some((a) => second.items.some((b) => a.id === b.id));
    return { note: `first=${first.items.length}, second=${second.items.length}, overlap=${overlap}` };
  });

  // v3 filtering is restricted to Filterable-flagged fields. `status` is not
  // filterable on this portal, so an openOnly query over v3 is rejected —
  // documented so TASKS_API_MODE=v3 users know open-task filtering needs a
  // Filterable field (or client-side filtering).
  await runner.expectError(
    'tasks.v3.status_not_filterable',
    'tasks',
    'REST v3 rejects filtering open tasks by status (not Filterable)',
    () => v3Api.list({ openOnly: true }),
    'INVALID_REQUEST',
  );

  await runner.expectError(
    'tasks.v3.bad_pagination',
    'tasks',
    'REST v3 rejects a bad pagination value',
    () =>
      client.call('tasks.task.list', { select: ['id'], pagination: { limit: 'many' } }, { api: 'v3' }),
  );

  await runner.expectError(
    'tasks.v3.unfilterable_field',
    'tasks',
    'REST v3 rejects a filter on an unknown field',
    () =>
      client.call('tasks.task.list', { select: ['id'], filter: [['zzzNope', 'x']] }, { api: 'v3' }),
    'INVALID_REQUEST',
  );

  await runner.run('tasks.legacy.unknown_field', 'tasks', 'Classic filter on an unknown field', async () => {
    const raw = await client.call<unknown>('tasks.task.list', {
      select: ['ID'],
      filter: { ZZZ_NON_EXISTENT: 'x' },
    });
    return { note: `envelope keys: ${Object.keys((raw as object) ?? {}).join(', ')}`, sample: raw };
  });

  if (legacyProbe.status === 'ok') tasksNotes.push('Классический контракт (webhook) отвечает.');
  else tasksNotes.push(`Классический контракт не отвечает: ${legacyProbe.errorCode}.`);
  if (v3Probe.status === 'ok') {
    tasksNotes.push('REST v3 endpoint отвечает; фильтрация — только по Filterable-полям (status не фильтруется).');
  } else {
    tasksNotes.push(`REST v3 endpoint не отвечает: ${v3Probe.errorCode}.`);
  }

  // Default to the dialect the domain uses out of the box (status filtering
  // works over legacy without caveats).
  const confirmedMode: TasksApiMode | null =
    legacyProbe.status === 'ok' ? 'legacy' : v3Probe.status === 'ok' ? 'v3' : null;

  /* ------------------------------- read tools ------------------------------ */

  const toolPlan: Array<{ name: string; args: () => Record<string, unknown> | null }> = [
    { name: 'crm_search_companies', args: () => ({ query: 'ООО', limit: 5, offset: 0 }) },
    { name: 'crm_get_company', args: () => (companyId ? { company_id: companyId, activities_limit: 5 } : null) },
    { name: 'crm_search_contacts', args: () => ({ query: 'ова', limit: 5, offset: 0 }) },
    { name: 'crm_get_contact', args: () => (contactId ? { contact_id: contactId, activities_limit: 5 } : null) },
    { name: 'crm_search_deals', args: () => ({ only_open: true, limit: 5, offset: 0 }) },
    { name: 'crm_get_deal', args: () => (dealId ? { deal_id: dealId, activities_limit: 5 } : null) },
    { name: 'crm_get_overdue_followups', args: () => ({ limit: 10 }) },
    { name: 'crm_get_deals_without_next_action', args: () => ({ limit: 10 }) },
    { name: 'crm_get_stale_deals', args: () => ({ threshold_days: 14, limit: 10 }) },
    { name: 'crm_get_sales_summary', args: () => ({ inactivity_days: 14, limit: 10 }) },
    { name: 'crm_find_duplicates', args: () => ({ phones: ['+7 999 000-00-01'], emails: [], title: undefined }) },
    { name: 'crm_prepare_outreach', args: () => (companyId ? { company_id: companyId } : null) },
  ];

  for (const entry of toolPlan) {
    const tool = tools.get(entry.name);
    if (!tool) {
      runner.skip(`tool.${entry.name}`, 'tools', entry.name, 'Инструмент не зарегистрирован');
      continue;
    }
    const args = entry.args();
    if (args === null) {
      runner.skip(
        `tool.${entry.name}`,
        'tools',
        entry.name,
        'Нет подходящей тестовой сущности на портале',
      );
      continue;
    }
    await runner.run(`tool.${entry.name}`, 'tools', entry.name, async () => {
      const parsed = parseWithShape(tool.schema, args);
      const result = await tool.handler(parsed);
      return { sample: result, count: countOf(result) };
    });
  }

  // Empty-result behaviour at the tool layer, not just at the REST layer.
  const searchTool = tools.get('crm_search_companies');
  if (searchTool) {
    await runner.run('tool.crm_search_companies.empty', 'tools', 'Search with no matches', async () => {
      const parsed = parseWithShape(searchTool.schema, {
        query: 'zzz-нет-такой-компании-zzz',
        limit: 5,
        offset: 0,
      });
      const result = await searchTool.handler(parsed);
      return { note: `items=${countOf(result) ?? 0}`, sample: result };
    });
  }

  const summary = {
    total: runner.probes.length,
    ok: runner.probes.filter((p) => p.status === 'ok').length,
    failed: runner.probes.filter((p) => p.status === 'failed').length,
    skipped: runner.probes.filter((p) => p.status === 'skipped').length,
  };

  const report: ValidationReport = {
    generated_at: new Date().toISOString(),
    portal: 'test',
    config: describeConfig(env),
    tasks_api: {
      legacy: legacyProbe.status,
      v3: v3Probe.status,
      confirmed_mode: confirmedMode,
      notes: tasksNotes,
    },
    probes: runner.probes,
    summary,
  };

  return { report, fixtures: runner.fixtures };
}

function countOf(result: unknown): number | undefined {
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items.length;
    if (typeof obj.count === 'number') return obj.count;
  }
  return undefined;
}

/** Apply a tool's Zod shape so defaults and validation match the wire path. */
function parseWithShape(shape: Record<string, unknown>, args: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(shape)) {
    const parsed = (schema as { safeParse: (v: unknown) => any }).safeParse(args[key]);
    if (!parsed.success) {
      if (args[key] === undefined) continue;
      throw new DomainError('INVALID_REQUEST', `Invalid probe argument "${key}"`);
    }
    if (parsed.data !== undefined) out[key] = parsed.data;
  }
  return out;
}

export async function writeValidationArtifacts(
  report: ValidationReport,
  fixtures: Map<string, unknown>,
  outDir: string,
  fixtureDir: string,
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await mkdir(fixtureDir, { recursive: true });

  await writeFile(join(outDir, 'live-validation-report.json'), JSON.stringify(report, null, 2), 'utf8');

  for (const [id, value] of fixtures) {
    const file = join(fixtureDir, `${id.replace(/[^\w.-]/g, '_')}.json`);
    await writeFile(file, JSON.stringify(value, null, 2), 'utf8');
  }

  await writeFile(join(fixtureDir, 'index.json'), JSON.stringify([...fixtures.keys()], null, 2), 'utf8');
}

export async function main(): Promise<void> {
  const env = loadEnv();
  setLogLevel(env.LOG_LEVEL);
  registerAgentSecrets(env);

  const client = new HttpBitrixClient({ env });
  const { report, fixtures } = await validateLive(env, client);

  await writeValidationArtifacts(
    report,
    fixtures,
    resolve('data/validation'),
    resolve('tests/fixtures/live'),
  );

  process.stdout.write(
    JSON.stringify(
      {
        summary: report.summary,
        tasks_api: report.tasks_api,
        failed: report.probes.filter((p) => p.status === 'failed').map((p) => ({
          id: p.id,
          code: p.errorCode,
        })),
      },
      null,
      2,
    ) + '\n',
  );
}

if (isEntrypoint(import.meta.url)) {
  main().catch((err: unknown) => {
    logger.error('live validation failed', {
      message: err instanceof Error ? err.message : 'unknown',
    });
    process.exit(1);
  });
}

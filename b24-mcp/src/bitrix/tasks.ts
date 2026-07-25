import type { BitrixClient } from './client.js';
import { asIsoDate, asNumber, asString, pick, type RawItem } from './field-map.js';
import { isOverdue, type NextAction } from '../domain/activity.js';
import { loadEnv } from '../config/env.js';

/**
 * Tasks access with two interchangeable dialects.
 *
 * The Bitrix24 documentation for `tasks.task.list` now describes the REST v3
 * contract (array filters, `pagination` object, rows under `result.items`),
 * while inbound webhooks have long served the classic contract (object filters
 * with comparison prefixes, `start` paging, rows under `tasks`). Which one a
 * given portal answers is a portal-level fact, not something to guess — so the
 * dialect is selected by `TASKS_API_MODE` and both are implemented here.
 *
 * Statuses: 1 new, 2 pending, 3 in progress, 4 supposedly complete,
 * 5 completed, 6 deferred, 7 declined. "Open" = anything below 5, plus 6.
 */
export const OPEN_STATUSES = [1, 2, 3, 4, 6];

const LEGACY_SELECT = [
  'ID',
  'TITLE',
  'DEADLINE',
  'RESPONSIBLE_ID',
  'STATUS',
  'UF_CRM_TASK',
  'CREATED_DATE',
];

/**
 * v3 TaskDto field names (verified against a live portal via
 * tasks.task.field.list): CRM binding is `crmItemIds` (not `ufCrmTask`), the
 * creation timestamp is `created` (not `createdDate`).
 *
 * NOTE on filtering: on the validated portal only `id` is Filterable in v3.
 * `status` and CRM bindings cannot be used in a v3 filter, so open-task and
 * per-deal queries are not expressible over v3 — use TASKS_API_MODE=legacy for
 * this workload. v3 remains wired for portals that expose more Filterable
 * fields, and for id/pagination-based reads.
 */
const V3_SELECT = ['id', 'title', 'deadline', 'responsibleId', 'status', 'crmItemIds', 'created'];

export interface Task {
  id: number;
  title: string;
  deadlineAt: string | null;
  responsibleId: number | null;
  status: number | null;
  /** CRM bindings such as "D_42" (deal 42), "CO_7" (company 7), "C_3" (contact). */
  crmBindings: string[];
  createdAt: string | null;
}

export function mapTask(raw: RawItem): Task {
  // legacy: ufCrmTask = ["D_100", …]; v3: crmItemIds = [100, …] (no prefix).
  const bindings = pick(raw, 'ufCrmTask', 'UF_CRM_TASK', 'crmItemIds');
  return {
    id: Number(pick(raw, 'id', 'ID') ?? 0),
    title: asString(pick(raw, 'title', 'TITLE')) ?? '(без названия)',
    deadlineAt: asIsoDate(pick(raw, 'deadline', 'DEADLINE')),
    responsibleId: asNumber(pick(raw, 'responsibleId', 'RESPONSIBLE_ID')),
    status: asNumber(pick(raw, 'status', 'STATUS')),
    crmBindings: Array.isArray(bindings) ? bindings.map(String) : [],
    createdAt: asIsoDate(pick(raw, 'createdDate', 'CREATED_DATE', 'created')),
  };
}

/** Bitrix CRM binding prefix for each entity kind. */
export const CRM_BINDING_PREFIX = {
  lead: 'L_',
  deal: 'D_',
  contact: 'C_',
  company: 'CO_',
} as const;

export function crmBinding(kind: keyof typeof CRM_BINDING_PREFIX, id: number): string {
  return `${CRM_BINDING_PREFIX[kind]}${id}`;
}

/* ------------------------------- dialects -------------------------------- */

export type TasksApiMode = 'legacy' | 'v3';

/** Dialect-independent description of what the domain needs. */
export interface TaskQuery {
  openOnly?: boolean;
  responsibleId?: number;
  /** Deadline strictly before this instant. */
  deadlineBefore?: Date;
  /** Exclude tasks without any deadline. */
  requireDeadline?: boolean;
  crmBindings?: string[];
  offset?: number;
}

export interface TaskPage {
  items: Task[];
  total: number | null;
  /** Value to pass back as `offset` for the next page, or null at the end. */
  nextOffset: number | null;
  mode: TasksApiMode;
}

export interface TasksApi {
  readonly mode: TasksApiMode;
  list(query: TaskQuery): Promise<TaskPage>;
}

const PAGE_SIZE = 50;

/** Rows can arrive as `{tasks: []}`, `{result: {items: []}}` or a bare array. */
export function unwrapTasks(result: unknown): RawItem[] {
  if (Array.isArray(result)) return result as RawItem[];
  const obj = result as Record<string, unknown> | undefined;
  const candidate = obj?.tasks ?? obj?.items;
  if (Array.isArray(candidate)) return candidate as RawItem[];
  const nested = (obj?.result ?? obj?.data) as Record<string, unknown> | undefined;
  const nestedItems = nested?.items ?? nested?.tasks;
  return Array.isArray(nestedItems) ? (nestedItems as RawItem[]) : [];
}

/** Classic contract: object filter with prefixes, `start` paging. */
export class LegacyTasksApi implements TasksApi {
  readonly mode = 'legacy' as const;

  constructor(private readonly client: BitrixClient) {}

  async list(query: TaskQuery): Promise<TaskPage> {
    const filter: Record<string, unknown> = {};
    if (query.openOnly) filter['@STATUS'] = OPEN_STATUSES;
    if (query.responsibleId !== undefined) filter['RESPONSIBLE_ID'] = query.responsibleId;
    if (query.deadlineBefore) filter['<DEADLINE'] = query.deadlineBefore.toISOString();
    if (query.requireDeadline) filter['!DEADLINE'] = '';
    if (query.crmBindings?.length) {
      filter[query.crmBindings.length === 1 ? 'UF_CRM_TASK' : '@UF_CRM_TASK'] =
        query.crmBindings.length === 1 ? query.crmBindings[0] : query.crmBindings;
    }

    const raw = await this.client.call<unknown>('tasks.task.list', {
      select: LEGACY_SELECT,
      filter,
      order: { DEADLINE: 'ASC' },
      start: query.offset ?? 0,
    });

    const items = unwrapTasks(raw).map(mapTask);
    const total = asNumber((raw as RawItem)?.total ?? null);
    const start = query.offset ?? 0;
    return {
      items,
      total,
      nextOffset: items.length === PAGE_SIZE ? start + PAGE_SIZE : null,
      mode: this.mode,
    };
  }
}

/** REST v3 contract: array conditions, `pagination`, rows under result.items. */
export class V3TasksApi implements TasksApi {
  readonly mode = 'v3' as const;

  constructor(private readonly client: BitrixClient) {}

  async list(query: TaskQuery): Promise<TaskPage> {
    const filter: unknown[] = [];
    if (query.openOnly) filter.push(['status', 'in', OPEN_STATUSES]);
    if (query.responsibleId !== undefined) filter.push(['responsibleId', query.responsibleId]);
    if (query.deadlineBefore) filter.push(['deadline', '<', query.deadlineBefore.toISOString()]);
    if (query.requireDeadline) filter.push(['deadline', '!=', null]);
    if (query.crmBindings?.length) filter.push(['crmItemIds', 'in', query.crmBindings]);

    const offset = query.offset ?? 0;
    const params: Record<string, unknown> = {
      select: V3_SELECT,
      pagination: { limit: PAGE_SIZE, offset },
    };
    // Only send filter/order when non-empty: some portals reject an empty
    // filter array, and only Filterable/Sortable fields are accepted.
    if (filter.length > 0) params.filter = filter;
    const raw = await this.client.call<unknown>('tasks.task.list', params, { api: 'v3' });

    const items = unwrapTasks(raw).map(mapTask);
    const total = asNumber((raw as RawItem)?.total ?? null);
    return {
      items,
      total,
      nextOffset: items.length === PAGE_SIZE ? offset + PAGE_SIZE : null,
      mode: this.mode,
    };
  }
}

export function createTasksApi(client: BitrixClient, mode?: TasksApiMode): TasksApi {
  const selected = mode ?? loadEnv().TASKS_API_MODE;
  return selected === 'v3' ? new V3TasksApi(client) : new LegacyTasksApi(client);
}

/* ------------------------------ repository -------------------------------- */

export class TaskRepository {
  private readonly api: TasksApi;

  constructor(client: BitrixClient, api?: TasksApi) {
    this.api = api ?? createTasksApi(client);
  }

  get mode(): TasksApiMode {
    return this.api.mode;
  }

  /** Open tasks attached to a CRM record. */
  async openFor(kind: keyof typeof CRM_BINDING_PREFIX, id: number, limit: number): Promise<Task[]> {
    const page = await this.api.list({ openOnly: true, crmBindings: [crmBinding(kind, id)] });
    return page.items.slice(0, limit);
  }

  /** Overdue open tasks, optionally scoped to one manager. */
  async overdue(params: { now: Date; responsibleId?: number; limit: number }): Promise<Task[]> {
    const page = await this.api.list({
      openOnly: true,
      requireDeadline: true,
      deadlineBefore: params.now,
      ...(params.responsibleId !== undefined ? { responsibleId: params.responsibleId } : {}),
    });
    return page.items.slice(0, params.limit);
  }

  /** Open tasks bound to any of the given deals, following pagination. */
  async openForDeals(dealIds: number[], maxItems = 500): Promise<Task[]> {
    if (dealIds.length === 0) return [];
    const bindings = dealIds.map((id) => crmBinding('deal', id));
    const out: Task[] = [];
    let offset = 0;
    for (let page = 0; page < 20 && out.length < maxItems; page++) {
      const result = await this.api.list({ openOnly: true, crmBindings: bindings, offset });
      out.push(...result.items);
      if (result.nextOffset === null) break;
      offset = result.nextOffset;
    }
    return out.slice(0, maxItems);
  }
}

export function taskToNextAction(task: Task, now: Date): NextAction {
  return {
    source: 'task',
    id: task.id,
    title: task.title,
    dueAt: task.deadlineAt,
    responsibleId: task.responsibleId,
    overdue: isOverdue(task.deadlineAt, now),
  };
}

/** Deal id referenced by a task binding, if any. */
export function dealIdFromBindings(bindings: string[]): number | null {
  for (const b of bindings) {
    if (b.startsWith(CRM_BINDING_PREFIX.deal)) {
      const id = Number(b.slice(CRM_BINDING_PREFIX.deal.length));
      if (Number.isFinite(id)) return id;
    }
  }
  return null;
}

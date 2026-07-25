import {
  isReadMethod,
  isV3Method,
  isWriteMethod,
  type AllowedMethod,
  type BitrixClient,
  type BitrixListResponse,
  type CallOptions,
  type ReadMethod,
} from '../../src/bitrix/client.js';
import { DomainError } from '../../src/domain/errors.js';

/**
 * In-memory Bitrix24 double.
 *
 * It enforces the same allowlist as the real adapter, so a test that tries to
 * reach an unlisted method (including any *.delete) fails the same way it would
 * in production.
 */
export interface MockFixtures {
  companies: Record<string, unknown>[];
  contacts: Record<string, unknown>[];
  deals: Record<string, unknown>[];
  activities: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  duplicates: Record<string, { COMPANY?: number[]; CONTACT?: number[]; LEAD?: number[] }>;
}

export const emptyFixtures = (): MockFixtures => ({
  companies: [],
  contacts: [],
  deals: [],
  activities: [],
  tasks: [],
  duplicates: {},
});

export class MockBitrixClient implements BitrixClient {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  private callLog: string[] = [];
  private nextId = 1000;

  constructor(
    public fixtures: MockFixtures = emptyFixtures(),
    private readonly writeEnabled = true,
  ) {}

  drainCallLog(): string[] {
    const log = this.callLog;
    this.callLog = [];
    return log;
  }

  private assertAllowed(method: string, api: 'v1' | 'v3'): void {
    if (api === 'v3' && !isV3Method(method)) {
      throw new DomainError('FORBIDDEN', `Method is not available over the v3 endpoint: ${method}`);
    }
    if (isReadMethod(method)) return;
    if (isWriteMethod(method)) {
      if (!this.writeEnabled) {
        throw new DomainError('WRITE_DISABLED', 'Write operations are disabled on this gateway');
      }
      return;
    }
    throw new DomainError('FORBIDDEN', `REST method is not on the allowlist: ${method}`);
  }

  async call<T = unknown>(
    method: AllowedMethod,
    params: Record<string, unknown> = {},
    options: CallOptions = {},
  ): Promise<T> {
    const api = options.api ?? 'v1';
    this.assertAllowed(method, api);
    this.calls.push({ method, params });
    this.callLog.push(api === 'v3' ? `${method}#v3` : method);

    switch (method) {
      case 'crm.item.get': {
        const rows = this.rowsFor(Number(params.entityTypeId));
        const item = rows.find((r) => Number(r.id) === Number(params.id));
        return { item } as T;
      }
      case 'crm.duplicate.findbycomm': {
        const values = (params.values as string[]) ?? [];
        const hit = values.map((v) => this.fixtures.duplicates[v]).find(Boolean);
        return (hit ?? {}) as T;
      }
      case 'crm.item.add':
      case 'crm.company.add':
      case 'crm.contact.add':
      case 'crm.deal.add':
        return { item: { id: this.nextId++ } } as T;
      case 'crm.item.update':
      case 'crm.deal.update':
        return { item: { id: Number(params.id) } } as T;
      case 'crm.timeline.comment.add':
        return this.nextId++ as T;
      case 'tasks.task.add':
        return { task: { id: this.nextId++ } } as T;
      case 'tasks.task.list': {
        const rows = this.filterTasks(params, api);
        // Mirror the two real envelopes so the adapter's unwrap logic is tested.
        return (api === 'v3' ? { result: { items: rows }, total: rows.length } : { tasks: rows }) as T;
      }
      case 'tasks.task.field.list':
        return { result: { items: [{ name: 'id' }, { name: 'title' }] } } as T;
      default:
        return (await this.callList(method as ReadMethod, params, options)) as T;
    }
  }

  async callList<T = unknown>(
    method: ReadMethod,
    params: Record<string, unknown> = {},
    options: CallOptions = {},
  ): Promise<BitrixListResponse<T>> {
    const api = options.api ?? 'v1';
    this.assertAllowed(method, api);
    this.calls.push({ method, params });
    this.callLog.push(api === 'v3' ? `${method}#v3` : method);

    switch (method) {
      case 'crm.item.list': {
        const rows = this.rowsFor(Number(params.entityTypeId));
        const filtered = applyFilter(rows, (params.filter as Record<string, unknown>) ?? {});
        return { result: filtered as T[], total: filtered.length };
      }
      case 'crm.activity.list': {
        const filtered = applyFilter(
          this.fixtures.activities,
          (params.filter as Record<string, unknown>) ?? {},
        );
        return { result: filtered as T[], total: filtered.length };
      }
      case 'tasks.task.list':
        return { result: this.filterTasks(params, api) as T[] };
      default:
        return { result: [], total: 0 };
    }
  }

  private rowsFor(entityTypeId: number): Record<string, unknown>[] {
    switch (entityTypeId) {
      case 2:
        return this.fixtures.deals;
      case 3:
        return this.fixtures.contacts;
      case 4:
        return this.fixtures.companies;
      default:
        return [];
    }
  }

  private filterTasks(params: Record<string, unknown>, api: 'v1' | 'v3'): Record<string, unknown>[] {
    const objectFilter =
      api === 'v3'
        ? v3FilterToObject((params.filter as unknown[]) ?? [])
        : (params.filter as Record<string, unknown>) ?? {};
    return applyFilter(this.fixtures.tasks, objectFilter);
  }
}

/** Fold a v3 array filter (`[field, op, value]` / `[field, value]`) to an object. */
export function v3FilterToObject(conditions: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const cond of conditions) {
    if (!Array.isArray(cond)) continue;
    if (cond.length === 2) {
      out[String(cond[0])] = cond[1];
    } else if (cond.length === 3) {
      const [field, op, value] = cond as [string, string, unknown];
      const prefix =
        op === 'in' ? '@' : op === '<' ? '<' : op === '>' ? '>' : op === '!=' ? '!' : '';
      out[`${prefix}${field}`] = value;
    }
  }
  return out;
}

/** Minimal re-implementation of the Bitrix filter prefixes used by the code. */
export function applyFilter(
  rows: Record<string, unknown>[],
  filter: Record<string, unknown>,
): Record<string, unknown>[] {
  const entries = Object.entries(filter).filter(([key]) => key !== 'logic');
  const logic = String(filter.logic ?? 'AND').toUpperCase();

  return rows.filter((row) => {
    const results = entries.map(([rawKey, expected]) => {
      const { op, field } = splitKey(rawKey);
      const actual = resolveField(row, field);
      switch (op) {
        case '%':
          return String(actual ?? '')
            .toLowerCase()
            .includes(String(expected).toLowerCase());
        case '@':
          return (expected as unknown[]).map(String).includes(String(actual));
        case '>=':
          return String(actual ?? '') >= String(expected);
        case '<=':
          return String(actual ?? '') <= String(expected);
        case '>':
          return String(actual ?? '') > String(expected);
        case '<':
          return String(actual ?? '') < String(expected);
        case '!':
          return String(actual ?? '') !== String(expected);
        default:
          return String(actual ?? '') === String(expected);
      }
    });
    if (results.length === 0) return true;
    return logic === 'OR' ? results.some(Boolean) : results.every(Boolean);
  });
}

/**
 * Bitrix accepts UPPER_SNAKE filter keys while returning camelCase fields, so
 * the mock resolves names case- and underscore-insensitively.
 */
function resolveField(row: Record<string, unknown>, field: string): unknown {
  if (field in row) return row[field];
  const wanted = field.toLowerCase().replace(/_/g, '');
  for (const [key, value] of Object.entries(row)) {
    if (key.toLowerCase().replace(/_/g, '') === wanted) return value;
  }
  return undefined;
}

function splitKey(key: string): { op: string; field: string } {
  const match = /^(>=|<=|>|<|%|@|!|=)?(.*)$/.exec(key);
  return { op: match?.[1] ?? '', field: match?.[2] ?? key };
}

import type { BitrixClient } from './client.js';
import { asIsoDate, asBool, asNumber, asString, pick, type RawItem } from './field-map.js';
import {
  activityKindFromTypeId,
  ownerTypeFromId,
  OWNER_TYPE_ID,
  type Activity,
} from '../domain/activity.js';

/** crm.activity.* is the classic API: fields are UPPER_SNAKE_CASE. */
const SELECT = [
  'ID',
  'OWNER_ID',
  'OWNER_TYPE_ID',
  'TYPE_ID',
  'SUBJECT',
  'COMPLETED',
  'DIRECTION',
  'RESPONSIBLE_ID',
  'CREATED',
  'DEADLINE',
  'END_TIME',
];

export function mapActivity(raw: RawItem): Activity {
  const direction = asNumber(pick(raw, 'DIRECTION'));
  return {
    id: Number(pick(raw, 'ID') ?? 0),
    kind: activityKindFromTypeId(asNumber(pick(raw, 'TYPE_ID'))),
    subject: asString(pick(raw, 'SUBJECT')) ?? '(без темы)',
    completed: asBool(pick(raw, 'COMPLETED')),
    direction: direction === 1 ? 'incoming' : direction === 2 ? 'outgoing' : null,
    ownerType: ownerTypeFromId(asNumber(pick(raw, 'OWNER_TYPE_ID'))),
    ownerId: asNumber(pick(raw, 'OWNER_ID')),
    responsibleId: asNumber(pick(raw, 'RESPONSIBLE_ID')),
    createdAt: asIsoDate(pick(raw, 'CREATED')),
    deadlineAt: asIsoDate(pick(raw, 'DEADLINE')),
  };
}

export type OwnerKind = keyof typeof OWNER_TYPE_ID;

export class ActivityRepository {
  constructor(private readonly client: BitrixClient) {}

  /** Most recent touchpoints on a record, newest first. */
  async recentFor(owner: OwnerKind, ownerId: number, limit: number): Promise<Activity[]> {
    const response = await this.client.callList<RawItem>('crm.activity.list', {
      select: SELECT,
      filter: { OWNER_TYPE_ID: OWNER_TYPE_ID[owner], OWNER_ID: ownerId },
      order: { CREATED: 'DESC' },
      start: 0,
    });
    return response.result.slice(0, limit).map(mapActivity);
  }

  /** Open (not completed) activities on a record — candidate "next actions". */
  async openFor(owner: OwnerKind, ownerId: number, limit: number): Promise<Activity[]> {
    const response = await this.client.callList<RawItem>('crm.activity.list', {
      select: SELECT,
      filter: { OWNER_TYPE_ID: OWNER_TYPE_ID[owner], OWNER_ID: ownerId, COMPLETED: 'N' },
      order: { DEADLINE: 'ASC' },
      start: 0,
    });
    return response.result.slice(0, limit).map(mapActivity);
  }

  /** All open activities for a set of deals, in one round trip per page. */
  async openForDeals(dealIds: number[], maxItems = 500): Promise<Activity[]> {
    if (dealIds.length === 0) return [];
    const out: Activity[] = [];
    let start = 0;
    for (let page = 0; page < 20 && out.length < maxItems; page++) {
      const response = await this.client.callList<RawItem>('crm.activity.list', {
        select: SELECT,
        filter: {
          OWNER_TYPE_ID: OWNER_TYPE_ID.deal,
          '@OWNER_ID': dealIds,
          COMPLETED: 'N',
        },
        order: { DEADLINE: 'ASC' },
        start,
      });
      out.push(...response.result.map(mapActivity));
      if (response.next === undefined || response.result.length === 0) break;
      start = response.next;
    }
    return out.slice(0, maxItems);
  }

  /** Overdue, still-open activities, optionally scoped to one manager. */
  async overdue(params: {
    now: Date;
    responsibleId?: number;
    limit: number;
  }): Promise<Activity[]> {
    const filter: Record<string, unknown> = {
      COMPLETED: 'N',
      '<DEADLINE': toBitrixDate(params.now),
    };
    if (params.responsibleId !== undefined) filter['RESPONSIBLE_ID'] = params.responsibleId;

    const response = await this.client.callList<RawItem>('crm.activity.list', {
      select: SELECT,
      filter,
      order: { DEADLINE: 'ASC' },
      start: 0,
    });
    return response.result.slice(0, params.limit).map(mapActivity);
  }

  /** Ids of deals that saw any activity since `since`. */
  async dealIdsWithActivitySince(since: Date, maxItems = 1000): Promise<Set<number>> {
    const ids = new Set<number>();
    let start = 0;
    for (let page = 0; page < 20 && ids.size < maxItems; page++) {
      const response = await this.client.callList<RawItem>('crm.activity.list', {
        select: ['ID', 'OWNER_ID', 'OWNER_TYPE_ID', 'CREATED'],
        filter: { OWNER_TYPE_ID: OWNER_TYPE_ID.deal, '>=CREATED': toBitrixDate(since) },
        order: { CREATED: 'DESC' },
        start,
      });
      for (const row of response.result) {
        const id = asNumber(pick(row, 'OWNER_ID'));
        if (id !== null) ids.add(id);
      }
      if (response.next === undefined || response.result.length === 0) break;
      start = response.next;
    }
    return ids;
  }
}

/** Bitrix24 accepts ISO-8601; keep a single conversion point. */
export function toBitrixDate(date: Date): string {
  return date.toISOString();
}

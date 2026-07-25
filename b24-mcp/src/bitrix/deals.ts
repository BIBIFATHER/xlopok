import { ENTITY_TYPE, type BitrixClient } from './client.js';
import {
  asIsoDate,
  asNumber,
  asString,
  fieldMaps,
  pick,
  readMappedFields,
  selectCodes,
  type RawItem,
} from './field-map.js';
import { isClosedStage, type Deal } from '../domain/deal.js';
import { NotFoundError } from '../domain/errors.js';

const BASE_SELECT = [
  'id',
  'title',
  'categoryId',
  'stageId',
  'opportunity',
  'currencyId',
  'companyId',
  'contactIds',
  'assignedById',
  'createdTime',
  'updatedTime',
  'movedTime',
  'closedate',
  'closed',
];

function selectFields(): string[] {
  return [...new Set([...BASE_SELECT, ...selectCodes(fieldMaps().deal)])];
}

export function mapDeal(raw: RawItem): Deal {
  const stageId = asString(pick(raw, 'stageId', 'STAGE_ID'));
  const contactIds = pick(raw, 'contactIds', 'CONTACT_IDS');
  return {
    id: Number(pick(raw, 'id', 'ID') ?? 0),
    title: asString(pick(raw, 'title', 'TITLE')) ?? '(без названия)',
    categoryId: asNumber(pick(raw, 'categoryId', 'CATEGORY_ID')),
    stageId,
    closed: isClosedStage(stageId),
    opportunity: asNumber(pick(raw, 'opportunity', 'OPPORTUNITY')),
    currencyId: asString(pick(raw, 'currencyId', 'CURRENCY_ID')),
    companyId: asNumber(pick(raw, 'companyId', 'COMPANY_ID')),
    contactIds: Array.isArray(contactIds) ? contactIds.map(Number).filter(Number.isFinite) : [],
    assignedById: asNumber(pick(raw, 'assignedById', 'ASSIGNED_BY_ID')),
    createdAt: asIsoDate(pick(raw, 'createdTime', 'DATE_CREATE')),
    updatedAt: asIsoDate(pick(raw, 'updatedTime', 'DATE_MODIFY')),
    stageChangedAt: asIsoDate(pick(raw, 'movedTime', 'MOVED_TIME')),
    expectedCloseAt: asIsoDate(pick(raw, 'closedate', 'CLOSEDATE')),
    custom: readMappedFields(raw, fieldMaps().deal),
  };
}

export interface DealSearchQuery {
  stageId?: string;
  categoryId?: number;
  assignedById?: number;
  companyId?: number;
  contactId?: number;
  createdFrom?: string;
  createdTo?: string;
  onlyOpen?: boolean;
  ids?: number[];
  limit: number;
  offset: number;
}

export interface DealSearchResult {
  items: Deal[];
  total: number | null;
  nextOffset: number | null;
}

export class DealRepository {
  constructor(private readonly client: BitrixClient) {}

  private buildFilter(q: Partial<DealSearchQuery>): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (q.stageId) filter['stageId'] = q.stageId;
    if (q.categoryId !== undefined) filter['categoryId'] = q.categoryId;
    if (q.assignedById !== undefined) filter['assignedById'] = q.assignedById;
    if (q.companyId !== undefined) filter['companyId'] = q.companyId;
    if (q.contactId !== undefined) filter['contactId'] = q.contactId;
    if (q.createdFrom) filter['>=createdTime'] = q.createdFrom;
    if (q.createdTo) filter['<=createdTime'] = q.createdTo;
    if (q.onlyOpen) filter['closed'] = 'N';
    if (q.ids?.length) filter['@id'] = q.ids;
    return filter;
  }

  async search(query: DealSearchQuery): Promise<DealSearchResult> {
    const response = await this.client.callList<RawItem>('crm.item.list', {
      entityTypeId: ENTITY_TYPE.DEAL,
      select: selectFields(),
      filter: this.buildFilter(query),
      order: { id: 'DESC' },
      start: query.offset,
    });
    return {
      items: response.result.slice(0, query.limit).map(mapDeal),
      total: response.total ?? null,
      nextOffset: response.next ?? null,
    };
  }

  /** Walk pagination for analytics tools; hard-capped to protect the portal. */
  async searchAll(
    query: Omit<DealSearchQuery, 'limit' | 'offset'>,
    maxItems = 500,
  ): Promise<Deal[]> {
    const out: Deal[] = [];
    let start = 0;
    for (let page = 0; page < 20 && out.length < maxItems; page++) {
      const response = await this.client.callList<RawItem>('crm.item.list', {
        entityTypeId: ENTITY_TYPE.DEAL,
        select: selectFields(),
        filter: this.buildFilter(query),
        order: { id: 'DESC' },
        start,
      });
      out.push(...response.result.map(mapDeal));
      if (response.next === undefined || response.result.length === 0) break;
      start = response.next;
    }
    return out.slice(0, maxItems);
  }

  async getById(id: number): Promise<Deal> {
    const result = await this.client.call<{ item?: RawItem }>('crm.item.get', {
      entityTypeId: ENTITY_TYPE.DEAL,
      id,
    });
    const item = result?.item;
    if (!item) throw new NotFoundError('deal', id);
    return mapDeal(item);
  }

  async findByCompany(companyId: number, onlyOpen: boolean, limit: number): Promise<Deal[]> {
    const result = await this.search({ companyId, onlyOpen, limit, offset: 0 });
    return result.items;
  }

  async findByContact(contactId: number, limit: number): Promise<Deal[]> {
    const result = await this.search({ contactId, limit, offset: 0 });
    return result.items;
  }
}

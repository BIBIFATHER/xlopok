import { ENTITY_TYPE, type BitrixClient } from './client.js';
import {
  asIsoDate,
  asNumber,
  asString,
  fieldMaps,
  multiField,
  pick,
  readMappedFields,
  selectCodes,
  type RawItem,
} from './field-map.js';
import type { Company } from '../domain/company.js';
import { NotFoundError } from '../domain/errors.js';

const BASE_SELECT = [
  'id',
  'title',
  'assignedById',
  'phone',
  'email',
  'webUrl',
  'addressCity',
  'industry',
  'createdTime',
  'updatedTime',
];

function selectFields(): string[] {
  return [...new Set([...BASE_SELECT, ...selectCodes(fieldMaps().company)])];
}

export function mapCompany(raw: RawItem): Company {
  return {
    id: Number(pick(raw, 'id', 'ID') ?? 0),
    title: asString(pick(raw, 'title', 'TITLE')) ?? '(без названия)',
    assignedById: asNumber(pick(raw, 'assignedById', 'ASSIGNED_BY_ID')),
    phones: multiField(pick(raw, 'phone', 'PHONE')),
    emails: multiField(pick(raw, 'email', 'EMAIL')),
    website: asString(pick(raw, 'webUrl', 'WEB')) ?? null,
    city: asString(pick(raw, 'addressCity', 'ADDRESS_CITY')) ?? null,
    industry: asString(pick(raw, 'industry', 'INDUSTRY')) ?? null,
    createdAt: asIsoDate(pick(raw, 'createdTime', 'DATE_CREATE')),
    updatedAt: asIsoDate(pick(raw, 'updatedTime', 'DATE_MODIFY')),
    custom: readMappedFields(raw, fieldMaps().company),
  };
}

export interface CompanySearchQuery {
  title?: string;
  city?: string;
  assignedById?: number;
  ids?: number[];
  limit: number;
  offset: number;
}

export interface CompanySearchResult {
  items: Company[];
  total: number | null;
  nextOffset: number | null;
}

export class CompanyRepository {
  constructor(private readonly client: BitrixClient) {}

  async search(query: CompanySearchQuery): Promise<CompanySearchResult> {
    const filter: Record<string, unknown> = {};
    if (query.title) filter['%title'] = query.title;
    if (query.city) filter['%addressCity'] = query.city;
    if (query.assignedById !== undefined) filter['assignedById'] = query.assignedById;
    if (query.ids?.length) filter['@id'] = query.ids;

    const response = await this.client.callList<RawItem>('crm.item.list', {
      entityTypeId: ENTITY_TYPE.COMPANY,
      select: selectFields(),
      filter,
      order: { id: 'DESC' },
      start: query.offset,
    });

    const items = response.result.slice(0, query.limit).map(mapCompany);
    return {
      items,
      total: response.total ?? null,
      nextOffset: response.next ?? null,
    };
  }

  async getById(id: number): Promise<Company> {
    const result = await this.client.call<{ item?: RawItem }>('crm.item.get', {
      entityTypeId: ENTITY_TYPE.COMPANY,
      id,
    });
    const item = result?.item;
    if (!item) throw new NotFoundError('company', id);
    return mapCompany(item);
  }

  async getManyByIds(ids: number[]): Promise<Company[]> {
    if (ids.length === 0) return [];
    const response = await this.client.callList<RawItem>('crm.item.list', {
      entityTypeId: ENTITY_TYPE.COMPANY,
      select: selectFields(),
      filter: { '@id': ids },
    });
    return response.result.map(mapCompany);
  }

  /**
   * Communication lookup goes through the portal's own duplicate index rather
   * than a wildcard filter — it is both faster and the only reliable way to
   * match a phone regardless of stored formatting.
   */
  async findIdsByCommunication(type: 'PHONE' | 'EMAIL', values: string[]): Promise<number[]> {
    if (values.length === 0) return [];
    const result = await this.client.call<Record<string, number[]>>('crm.duplicate.findbycomm', {
      type,
      values: values.slice(0, 20),
      entity_type: 'COMPANY',
    });
    return result?.COMPANY ?? [];
  }
}

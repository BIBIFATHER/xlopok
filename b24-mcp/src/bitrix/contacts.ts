import { ENTITY_TYPE, type BitrixClient } from './client.js';
import { asIsoDate, asNumber, asString, multiField, pick, type RawItem } from './field-map.js';
import type { Contact } from '../domain/contact.js';
import { NotFoundError } from '../domain/errors.js';

const SELECT = [
  'id',
  'name',
  'secondName',
  'lastName',
  'post',
  'companyId',
  'assignedById',
  'phone',
  'email',
  'createdTime',
  'updatedTime',
];

export function mapContact(raw: RawItem): Contact {
  const first = asString(pick(raw, 'name', 'NAME'));
  const last = asString(pick(raw, 'lastName', 'LAST_NAME'));
  const second = asString(pick(raw, 'secondName', 'SECOND_NAME'));
  const fullName = [last, first, second].filter(Boolean).join(' ').trim();
  return {
    id: Number(pick(raw, 'id', 'ID') ?? 0),
    fullName: fullName || '(без имени)',
    firstName: first,
    lastName: last,
    post: asString(pick(raw, 'post', 'POST')),
    companyId: asNumber(pick(raw, 'companyId', 'COMPANY_ID')),
    assignedById: asNumber(pick(raw, 'assignedById', 'ASSIGNED_BY_ID')),
    phones: multiField(pick(raw, 'phone', 'PHONE')),
    emails: multiField(pick(raw, 'email', 'EMAIL')),
    createdAt: asIsoDate(pick(raw, 'createdTime', 'DATE_CREATE')),
    updatedAt: asIsoDate(pick(raw, 'updatedTime', 'DATE_MODIFY')),
  };
}

export interface ContactSearchQuery {
  name?: string;
  companyId?: number;
  assignedById?: number;
  ids?: number[];
  limit: number;
  offset: number;
}

export interface ContactSearchResult {
  items: Contact[];
  total: number | null;
  nextOffset: number | null;
}

export class ContactRepository {
  constructor(private readonly client: BitrixClient) {}

  async search(query: ContactSearchQuery): Promise<ContactSearchResult> {
    const filter: Record<string, unknown> = {};
    if (query.name) {
      // OR across the three name parts — Bitrix supports `logic` inside filter.
      filter['logic'] = 'OR';
      filter['%name'] = query.name;
      filter['%lastName'] = query.name;
      filter['%secondName'] = query.name;
    }
    if (query.companyId !== undefined) filter['companyId'] = query.companyId;
    if (query.assignedById !== undefined) filter['assignedById'] = query.assignedById;
    if (query.ids?.length) filter['@id'] = query.ids;

    const response = await this.client.callList<RawItem>('crm.item.list', {
      entityTypeId: ENTITY_TYPE.CONTACT,
      select: SELECT,
      filter,
      order: { id: 'DESC' },
      start: query.offset,
    });

    return {
      items: response.result.slice(0, query.limit).map(mapContact),
      total: response.total ?? null,
      nextOffset: response.next ?? null,
    };
  }

  async getById(id: number): Promise<Contact> {
    const result = await this.client.call<{ item?: RawItem }>('crm.item.get', {
      entityTypeId: ENTITY_TYPE.CONTACT,
      id,
    });
    const item = result?.item;
    if (!item) throw new NotFoundError('contact', id);
    return mapContact(item);
  }

  async getManyByIds(ids: number[]): Promise<Contact[]> {
    if (ids.length === 0) return [];
    const response = await this.client.callList<RawItem>('crm.item.list', {
      entityTypeId: ENTITY_TYPE.CONTACT,
      select: SELECT,
      filter: { '@id': ids },
    });
    return response.result.map(mapContact);
  }

  async findByCompany(companyId: number, limit: number): Promise<Contact[]> {
    const response = await this.client.callList<RawItem>('crm.item.list', {
      entityTypeId: ENTITY_TYPE.CONTACT,
      select: SELECT,
      filter: { companyId },
      order: { id: 'DESC' },
    });
    return response.result.slice(0, limit).map(mapContact);
  }

  async findIdsByCommunication(type: 'PHONE' | 'EMAIL', values: string[]): Promise<number[]> {
    if (values.length === 0) return [];
    const result = await this.client.call<Record<string, number[]>>('crm.duplicate.findbycomm', {
      type,
      values: values.slice(0, 20),
      entity_type: 'CONTACT',
    });
    return result?.CONTACT ?? [];
  }
}

import { loadEnv } from '../config/env.js';
import { logger } from '../security/logger.js';

/**
 * Canvas Lab domain fields <-> Bitrix24 custom field codes.
 *
 * Domain code never references UF_CRM_* directly. Real codes are portal
 * specific and are supplied at runtime via FIELD_MAP_COMPANY / FIELD_MAP_DEAL.
 * Nothing here invents an identifier: an unmapped field simply resolves to
 * `undefined` and is skipped in select/filter building.
 */

export const COMPANY_DOMAIN_FIELDS = [
  'segment',
  'city',
  'website',
  'number_of_locations',
  'sales_channels',
  'current_supplier',
  'estimated_monthly_volume',
  'canvas_assortment',
  'price_segment',
  'lead_score',
  'data_quality',
  'verification_status',
  'last_meaningful_contact_at',
  'next_expected_purchase_at',
] as const;

export const DEAL_DOMAIN_FIELDS = [
  'need',
  'interested_sizes',
  'estimated_quantity',
  'estimated_revenue',
  'price_sent_at',
  'samples_sent_at',
  'next_step',
  'next_step_at',
  'loss_reason',
  'ai_summary',
  'ai_confidence',
] as const;

export type CompanyDomainField = (typeof COMPANY_DOMAIN_FIELDS)[number];
export type DealDomainField = (typeof DEAL_DOMAIN_FIELDS)[number];

export type FieldMap<K extends string> = Partial<Record<K, string>>;

const UF_CODE_RE = /^(UF_CRM_[A-Z0-9_]+|ufCrm[A-Za-z0-9_]+)$/;

function parseMap<K extends string>(raw: string, allowed: readonly K[], label: string): FieldMap<K> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn(`${label} is not valid JSON — ignoring custom field mapping`);
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger.warn(`${label} must be a JSON object — ignoring custom field mapping`);
    return {};
  }
  const out: FieldMap<K> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!allowed.includes(key as K)) {
      logger.warn(`${label}: unknown domain field skipped`, { field: key });
      continue;
    }
    if (typeof value !== 'string' || !UF_CODE_RE.test(value)) {
      logger.warn(`${label}: value is not a Bitrix24 custom field code`, { field: key });
      continue;
    }
    out[key as K] = value;
  }
  return out;
}

export interface FieldMaps {
  company: FieldMap<CompanyDomainField>;
  deal: FieldMap<DealDomainField>;
}

let cached: FieldMaps | null = null;

export function fieldMaps(): FieldMaps {
  if (cached) return cached;
  const env = loadEnv();
  cached = {
    company: parseMap(env.FIELD_MAP_COMPANY, COMPANY_DOMAIN_FIELDS, 'FIELD_MAP_COMPANY'),
    deal: parseMap(env.FIELD_MAP_DEAL, DEAL_DOMAIN_FIELDS, 'FIELD_MAP_DEAL'),
  };
  return cached;
}

export function setFieldMaps(maps: FieldMaps | null): void {
  cached = maps;
}

/** Bitrix code for a domain field, or undefined when the portal lacks it. */
export function companyField(name: CompanyDomainField): string | undefined {
  return fieldMaps().company[name];
}

export function dealField(name: DealDomainField): string | undefined {
  return fieldMaps().deal[name];
}

/** Extract all mapped domain fields from a raw Bitrix item. */
export function readMappedFields<K extends string>(
  item: Record<string, unknown>,
  map: FieldMap<K>,
): Partial<Record<K, unknown>> {
  const out: Partial<Record<K, unknown>> = {};
  for (const [domain, code] of Object.entries(map) as Array<[K, string]>) {
    const value = item[code] ?? item[toCamelUf(code)];
    if (value !== undefined && value !== null && value !== '') out[domain] = value;
  }
  return out;
}

/** crm.item.* returns custom fields camel-cased (UF_CRM_X -> ufCrmX) by default. */
export function toCamelUf(code: string): string {
  if (!code.startsWith('UF_CRM_')) return code;
  return code
    .toLowerCase()
    .split('_')
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

/** Mapped Bitrix codes for a select clause, in both raw and camel form. */
export function selectCodes<K extends string>(map: FieldMap<K>): string[] {
  const codes = Object.values(map) as string[];
  return [...new Set(codes.flatMap((c) => [c, toCamelUf(c)]))];
}

/* ---------- raw Bitrix payload helpers (shared by the entity modules) ---------- */

export type RawItem = Record<string, unknown>;

/** Read a value under any of the given keys (camelCase or UPPER_CASE). */
export function pick(item: RawItem, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = item[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

export function asString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

export function asNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function asBool(value: unknown): boolean {
  return value === true || value === 'Y' || value === 1 || value === '1';
}

/** Flatten a Bitrix multifield (PHONE/EMAIL) into plain string values. */
export function multiField(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) =>
      entry && typeof entry === 'object'
        ? asString((entry as RawItem).VALUE ?? (entry as RawItem).value)
        : asString(entry),
    )
    .filter((v): v is string => v !== null);
}

/** Bitrix returns dates in several shapes; normalise to ISO-8601 or null. */
export function asIsoDate(value: unknown): string | null {
  const s = asString(value);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

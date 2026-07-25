import { isEmail, normalizePhone, phoneTail } from '../domain/contact.js';

/**
 * Normalisation and quality scoring for the legacy contact base
 * (`ЕДИНАЯ_БАЗА_КОНТАКТОВ_CRM_2026.xlsx`, ~5 900 rows).
 *
 * The source file is never modified: it is read once and every output is
 * written to a separate directory.
 */

export interface RawRow {
  row_number: number;
  base_period: string;
  phone_e164: string;
  phone_formatted: string;
  contact_name: string;
  company: string;
  email: string;
  source_category: string;
  in_crm_2023_2024: string;
  in_video_file: string;
  video_status: string;
  crm_entity_types: string;
  activity_years: string;
}

export const SOURCE_COLUMNS = [
  'База / Период',
  'Телефон (E.164)',
  'Телефон (Формат)',
  'Имя контакта',
  'Компания',
  'E-mail',
  'Категория источника',
  'Присутствует в CRM 2023-2024',
  'Присутствует в Видео-файле',
  'Статус из Видео-файла',
  'Типы сущностей в CRM',
  'Года активности в CRM',
] as const;

export type DataQuality = 'high' | 'medium' | 'low';

export interface NormalizedRow {
  row_number: number;
  /** Cleaned company name, or null when the cell held only noise. */
  company_title: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_full_name: string | null;
  phone: string | null;
  phone_key: string | null;
  email: string | null;
  /** Email that parses but is clearly machine-generated (phone@domain). */
  email_is_synthetic: boolean;
  legal_form: string | null;
  source_category: string;
  in_crm: boolean;
  activity_years: number[];
  crm_entity_types: string[];
  data_quality: DataQuality;
  issues: string[];
}

const LEGAL_FORMS = [
  'ООО',
  'ОАО',
  'ЗАО',
  'ПАО',
  'АО',
  'ИП',
  'НКО',
  'ГБУ',
  'МБУ',
  'ФГБУ',
  'НОУ',
  'ЧОУ',
];

/** Cells in the source often carry separators and stray quotes. */
export function cleanCompany(raw: string): string | null {
  let value = (raw ?? '').trim();
  if (!value) return null;
  value = value
    .replace(/[«»""”“]/g, '"')
    .replace(/^[.,;/\s=-]+/, '')
    .replace(/[.,;/\s=-]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // "18503," or "1234" — an ID leftover, not a name.
  if (!value || /^\d+$/.test(value)) return null;
  if (value.length < 2) return null;
  return value;
}

export function detectLegalForm(value: string | null): string | null {
  if (!value) return null;
  const upper = value.toUpperCase();
  return LEGAL_FORMS.find((f) => upper.startsWith(f + ' ') || upper.startsWith(f + '"')) ?? null;
}

// No \b here: JS word boundaries are ASCII-only and would never fire after a
// Cyrillic letter. Anchor on whitespace or end of string instead.
const PATRONYMIC = /(ович|евич|овна|евна|ична|инична)(\s|$)/i;
const INITIALS = /(^|\s)[А-ЯЁ]\.\s?[А-ЯЁ]?\.?/;
const CYRILLIC_WORD = /^[А-ЯЁ][а-яё-]+$/;

/**
 * Is this cell a person rather than an organisation?
 *
 * The base is B2B wholesale: the overwhelming majority of "Имя контакта"
 * values are trade names ("GALACENTER", "Арт Багет", "Deloks.ru"). So the
 * default is COMPANY, and a person is recognised only on strong evidence —
 * a patronymic or initials. Anything that merely looks like two Cyrillic words
 * is kept as a company but flagged as ambiguous for human review.
 */
export function looksLikePerson(value: string): boolean {
  if (detectLegalForm(value)) return false;
  if (PATRONYMIC.test(value)) return true;
  if (INITIALS.test(value) && /[А-ЯЁ][а-яё]+/.test(value)) return true;
  return false;
}

/** Two or three plain Cyrillic words — could be either a name or a brand. */
export function isAmbiguousName(value: string): boolean {
  const words = value.trim().split(/\s+/);
  if (words.length < 2 || words.length > 3) return false;
  return words.every((w) => CYRILLIC_WORD.test(w));
}

/** "ООО \"Линер\" / Филатов" → company + person hint. */
export function splitNameCell(raw: string): { company: string | null; person: string | null } {
  const value = (raw ?? '').trim();
  if (!value) return { company: null, person: null };

  const parts = value.split('/').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const [first, second] = parts as [string, string];
    if (detectLegalForm(first) || first.includes('"') || !looksLikePerson(first)) {
      return { company: cleanCompany(first), person: looksLikePerson(second) ? second : second };
    }
    return { company: cleanCompany(second), person: first };
  }

  if (looksLikePerson(value)) return { company: null, person: value };
  return { company: cleanCompany(value), person: null };
}

/** Split a person string into last / first name. Conservative on purpose. */
export function splitPerson(person: string | null): {
  first: string | null;
  last: string | null;
  full: string | null;
} {
  if (!person) return { first: null, last: null, full: null };
  const cleaned = person.replace(/\s{2,}/g, ' ').trim();
  if (!cleaned) return { first: null, last: null, full: null };
  const words = cleaned.split(' ');
  if (words.length === 1) return { first: words[0]!, last: null, full: cleaned };
  return { last: words[0]!, first: words[1]!, full: cleaned };
}

const SYNTHETIC_EMAIL = /^(\+?\d[\d-]{5,})@/;

export function cleanEmail(raw: string): { email: string | null; synthetic: boolean; valid: boolean } {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return { email: null, synthetic: false, valid: false };
  const valid = isEmail(value);
  const synthetic = SYNTHETIC_EMAIL.test(value);
  return { email: valid ? value : null, synthetic, valid };
}

export function parseYears(raw: string): number[] {
  return (raw ?? '')
    .split(/[,;]/)
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isInteger(n) && n >= 2000 && n <= 2100);
}

export function pickCompanyTitle(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  const aForm = detectLegalForm(a);
  const bForm = detectLegalForm(b);
  if (aForm && !bForm) return a;
  if (bForm && !aForm) return b;
  return a.length >= b.length ? a : b;
}

export function normalizeRow(row: RawRow): NormalizedRow {
  const issues: string[] = [];

  const fromCompanyCell = splitNameCell(row.company);
  const fromNameCell = splitNameCell(row.contact_name);

  // Both cells can carry a company name; prefer the one that includes a legal
  // form ("ООО \"Линер\"" beats the bare "\"Линер\"" left in the company cell).
  const companyTitle = pickCompanyTitle(fromCompanyCell.company, fromNameCell.company);
  const personRaw = fromNameCell.person ?? fromCompanyCell.person;
  const person = splitPerson(personRaw);

  const phone = normalizePhone(row.phone_e164 || row.phone_formatted);
  if (!phone) issues.push('phone_missing_or_invalid');

  const email = cleanEmail(row.email);
  if (!email.valid && row.email?.trim()) issues.push('email_invalid');
  if (email.synthetic) issues.push('email_synthetic');
  if (!companyTitle) issues.push('company_name_missing');
  if (!person.full) issues.push('contact_name_missing');
  if (companyTitle && isAmbiguousName(companyTitle)) issues.push('company_vs_person_ambiguous');

  const inCrm = /да/i.test(row.in_crm_2023_2024 ?? '');
  const years = parseYears(row.activity_years);
  const entityTypes = (row.crm_entity_types ?? '')
    .split(/[,;]/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  let quality: DataQuality = 'high';
  if (issues.length >= 3) quality = 'low';
  else if (issues.length >= 1) quality = 'medium';
  if (!phone && !email.email) quality = 'low';

  return {
    row_number: row.row_number,
    company_title: companyTitle,
    contact_first_name: person.first,
    contact_last_name: person.last,
    contact_full_name: person.full,
    phone,
    phone_key: phone ? phoneTail(phone) : null,
    email: email.email,
    email_is_synthetic: email.synthetic,
    legal_form: detectLegalForm(companyTitle),
    source_category: (row.source_category ?? '').trim(),
    in_crm: inCrm,
    activity_years: years,
    crm_entity_types: entityTypes,
    data_quality: quality,
    issues,
  };
}

export interface DuplicateGroup {
  key: string;
  key_type: 'phone' | 'email' | 'company';
  rows: NormalizedRow[];
}

/** Group rows that would collide in the CRM if imported as-is. */
export function findDuplicateGroups(rows: NormalizedRow[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];

  const byPhone = new Map<string, NormalizedRow[]>();
  const byEmail = new Map<string, NormalizedRow[]>();
  const byCompany = new Map<string, NormalizedRow[]>();

  for (const r of rows) {
    if (r.phone_key) push(byPhone, r.phone_key, r);
    if (r.email && !r.email_is_synthetic) push(byEmail, r.email, r);
    if (r.company_title) push(byCompany, companyKey(r.company_title), r);
  }

  collect(byPhone, 'phone', groups);
  collect(byEmail, 'email', groups);
  collect(byCompany, 'company', groups);

  return groups;
}

export function companyKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/["'`.,]/g, '')
    .replace(/\b(ооо|оао|зао|пао|ао|ип|нко)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

function collect(
  map: Map<string, NormalizedRow[]>,
  keyType: DuplicateGroup['key_type'],
  out: DuplicateGroup[],
): void {
  for (const [key, rows] of map) {
    if (rows.length > 1) out.push({ key, key_type: keyType, rows });
  }
}

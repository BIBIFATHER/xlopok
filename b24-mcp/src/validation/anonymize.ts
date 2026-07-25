/**
 * Fixture anonymisation.
 *
 * Live responses are kept as test fixtures, so they must not carry real client
 * data. Structure, field names and value types are preserved exactly — only
 * the values that identify a person or an organisation are replaced with stable
 * pseudonyms, so the same input always yields the same placeholder and the
 * relations between records stay intact.
 *
 * Two passes:
 *   1. collect every identifying value (names, org titles, cities, sites,
 *      phones, emails) into a value → pseudonym map;
 *   2. rewrite the structure, replacing those literal values EVERYWHERE — not
 *      only under their original key, but also inside generated prose such as
 *      an outreach draft that embeds the company name mid-sentence.
 */
import { createHash } from 'node:crypto';

/** Keys whose string value names an organisation. */
const ORG_KEYS =
  /^(title|companyTitle|webUrl|website|address|addressCity|city|post|industry|subject|draft_subject|TITLE|SUBJECT|WEB|ADDRESS|ADDRESS_CITY|POST|INDUSTRY)$/;

/** Keys whose string value names a person. */
const PERSON_KEYS =
  /^(name|firstName|lastName|secondName|fullName|responsibleName|NAME|LAST_NAME|SECOND_NAME)$/;

/** Keys holding phone values (singular or plural, raw or normalised). */
const PHONE_KEYS = /^(phone|phones|PHONE)$/;
const EMAIL_KEYS = /^(email|emails|EMAIL)$/;

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g;
// Russian phone shapes only (must start +7 / 8 / 7), so ISO dates such as
// "2026-06-15T09:00:00+03:00" are not mistaken for a number.
const PHONE_RE = /(?<![\d-])(?:\+7|8|7)[\s(]*\d{3}[\s)]*[\d\s-]{7,9}\d/g;

function stableIndex(value: string, buckets: number): number {
  const digest = createHash('sha256').update(value).digest();
  return digest.readUInt16BE(0) % buckets;
}

function pseudoOrg(value: string): string {
  return `Компания-${stableIndex(value, 900) + 100}`;
}
function pseudoPerson(value: string): string {
  return `Контакт-${stableIndex(value, 900) + 100}`;
}
function pseudoPhone(value: string): string {
  const digits = String(value).replace(/\D/g, '');
  return `+7999000${String(stableIndex(digits || value, 10000)).padStart(4, '0')}`;
}
function pseudoEmail(value: string): string {
  return `user${stableIndex(value, 9000) + 1000}@example.test`;
}

function multifieldValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (entry && typeof entry === 'object') {
      const raw = (entry as Record<string, unknown>).VALUE ?? (entry as Record<string, unknown>).value;
      return typeof raw === 'string' ? [raw] : [];
    }
    return [];
  });
}

type Replacements = Map<string, string>;

/** Pass 1: gather every identifying literal and its stable pseudonym. */
function collect(value: unknown, repl: Replacements, depth = 0): void {
  if (depth > 12 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const v of value) collect(v, repl, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;

  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (PHONE_KEYS.test(key)) {
      for (const p of multifieldValues(raw)) repl.set(p, pseudoPhone(p));
    } else if (EMAIL_KEYS.test(key)) {
      for (const e of multifieldValues(raw)) repl.set(e, pseudoEmail(e));
    } else if (typeof raw === 'string' && raw.length > 0) {
      if (PERSON_KEYS.test(key)) repl.set(raw, pseudoPerson(raw));
      else if (ORG_KEYS.test(key)) repl.set(raw, pseudoOrg(raw));
    } else {
      collect(raw, repl, depth + 1);
    }
  }
}

/** Replace every collected literal, then scrub any stray phone/email pattern. */
function scrubString(input: string, repl: Replacements): string {
  let out = input;
  // Longest first, so "ООО Ромашка" is replaced before a bare "Ромашка".
  for (const [from, to] of [...repl].sort((a, b) => b[0].length - a[0].length)) {
    if (from && out.includes(from)) out = out.split(from).join(to);
  }
  return out.replace(EMAIL_RE, (m) => pseudoEmail(m)).replace(PHONE_RE, (m) => pseudoPhone(m));
}

/** Pass 2: rebuild the structure applying the replacement map. */
function rewrite(value: unknown, repl: Replacements, depth = 0): unknown {
  if (depth > 12) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value, repl);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => rewrite(v, repl, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    out[key] = rewrite(raw, repl, depth + 1);
  }
  return out;
}

export function anonymize(value: unknown): unknown {
  const repl: Replacements = new Map();
  collect(value, repl);
  return rewrite(value, repl);
}

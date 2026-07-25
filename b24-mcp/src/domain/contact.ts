/** Normalised contact as exposed by MCP tools. */
export interface Contact {
  id: number;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  post: string | null;
  companyId: number | null;
  assignedById: number | null;
  phones: string[];
  emails: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ContactSummary {
  id: number;
  fullName: string;
  post: string | null;
  phones: string[];
  emails: string[];
  companyId: number | null;
}

export function toContactSummary(c: Contact): ContactSummary {
  return {
    id: c.id,
    fullName: c.fullName,
    post: c.post,
    phones: c.phones,
    emails: c.emails,
    companyId: c.companyId,
  };
}

/**
 * Reduce a Russian phone number to a comparable form.
 * Keeps a leading '+' and digits only; maps a leading 8 to 7 for RU numbers.
 * Returns null when the input cannot be a phone number.
 */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length < 6) return null;
  let normalized = digits;
  if (normalized.length === 11 && normalized.startsWith('8')) normalized = '7' + normalized.slice(1);
  if (normalized.length === 10) normalized = '7' + normalized;
  return '+' + normalized;
}

/** Last 10 digits — what Bitrix24 duplicate search effectively matches on. */
export function phoneTail(input: string): string | null {
  const normalized = normalizePhone(input);
  if (!normalized) return null;
  return normalized.replace(/\D/g, '').slice(-10);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

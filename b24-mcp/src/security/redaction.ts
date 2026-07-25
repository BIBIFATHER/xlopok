/**
 * Redaction utilities.
 *
 * Two separate concerns:
 *  1. Secrets (webhook URL, auth token) — must be scrubbed from ANY string that
 *     could reach a log, an error message or a tool response.
 *  2. Personal data (phones, emails) — masked in logs and audit records, but
 *     returned in full to the MCP client, which is the authorised consumer.
 */

const secrets = new Set<string>();

/** Register a secret so it is scrubbed from every log line and error string. */
export function registerSecret(value: string | undefined | null): void {
  if (!value) return;
  const trimmed = value.trim();
  if (trimmed.length < 8) return;
  secrets.add(trimmed);
  // A webhook URL is often logged without its trailing slash, or path-only.
  const noSlash = trimmed.replace(/\/+$/, '');
  if (noSlash !== trimmed) secrets.add(noSlash);
}

/** Test helper. */
export function clearSecrets(): void {
  secrets.clear();
}

const WEBHOOK_URL_RE = /https:\/\/[^\s"']+\/rest\/\d+\/[A-Za-z0-9]+\/?/g;

/** Remove every known secret (and anything shaped like a webhook) from text. */
export function scrubSecrets(input: string): string {
  let out = input;
  for (const s of secrets) {
    if (s && out.includes(s)) out = out.split(s).join('[REDACTED]');
  }
  return out.replace(WEBHOOK_URL_RE, '[REDACTED_WEBHOOK]');
}

const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const PHONE_RE = /(\+?\d[\d\s()-]{7,}\d)/g;

export function maskEmail(value: string): string {
  return value.replace(EMAIL_RE, (_m, first: string, domain: string) => `${first}***${domain}`);
}

export function maskPhone(value: string): string {
  return value.replace(PHONE_RE, (m: string) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 6) return m;
    return `${digits.slice(0, 2)}****${digits.slice(-2)}`;
  });
}

/** Full pipeline applied to anything written to a log or audit record. */
export function redactText(input: string): string {
  return maskPhone(maskEmail(scrubSecrets(input)));
}

const SENSITIVE_KEYS = /^(phone|email|token|secret|password|auth|webhook|authorization)/i;

/** Deep-redact an arbitrary value for logging. Depth-capped to avoid cycles. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (value == null) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  if (value instanceof Error) return redactText(value.message);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? redactValue(stringify(v), depth + 1) : redactValue(v, depth + 1);
    }
    return out;
  }
  return '[UNSERIALIZABLE]';
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

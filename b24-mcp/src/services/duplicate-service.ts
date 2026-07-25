import type { CompanyRepository } from '../bitrix/companies.js';
import type { ContactRepository } from '../bitrix/contacts.js';
import type { Company } from '../domain/company.js';
import type { Contact } from '../domain/contact.js';
import { isEmail, normalizePhone } from '../domain/contact.js';

export interface DuplicateCheckInput {
  phones?: string[];
  emails?: string[];
  title?: string;
}

export interface DuplicateMatch {
  entity: 'company' | 'contact';
  id: number;
  title: string;
  reason: 'phone' | 'email' | 'title';
}

/**
 * Duplicate detection used both by search (to resolve a phone/email into
 * records) and as a mandatory pre-flight for every create operation.
 */
export class DuplicateService {
  constructor(
    private readonly companies: CompanyRepository,
    private readonly contacts: ContactRepository,
  ) {}

  /** Split a free-text query into the strongest available identifier. */
  static classifyQuery(query: string): { kind: 'phone' | 'email' | 'text'; value: string } {
    const trimmed = query.trim();
    if (isEmail(trimmed)) return { kind: 'email', value: trimmed.toLowerCase() };
    const phone = normalizePhone(trimmed);
    if (phone && /\d/.test(trimmed) && trimmed.replace(/\D/g, '').length >= 6) {
      return { kind: 'phone', value: phone };
    }
    return { kind: 'text', value: trimmed };
  }

  async companiesByCommunication(kind: 'phone' | 'email', value: string): Promise<Company[]> {
    const ids = await this.companies.findIdsByCommunication(
      kind === 'phone' ? 'PHONE' : 'EMAIL',
      [value],
    );
    return this.companies.getManyByIds(ids);
  }

  async contactsByCommunication(kind: 'phone' | 'email', value: string): Promise<Contact[]> {
    const ids = await this.contacts.findIdsByCommunication(
      kind === 'phone' ? 'PHONE' : 'EMAIL',
      [value],
    );
    return this.contacts.getManyByIds(ids);
  }

  /**
   * Pre-flight for create operations. Returns every record that would make the
   * new one a duplicate; an empty array means the create is safe to plan.
   */
  async findDuplicates(input: DuplicateCheckInput): Promise<DuplicateMatch[]> {
    const matches: DuplicateMatch[] = [];

    const phones = (input.phones ?? [])
      .map((p) => normalizePhone(p))
      .filter((p): p is string => p !== null)
      .slice(0, 20);
    const emails = (input.emails ?? [])
      .map((e) => e.trim().toLowerCase())
      .filter((e) => isEmail(e))
      .slice(0, 20);

    if (phones.length > 0) {
      for (const c of await this.companiesByCommunication('phone', phones[0]!)) {
        matches.push({ entity: 'company', id: c.id, title: c.title, reason: 'phone' });
      }
      for (const c of await this.contactsByCommunication('phone', phones[0]!)) {
        matches.push({ entity: 'contact', id: c.id, title: c.fullName, reason: 'phone' });
      }
    }

    if (emails.length > 0) {
      for (const c of await this.companiesByCommunication('email', emails[0]!)) {
        matches.push({ entity: 'company', id: c.id, title: c.title, reason: 'email' });
      }
      for (const c of await this.contactsByCommunication('email', emails[0]!)) {
        matches.push({ entity: 'contact', id: c.id, title: c.fullName, reason: 'email' });
      }
    }

    if (input.title && input.title.trim().length >= 3) {
      const byTitle = await this.companies.search({ title: input.title.trim(), limit: 5, offset: 0 });
      for (const c of byTitle.items) {
        matches.push({ entity: 'company', id: c.id, title: c.title, reason: 'title' });
      }
    }

    return dedupe(matches);
  }
}

function dedupe(matches: DuplicateMatch[]): DuplicateMatch[] {
  const seen = new Set<string>();
  return matches.filter((m) => {
    const key = `${m.entity}:${m.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

import type { CompanyDomainField } from '../bitrix/field-map.js';

/** Normalised company as exposed by MCP tools. No UF_CRM_* codes leak here. */
export interface Company {
  id: number;
  title: string;
  assignedById: number | null;
  phones: string[];
  emails: string[];
  website: string | null;
  city: string | null;
  industry: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Canvas Lab specific fields, present only when mapped in field-map. */
  custom: Partial<Record<CompanyDomainField, unknown>>;
}

export interface CompanySummary {
  id: number;
  title: string;
  city: string | null;
  phones: string[];
  emails: string[];
  assignedById: number | null;
}

export function toCompanySummary(c: Company): CompanySummary {
  return {
    id: c.id,
    title: c.title,
    city: c.city,
    phones: c.phones,
    emails: c.emails,
    assignedById: c.assignedById,
  };
}

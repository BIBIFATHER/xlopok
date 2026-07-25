import type { DealDomainField } from '../bitrix/field-map.js';

/** Normalised deal as exposed by MCP tools. */
export interface Deal {
  id: number;
  title: string;
  categoryId: number | null;
  stageId: string | null;
  /** true when the deal has reached a final (won or lost) stage. */
  closed: boolean;
  opportunity: number | null;
  currencyId: string | null;
  companyId: number | null;
  contactIds: number[];
  assignedById: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** When the deal last changed stage — basis for staleness detection. */
  stageChangedAt: string | null;
  expectedCloseAt: string | null;
  custom: Partial<Record<DealDomainField, unknown>>;
}

export interface DealSummary {
  id: number;
  title: string;
  stageId: string | null;
  opportunity: number | null;
  currencyId: string | null;
  companyId: number | null;
  assignedById: number | null;
  stageChangedAt: string | null;
}

export function toDealSummary(d: Deal): DealSummary {
  return {
    id: d.id,
    title: d.title,
    stageId: d.stageId,
    opportunity: d.opportunity,
    currencyId: d.currencyId,
    companyId: d.companyId,
    assignedById: d.assignedById,
    stageChangedAt: d.stageChangedAt,
  };
}

/** Bitrix24 semi-final stage prefixes: WON / LOSE / APOLOGY are terminal. */
export function isClosedStage(stageId: string | null | undefined): boolean {
  if (!stageId) return false;
  const tail = stageId.includes(':') ? stageId.split(':').pop()! : stageId;
  return /^(WON|LOSE|APOLOGY)/i.test(tail);
}

export function isLostStage(stageId: string | null | undefined): boolean {
  if (!stageId) return false;
  const tail = stageId.includes(':') ? stageId.split(':').pop()! : stageId;
  return /^(LOSE|APOLOGY)/i.test(tail);
}

export function daysBetween(from: string | null, to: Date): number | null {
  if (!from) return null;
  const start = Date.parse(from);
  if (Number.isNaN(start)) return null;
  return Math.floor((to.getTime() - start) / 86_400_000);
}

import { loadEnv } from '../config/env.js';
import { ConfirmationRequiredError, DomainError, WriteDisabledError } from '../domain/errors.js';
import { isLostStage } from '../domain/deal.js';

/**
 * Policy layer. Every rule the gateway promises to the business lives here,
 * so it can be read (and tested) in one place.
 */

export type ToolMode = 'read' | 'write';

export interface ToolPolicy {
  name: string;
  mode: ToolMode;
  /** Bitrix24 REST methods this tool is allowed to reach. */
  methods: readonly string[];
  /** Write tools only: a create/update must be dry-runnable first. */
  supportsDryRun?: boolean;
  /** Write tools only: requires a duplicate pre-check. */
  requiresDuplicateCheck?: boolean;
  /** Write tools only: caller must pass an idempotency key. */
  requiresIdempotencyKey?: boolean;
}

export const READ_TOOL_NAMES = [
  'crm_search_companies',
  'crm_get_company',
  'crm_search_contacts',
  'crm_get_contact',
  'crm_search_deals',
  'crm_get_deal',
  'crm_get_overdue_followups',
  'crm_get_deals_without_next_action',
  'crm_get_stale_deals',
  'crm_get_sales_summary',
  'crm_find_duplicates',
  'crm_prepare_outreach',
] as const;

export const WRITE_TOOL_NAMES = [
  'crm_create_company',
  'crm_create_contact',
  'crm_create_deal',
  'crm_add_note',
  'crm_add_call_summary',
  'crm_create_followup',
  'crm_update_next_step',
  'crm_update_deal_stage',
] as const;

/** Work-distribution tools. Local gateway state only — they never touch the CRM. */
export const SALES_TOOL_NAMES = [
  'sales_get_available_work',
  'sales_claim_account',
  'sales_release_account',
  'sales_complete_assignment',
  'sales_transfer_account',
  'sales_get_my_assignments',
  'sales_get_agent_metrics',
] as const;

export type ReadToolName = (typeof READ_TOOL_NAMES)[number];
export type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];
export type SalesToolName = (typeof SALES_TOOL_NAMES)[number];

/**
 * Capabilities the gateway will never expose, regardless of WRITE_ENABLED.
 * Kept as an explicit list so the refusal is auditable rather than implicit.
 */
export const PERMANENTLY_FORBIDDEN = [
  'deleting any CRM record',
  'calling an arbitrary Bitrix24 REST method',
  'sending messages, email or SMS to clients',
  'issuing invoices or changing prices',
  'closing a deal as lost without explicit human confirmation',
  'bulk mutation beyond the configured batch limit',
] as const;

/** Hard cap on records a single write tool may touch. */
export const MAX_WRITE_BATCH = 1;

export function isWriteEnabled(): boolean {
  return loadEnv().WRITE_ENABLED;
}

/** Throws unless writes are globally enabled. Call before registering or running a write tool. */
export function assertWriteEnabled(tool: string): void {
  if (!isWriteEnabled()) throw new WriteDisabledError(tool);
}

/** Reject stage transitions that need a human in the loop. */
export function assertStageTransitionAllowed(
  targetStageId: string,
  confirmation: { humanConfirmed?: boolean } = {},
): void {
  if (isLostStage(targetStageId) && !confirmation.humanConfirmed) {
    throw new ConfirmationRequiredError('Moving a deal to a lost stage');
  }
}

/**
 * Rule 9: an agent may not sign off on its own risky change. The approver must
 * be a different identity — the other sales agent or an admin.
 */
export function assertNoSelfApproval(actor: string, approver: string | undefined): void {
  if (!approver) {
    throw new ConfirmationRequiredError('This operation requires an approver (approved_by)');
  }
  if (approver === actor) {
    throw new DomainError('FORBIDDEN', 'An agent cannot approve its own risky change', {
      actor,
    });
  }
}

/** Rule 3: assignment ownership check used before any CRM mutation on an account. */
export function assertOwnsAccount(params: {
  actor: string;
  holder: string | null;
  entity: string;
  isAdmin: boolean;
}): void {
  if (params.isAdmin) return;
  if (params.holder && params.holder !== params.actor) {
    throw new DomainError('FORBIDDEN', `${params.entity} is claimed by ${params.holder}`, {
      holder: params.holder,
    });
  }
}

/** Reject batches larger than the configured cap. */
export function assertBatchSize(count: number): void {
  if (count > MAX_WRITE_BATCH) {
    throw new DomainError(
      'INVALID_REQUEST',
      `Bulk operations are limited to ${MAX_WRITE_BATCH} record per call`,
      { requested: count },
    );
  }
}

/** Idempotency keys are required so a retried agent cannot double-create. */
export function assertIdempotencyKey(key: string | undefined): asserts key is string {
  if (!key || key.trim().length < 8) {
    throw new DomainError(
      'INVALID_REQUEST',
      'idempotency_key is required for write operations (min 8 characters)',
    );
  }
}

/**
 * Search guardrail: a query that is too broad would pull a large slice of the
 * 5 900-record base into an agent's context. Require a real selector.
 */
export function assertQueryIsSpecific(params: {
  query?: string;
  filtersProvided: number;
  minQueryLength?: number;
}): void {
  const min = params.minQueryLength ?? 3;
  const q = params.query?.trim() ?? '';
  if (q.length === 0 && params.filtersProvided === 0) {
    throw new DomainError(
      'INVALID_REQUEST',
      'Query is too broad: provide a search string or at least one filter',
    );
  }
  if (q.length > 0 && q.length < min) {
    throw new DomainError(
      'INVALID_REQUEST',
      `Search string must be at least ${min} characters (got ${q.length})`,
    );
  }
}

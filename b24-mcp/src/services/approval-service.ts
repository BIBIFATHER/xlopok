import { ConfirmationRequiredError, DomainError } from '../domain/errors.js';
import type { AgentId } from '../agents/roles.js';

/**
 * Approval policy for risky operations.
 *
 * Two kinds of guardrail live here:
 *  - PROHIBITED: never allowed through the gateway, at any role, with any flag;
 *  - APPROVAL_REQUIRED: allowed only with a second identity signing off, and
 *    never by the agent that requested it (rule 9).
 */

export const PROHIBITED_OPERATIONS = [
  'delete_record',
  'call_arbitrary_rest_method',
  'send_client_message',
  'send_email_to_client',
  'send_sms',
  'issue_invoice',
  'change_price',
  'change_deal_amount',
] as const;

export type ProhibitedOperation = (typeof PROHIBITED_OPERATIONS)[number];

export const APPROVAL_REQUIRED_OPERATIONS = [
  'close_deal_as_lost',
  'bulk_update',
  'bulk_create',
  'stage_change_backwards',
] as const;

export type ApprovalRequiredOperation = (typeof APPROVAL_REQUIRED_OPERATIONS)[number];

export interface ApprovalRequest {
  operation: ApprovalRequiredOperation;
  actor: AgentId;
  approver?: AgentId;
  reason: string;
  affected_count: number;
}

export interface ApprovalDecision {
  granted: boolean;
  operation: string;
  actor: AgentId;
  approver: AgentId | null;
  reason: string;
  decided_at: string;
}

/** Records every approval decision so the audit trail shows who signed off. */
export class ApprovalService {
  private readonly decisions: ApprovalDecision[] = [];

  constructor(
    private readonly maxWithoutApproval = 1,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Hard stop. Called by the tool layer before anything else. */
  assertNotProhibited(operation: string): void {
    if ((PROHIBITED_OPERATIONS as readonly string[]).includes(operation)) {
      throw new DomainError('FORBIDDEN', `Operation "${operation}" is permanently disabled`, {
        operation,
      });
    }
  }

  /** Batch guard: anything above the cap needs a human approver. */
  assertBatchAllowed(count: number, approver: AgentId | undefined, actor: AgentId): void {
    if (count <= this.maxWithoutApproval) return;
    if (!approver) {
      throw new ConfirmationRequiredError(
        `Bulk operation on ${count} records requires human approval`,
      );
    }
    if (approver !== 'admin') {
      throw new DomainError('FORBIDDEN', 'Bulk operations may only be approved by admin', {
        actor,
        approver,
      });
    }
  }

  /** Rule 9 — the requester can never be the approver. */
  request(req: ApprovalRequest): ApprovalDecision {
    if (!req.approver) {
      throw new ConfirmationRequiredError(
        `Operation "${req.operation}" requires an approver (approved_by)`,
      );
    }
    if (req.approver === req.actor) {
      throw new DomainError('FORBIDDEN', 'An agent cannot approve its own risky operation', {
        actor: req.actor,
        operation: req.operation,
      });
    }
    if (req.affected_count > this.maxWithoutApproval && req.approver !== 'admin') {
      throw new DomainError('FORBIDDEN', 'Bulk operations may only be approved by admin', {
        approver: req.approver,
      });
    }

    const decision: ApprovalDecision = {
      granted: true,
      operation: req.operation,
      actor: req.actor,
      approver: req.approver,
      reason: req.reason,
      decided_at: this.now().toISOString(),
    };
    this.decisions.push(decision);
    return decision;
  }

  history(): readonly ApprovalDecision[] {
    return this.decisions;
  }
}

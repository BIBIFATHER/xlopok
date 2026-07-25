import { loadEnv, type Env } from '../config/env.js';
import { AuthError, DomainError } from '../domain/errors.js';
import { tokensMatch } from '../security/auth.js';
import { registerSecret } from '../security/redaction.js';

/**
 * Agent identity model.
 *
 * `claude_sales_agent` and `codex_sales_agent` are two EQUAL general-purpose
 * wholesale sales agents. Neither is a seller-only nor an auditor-only role:
 * they share one toolset, one set of limits and one evaluation method. `admin`
 * is a human operator role used for approvals, transfers and reporting.
 */
export const AGENT_IDS = ['claude_sales_agent', 'codex_sales_agent', 'admin'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const SALES_AGENTS: readonly AgentId[] = ['claude_sales_agent', 'codex_sales_agent'];

export function isSalesAgent(id: AgentId): boolean {
  return SALES_AGENTS.includes(id);
}

/**
 * Capability set. Both sales agents get exactly the same list — any divergence
 * here would invalidate the A/B comparison, so the map is built from one
 * shared constant rather than written out twice.
 */
export const SHARED_SALES_CAPABILITIES = [
  'crm.read',
  'crm.create_company',
  'crm.create_contact',
  'crm.create_deal',
  'crm.add_note',
  'crm.add_call_summary',
  'crm.create_followup',
  'crm.update_next_step',
  'crm.propose_stage_change',
  'crm.prepare_outreach',
  'sales.claim',
  'sales.release',
  'sales.complete',
  'sales.transfer',
  'sales.own_metrics',
] as const;

export const ADMIN_CAPABILITIES = [
  ...SHARED_SALES_CAPABILITIES,
  'sales.all_metrics',
  'sales.force_release',
  'sales.approve_risky',
  'sales.ab_report',
] as const;

export type Capability =
  | (typeof SHARED_SALES_CAPABILITIES)[number]
  | (typeof ADMIN_CAPABILITIES)[number];

const CAPABILITIES: Record<AgentId, readonly Capability[]> = {
  claude_sales_agent: SHARED_SALES_CAPABILITIES,
  codex_sales_agent: SHARED_SALES_CAPABILITIES,
  admin: ADMIN_CAPABILITIES,
};

export interface Identity {
  agentId: AgentId;
  /** How the identity was established — recorded in the audit log. */
  via: 'env' | 'bearer';
}

export function capabilitiesOf(agentId: AgentId): readonly Capability[] {
  return CAPABILITIES[agentId];
}

export function hasCapability(agentId: AgentId, capability: Capability): boolean {
  return CAPABILITIES[agentId].includes(capability);
}

export function assertCapability(identity: Identity, capability: Capability): void {
  if (!hasCapability(identity.agentId, capability)) {
    throw new DomainError('FORBIDDEN', `Role ${identity.agentId} lacks capability ${capability}`);
  }
}

/** Identity for a locally spawned stdio process (one agent per process). */
export function identityFromEnv(env: Env = loadEnv()): Identity {
  return { agentId: env.AGENT_ID, via: 'env' };
}

/**
 * Identity for the HTTP transport. Each agent presents its own bearer token;
 * a shared token would make the audit log and the A/B split meaningless.
 */
export function identityFromBearer(
  authorizationHeader: string | undefined,
  env: Env = loadEnv(),
): Identity {
  const raw = authorizationHeader?.startsWith('Bearer ')
    ? authorizationHeader.slice('Bearer '.length).trim()
    : undefined;
  if (!raw) throw new AuthError('Unauthorized');

  const table: Array<[AgentId, string]> = [
    ['claude_sales_agent', env.CLAUDE_MCP_TOKEN],
    ['codex_sales_agent', env.CODEX_MCP_TOKEN],
    ['admin', env.ADMIN_MCP_TOKEN || env.MCP_AUTH_TOKEN],
  ];

  for (const [agentId, expected] of table) {
    if (expected && tokensMatch(raw, expected)) return { agentId, via: 'bearer' };
  }
  throw new AuthError('Unauthorized');
}

/** Register every configured token so it can never appear in a log line. */
export function registerAgentSecrets(env: Env = loadEnv()): void {
  registerSecret(env.MCP_AUTH_TOKEN);
  registerSecret(env.CLAUDE_MCP_TOKEN);
  registerSecret(env.CODEX_MCP_TOKEN);
  registerSecret(env.ADMIN_MCP_TOKEN);
}

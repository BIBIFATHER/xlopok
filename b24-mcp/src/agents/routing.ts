import { createHash } from 'node:crypto';
import type { Assignment, EntityType } from './assignments.js';
import { SALES_AGENTS, type AgentId } from './roles.js';
import type { AgentPerformance } from './metrics.js';

export type RoutingMode = 'round_robin' | 'performance_based' | 'specialization_based';

export interface RoutingDecision {
  agent: AgentId;
  mode: RoutingMode;
  /** Populated when the requested mode was not usable yet. */
  fallback_from?: RoutingMode;
  reason: string;
}

export interface WorkItem {
  entity_type: EntityType;
  entity_id: number;
  /** Optional hints used only by specialization_based routing. */
  segment?: string | null;
  stage?: string | null;
}

export interface RoutingInput {
  mode: RoutingMode;
  item: WorkItem;
  /** Every assignment ever created — used for counts and performance. */
  history: Assignment[];
  performance?: Record<AgentId, AgentPerformance | undefined>;
  /** performance_based stays inert below this per-agent sample. */
  minSample: number;
  /** Explicit specialization map; empty means "no proven specialization yet". */
  specialization?: Partial<Record<string, AgentId>>;
  abTestEnabled: boolean;
}

/**
 * Deterministic A/B bucket. Hashing the entity id guarantees that a company is
 * always evaluated by the same agent (no overlap between the two arms) and
 * that the split is ~50/50 across a base of ~5 900 records.
 */
export function abBucket(item: WorkItem): AgentId {
  const digest = createHash('sha256')
    .update(`${item.entity_type}:${item.entity_id}`)
    .digest();
  const index = digest[0]! % SALES_AGENTS.length;
  return SALES_AGENTS[index]!;
}

/** Assignments each agent has ever been given (transfers count for the receiver). */
export function assignmentCounts(history: Assignment[]): Record<AgentId, number> {
  const counts: Record<AgentId, number> = {
    claude_sales_agent: 0,
    codex_sales_agent: 0,
    admin: 0,
  };
  for (const a of history) counts[a.assigned_agent] += 1;
  return counts;
}

/**
 * Choose the agent for a work item.
 *
 * Both sales agents are equal by default: until each has processed a large
 * enough sample, performance_based degrades to round_robin rather than
 * concentrating work on whichever agent happens to be ahead.
 */
export function routeWorkItem(input: RoutingInput): RoutingDecision {
  if (input.abTestEnabled) {
    return {
      agent: abBucket(input.item),
      mode: input.mode,
      reason: 'A/B experiment active: agent fixed by deterministic bucket, no overlap allowed',
    };
  }

  switch (input.mode) {
    case 'specialization_based': {
      const key = input.item.segment ?? input.item.stage ?? null;
      const mapped = key ? input.specialization?.[key] : undefined;
      if (mapped) {
        return {
          agent: mapped,
          mode: 'specialization_based',
          reason: `Specialization rule for "${key}"`,
        };
      }
      return {
        ...roundRobin(input),
        mode: 'specialization_based',
        fallback_from: 'specialization_based',
        reason: 'No specialization rule matches this item — falling back to round robin',
      };
    }

    case 'performance_based': {
      const eligible = SALES_AGENTS.every(
        (id) => (input.performance?.[id]?.completed_assignments ?? 0) >= input.minSample,
      );
      if (!eligible) {
        return {
          ...roundRobin(input),
          mode: 'performance_based',
          fallback_from: 'performance_based',
          reason: `Insufficient sample (< ${input.minSample} completed assignments per agent) — agents stay equal, using round robin`,
        };
      }
      const ranked = [...SALES_AGENTS].sort(
        (a, b) => confirmedConversion(input, b) - confirmedConversion(input, a),
      );
      const leader = ranked[0]!;
      const counts = assignmentCounts(input.history);
      // Weighted, not exclusive: the trailing agent still receives ~1 in 3.
      const total = counts.claude_sales_agent + counts.codex_sales_agent;
      const agent = total % 3 === 2 ? ranked[1]! : leader;
      return {
        agent,
        mode: 'performance_based',
        reason: `Weighted by confirmed conversion (leader: ${leader})`,
      };
    }

    case 'round_robin':
    default:
      return roundRobin(input);
  }
}

function roundRobin(input: RoutingInput): RoutingDecision {
  const counts = assignmentCounts(input.history);
  const [a, b] = SALES_AGENTS as [AgentId, AgentId];
  const agent = counts[a] <= counts[b] ? a : b;
  return {
    agent,
    mode: 'round_robin',
    reason: `Round robin: ${a}=${counts[a]}, ${b}=${counts[b]}`,
  };
}

/** Confirmed conversion = paid deals / completed assignments. */
function confirmedConversion(input: RoutingInput, agent: AgentId): number {
  const perf = input.performance?.[agent];
  if (!perf || perf.completed_assignments === 0) return 0;
  return perf.paid / perf.completed_assignments;
}

import type { Assignment } from '../agents/assignments.js';
import {
  buildDailyRows,
  compareAgents,
  computePerformance,
  DailyPerformanceStore,
  type AgentPerformance,
  type ComparisonReport,
  type DailyPerformanceRow,
} from '../agents/metrics.js';
import { SALES_AGENTS, type AgentId } from '../agents/roles.js';
import { DomainError } from '../domain/errors.js';

export interface AbExperimentStatus {
  enabled: boolean;
  min_sample: number;
  sample: Record<AgentId, number>;
  balanced: boolean;
  /** Companies must never appear in both arms; verified from the store. */
  overlap: Array<{ entity_type: string; entity_id: number; agents: AgentId[] }>;
  ready_for_verdict: boolean;
}

/**
 * Reporting facade: daily rollups, the Claude-vs-Codex comparison and the
 * integrity checks the A/B protocol depends on.
 */
export class MetricsService {
  constructor(
    private readonly daily: DailyPerformanceStore,
    private readonly minSample: number,
    private readonly abEnabled: boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  performance(
    assignments: Assignment[],
    range: { from?: string; to?: string } = {},
  ): Record<AgentId, AgentPerformance> {
    return computePerformance(assignments, range);
  }

  /** Recompute `agent_performance_daily` and persist it. */
  async refreshDaily(assignments: Assignment[]): Promise<DailyPerformanceRow[]> {
    const rows = buildDailyRows(assignments);
    await this.daily.save(rows);
    return rows;
  }

  async loadDaily(): Promise<DailyPerformanceRow[]> {
    return this.daily.load();
  }

  report(assignments: Assignment[]): ComparisonReport {
    return compareAgents(this.performance(assignments), this.minSample, this.now());
  }

  /** Validity checks for the experiment: equal load, no shared companies. */
  experimentStatus(assignments: Assignment[]): AbExperimentStatus {
    const sample: Record<AgentId, number> = {
      claude_sales_agent: 0,
      codex_sales_agent: 0,
      admin: 0,
    };
    const byEntity = new Map<string, Set<AgentId>>();

    for (const a of assignments) {
      if (a.status === 'completed') sample[a.assigned_agent] += 1;
      const key = `${a.entity_type}:${a.entity_id}`;
      const set = byEntity.get(key) ?? new Set<AgentId>();
      if (a.assigned_agent !== 'admin') set.add(a.assigned_agent);
      byEntity.set(key, set);
    }

    const overlap: AbExperimentStatus['overlap'] = [];
    for (const [key, agents] of byEntity) {
      if (agents.size > 1) {
        const [entity_type, entity_id] = key.split(':') as [string, string];
        overlap.push({ entity_type, entity_id: Number(entity_id), agents: [...agents] });
      }
    }

    const counts = SALES_AGENTS.map((id) => sample[id]);
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    const balanced = max === 0 || (max - min) / max <= 0.1;

    return {
      enabled: this.abEnabled,
      min_sample: this.minSample,
      sample,
      balanced,
      overlap,
      ready_for_verdict:
        overlap.length === 0 && balanced && SALES_AGENTS.every((id) => sample[id] >= this.minSample),
    };
  }

  /** Guard used before anyone acts on a comparison. */
  assertVerdictAllowed(assignments: Assignment[]): void {
    const status = this.experimentStatus(assignments);
    if (!status.ready_for_verdict) {
      throw new DomainError(
        'INVALID_REQUEST',
        'Comparison is not conclusive yet: sample too small, load unbalanced or arms overlap',
        { status },
      );
    }
  }
}

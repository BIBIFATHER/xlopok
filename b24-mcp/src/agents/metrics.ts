import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Assignment } from './assignments.js';
import { SALES_AGENTS, type AgentId } from './roles.js';

/**
 * Agent evaluation.
 *
 * The comparison is deliberately NOT "who did more things". Ranking follows a
 * fixed priority order (paid deals → CRM correctness → stage conversion →
 * absence of risky actions → speed and cost), and no winner is declared until
 * both agents have a sufficient sample.
 */

export interface AgentPerformance {
  agent: AgentId;
  completed_assignments: number;

  /* funnel */
  qualified: number;
  contacted: number;
  replied: number;
  order_discussion: number;
  invoice_issued: number;
  paid: number;

  /* quality */
  correct_qualification_rate: number;
  clean_record_rate: number;
  next_actions_created: number;
  manual_corrections: number;
  duplicates_created: number;
  risky_operations_blocked: number;

  /* efficiency */
  avg_handling_seconds: number;
  cost_per_account: number;
  tokens_used: number;
  tokens_per_account: number;
}

export interface DailyPerformanceRow {
  /** Composite key: date + agent. */
  date: string;
  agent: AgentId;
  completed_assignments: number;
  qualified: number;
  contacted: number;
  replied: number;
  order_discussion: number;
  invoice_issued: number;
  paid: number;
  next_actions_created: number;
  manual_corrections: number;
  duplicates_created: number;
  risky_operations_blocked: number;
  avg_handling_seconds: number;
  cost_units: number;
  tokens_used: number;
}

const EMPTY = (agent: AgentId): AgentPerformance => ({
  agent,
  completed_assignments: 0,
  qualified: 0,
  contacted: 0,
  replied: 0,
  order_discussion: 0,
  invoice_issued: 0,
  paid: 0,
  correct_qualification_rate: 0,
  clean_record_rate: 0,
  next_actions_created: 0,
  manual_corrections: 0,
  duplicates_created: 0,
  risky_operations_blocked: 0,
  avg_handling_seconds: 0,
  cost_per_account: 0,
  tokens_used: 0,
  tokens_per_account: 0,
});

function inRange(a: Assignment, from?: string, to?: string): boolean {
  const ts = a.completed_at ?? a.created_at;
  if (from && ts < from) return false;
  if (to && ts > to) return false;
  return true;
}

export function computePerformance(
  assignments: Assignment[],
  range: { from?: string; to?: string } = {},
): Record<AgentId, AgentPerformance> {
  const out: Record<AgentId, AgentPerformance> = {
    claude_sales_agent: EMPTY('claude_sales_agent'),
    codex_sales_agent: EMPTY('codex_sales_agent'),
    admin: EMPTY('admin'),
  };

  const handling: Record<string, number[]> = {};
  const cost: Record<string, number[]> = {};

  for (const a of assignments) {
    if (a.status !== 'completed') continue;
    if (!inRange(a, range.from, range.to)) continue;

    const p = out[a.assigned_agent];
    p.completed_assignments += 1;

    switch (a.result) {
      case 'qualified':
        p.qualified += 1;
        break;
      case 'contacted':
        p.contacted += 1;
        break;
      case 'order_discussion':
        p.order_discussion += 1;
        break;
      case 'invoice_issued':
        p.invoice_issued += 1;
        break;
      case 'paid':
        p.paid += 1;
        break;
      default:
        break;
    }
    // A reply is implied by anything past first contact.
    if (
      a.result === 'contacted' ||
      a.result === 'order_discussion' ||
      a.result === 'invoice_issued' ||
      a.result === 'paid'
    ) {
      p.replied += 1;
    }

    p.next_actions_created += a.metrics.next_actions_created ?? 0;
    p.manual_corrections += a.metrics.manual_corrections ?? 0;
    p.duplicates_created += a.metrics.duplicates_detected ?? 0;
    p.risky_operations_blocked += a.metrics.risky_operations_blocked ?? 0;
    p.tokens_used += a.metrics.tokens_used ?? 0;

    (handling[a.assigned_agent] ??= []).push(a.metrics.handling_seconds ?? 0);
    (cost[a.assigned_agent] ??= []).push(a.metrics.cost_units ?? 0);
  }

  for (const agent of Object.keys(out) as AgentId[]) {
    const p = out[agent];
    const n = p.completed_assignments;
    if (n === 0) continue;
    p.correct_qualification_rate = round((n - p.manual_corrections) / n);
    p.clean_record_rate = round((n - p.duplicates_created - p.manual_corrections) / n);
    p.avg_handling_seconds = Math.round(avg(handling[agent] ?? []));
    p.cost_per_account = round(avg(cost[agent] ?? []));
    p.tokens_per_account = round(p.tokens_used / n);
  }

  return out;
}

/** Rows of the `agent_performance_daily` table. */
export function buildDailyRows(assignments: Assignment[]): DailyPerformanceRow[] {
  const byDay = new Map<string, Assignment[]>();
  for (const a of assignments) {
    if (a.status !== 'completed' || !a.completed_at) continue;
    const date = a.completed_at.slice(0, 10);
    for (const key of [`${date}|${a.assigned_agent}`]) {
      const list = byDay.get(key) ?? [];
      list.push(a);
      byDay.set(key, list);
    }
  }

  const rows: DailyPerformanceRow[] = [];
  for (const [key, list] of byDay) {
    const [date, agent] = key.split('|') as [string, AgentId];
    const perf = computePerformance(list)[agent];
    rows.push({
      date,
      agent,
      completed_assignments: perf.completed_assignments,
      qualified: perf.qualified,
      contacted: perf.contacted,
      replied: perf.replied,
      order_discussion: perf.order_discussion,
      invoice_issued: perf.invoice_issued,
      paid: perf.paid,
      next_actions_created: perf.next_actions_created,
      manual_corrections: perf.manual_corrections,
      duplicates_created: perf.duplicates_created,
      risky_operations_blocked: perf.risky_operations_blocked,
      avg_handling_seconds: perf.avg_handling_seconds,
      cost_units: round(perf.cost_per_account * perf.completed_assignments),
      tokens_used: perf.tokens_used,
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.agent.localeCompare(b.agent));
}

export interface ComparisonCriterion {
  priority: number;
  name: string;
  claude: number;
  codex: number;
  /** 'higher' or 'lower' is better. */
  direction: 'higher' | 'lower';
  leader: AgentId | 'tie';
}

export interface ComparisonReport {
  generated_at: string;
  sample: Record<AgentId, number>;
  sufficient_sample: boolean;
  min_sample: number;
  criteria: ComparisonCriterion[];
  /** null until both agents cleared the minimum sample. */
  winner: AgentId | 'tie' | null;
  note: string;
}

/**
 * Compare the two sales agents. Priority order is fixed and cannot be
 * overridden by raw activity counts.
 */
export function compareAgents(
  perf: Record<AgentId, AgentPerformance>,
  minSample: number,
  now = new Date(),
): ComparisonReport {
  const claude = perf.claude_sales_agent;
  const codex = perf.codex_sales_agent;

  const criteria: ComparisonCriterion[] = [
    crit(1, 'paid_deals', claude.paid, codex.paid, 'higher'),
    crit(2, 'crm_correctness', claude.clean_record_rate, codex.clean_record_rate, 'higher'),
    crit(
      3,
      'next_stage_conversion',
      rate(claude.order_discussion + claude.invoice_issued, claude.completed_assignments),
      rate(codex.order_discussion + codex.invoice_issued, codex.completed_assignments),
      'higher',
    ),
    crit(
      4,
      'risky_operations',
      claude.risky_operations_blocked,
      codex.risky_operations_blocked,
      'lower',
    ),
    crit(5, 'avg_handling_seconds', claude.avg_handling_seconds, codex.avg_handling_seconds, 'lower'),
    crit(5, 'cost_per_account', claude.cost_per_account, codex.cost_per_account, 'lower'),
  ];

  const sufficient =
    claude.completed_assignments >= minSample && codex.completed_assignments >= minSample;

  let winner: AgentId | 'tie' | null = null;
  if (sufficient) {
    winner = 'tie';
    for (const c of criteria.sort((a, b) => a.priority - b.priority)) {
      if (c.leader !== 'tie') {
        winner = c.leader;
        break;
      }
    }
  }

  return {
    generated_at: now.toISOString(),
    sample: {
      claude_sales_agent: claude.completed_assignments,
      codex_sales_agent: codex.completed_assignments,
      admin: perf.admin.completed_assignments,
    },
    sufficient_sample: sufficient,
    min_sample: minSample,
    criteria,
    winner,
    note: sufficient
      ? 'Winner derived from the fixed priority order, not from activity volume.'
      : `Both agents remain equal: fewer than ${minSample} completed assignments each.`,
  };
}

function crit(
  priority: number,
  name: string,
  claude: number,
  codex: number,
  direction: 'higher' | 'lower',
): ComparisonCriterion {
  let leader: AgentId | 'tie' = 'tie';
  if (claude !== codex) {
    const claudeWins = direction === 'higher' ? claude > codex : claude < codex;
    leader = claudeWins ? 'claude_sales_agent' : 'codex_sales_agent';
  }
  return { priority, name, claude, codex, direction, leader };
}

/** Persist the daily rollup so history survives restarts. */
export class DailyPerformanceStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'agent_performance_daily.json');
  }

  async save(rows: DailyPerformanceRow[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(rows, null, 2), 'utf8');
  }

  async load(): Promise<DailyPerformanceRow[]> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as DailyPerformanceRow[]) : [];
    } catch {
      return [];
    }
  }
}

export function activeSalesAgents(): readonly AgentId[] {
  return SALES_AGENTS;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

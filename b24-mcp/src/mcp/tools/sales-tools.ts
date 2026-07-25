import { z } from 'zod';
import type { ToolContext } from './context.js';
import type { ReadToolDefinition } from './read-tools.js';
import { DomainError } from '../../domain/errors.js';
import { AGENT_IDS, type AgentId } from '../../agents/roles.js';
import type { WorkItem } from '../../agents/routing.js';

/**
 * Work-distribution tools. They operate on gateway-local state
 * (`agent_assignments`) and never mutate Bitrix24, so they stay available even
 * with WRITE_ENABLED=false — that is what makes a safe read-only pilot possible
 * while still measuring both agents.
 */

const entityType = z.enum(['company', 'contact', 'deal']);
const agentId = z.enum(AGENT_IDS);
const idempotencyKey = z.string().min(8).max(120);

export function buildSalesTools(ctx: ToolContext): ReadToolDefinition[] {
  const actor = ctx.identity.agentId;
  const isAdmin = actor === 'admin';

  return [
    {
      name: 'sales_get_available_work',
      description:
        'Очередь работы: сделки без следующего действия, застрявшие сделки и просроченные касания. Показывает, что уже занято другим агентом и кого предлагает маршрутизатор.',
      schema: {
        kind: z
          .enum(['no_next_action', 'stale', 'overdue', 'all'])
          .default('all')
          .describe('Тип работы'),
        stale_threshold_days: z.number().int().min(1).max(365).default(14),
        limit: z.number().int().min(1).max(100).default(20),
      },
      handler: async (args: { kind: string; stale_threshold_days: number; limit: number }) => {
        const candidates: Array<WorkItem & { title: string; reason: string; priority: number }> = [];

        if (args.kind === 'no_next_action' || args.kind === 'all') {
          const rows = await ctx.followups.dealsWithoutNextAction({ limit: args.limit });
          for (const d of rows) {
            candidates.push({
              entity_type: 'deal',
              entity_id: d.id,
              stage: d.stageId,
              title: d.title,
              reason: 'Открытая сделка без следующего действия',
              priority: 1,
            });
          }
        }

        if (args.kind === 'stale' || args.kind === 'all') {
          const rows = await ctx.followups.staleDeals({
            thresholdDays: args.stale_threshold_days,
            limit: args.limit,
          });
          for (const d of rows) {
            candidates.push({
              entity_type: 'deal',
              entity_id: d.id,
              stage: d.stageId,
              title: d.title,
              reason: `Без движения ${d.daysInStage} дн.`,
              priority: 2,
            });
          }
        }

        if (args.kind === 'overdue' || args.kind === 'all') {
          const rows = await ctx.followups.overdueFollowups({ limit: args.limit });
          for (const f of rows) {
            if (f.dealId === null) continue;
            candidates.push({
              entity_type: 'deal',
              entity_id: f.dealId,
              title: f.title,
              reason: `Просрочено на ${f.daysOverdue ?? '?'} дн.`,
              priority: 0,
            });
          }
        }

        const unique = dedupeByEntity(candidates).sort((a, b) => a.priority - b.priority);
        const annotated = await ctx.assignmentService.annotate(unique.slice(0, args.limit), actor);

        return {
          routing_mode: ctx.env.ROUTING_MODE,
          ab_test_enabled: ctx.env.AB_TEST_ENABLED,
          count: annotated.length,
          items: annotated,
        };
      },
    },

    {
      name: 'sales_claim_account',
      description:
        'Атомарно закрепить компанию, контакт или сделку за собой. Если объект уже занят другим агентом — операция отклоняется.',
      schema: {
        entity_type: entityType,
        entity_id: z.number().int().positive(),
        reason: z.string().min(5).max(300),
        idempotency_key: idempotencyKey,
      },
      handler: async (args: {
        entity_type: 'company' | 'contact' | 'deal';
        entity_id: number;
        reason: string;
        idempotency_key: string;
      }) => {
        const assignment = await ctx.assignmentService.claim({
          entity_type: args.entity_type,
          entity_id: args.entity_id,
          agent: actor,
          reason: args.reason,
          idempotency_key: args.idempotency_key,
        });
        return {
          assignment,
          lock_expires_at: assignment.locked_until,
          lock_minutes: ctx.env.ASSIGNMENT_LOCK_MINUTES,
        };
      },
    },

    {
      name: 'sales_release_account',
      description: 'Снять с себя закрепление без завершения работы.',
      schema: { assignment_id: z.string().uuid() },
      handler: async (args: { assignment_id: string }) =>
        ctx.assignmentService.release(args.assignment_id, actor),
    },

    {
      name: 'sales_complete_assignment',
      description:
        'Завершить работу по закреплённому объекту с результатом и метриками. Метрики попадают в agent_performance_daily.',
      schema: {
        assignment_id: z.string().uuid(),
        result: z.enum([
          'qualified',
          'disqualified',
          'contacted',
          'no_answer',
          'order_discussion',
          'invoice_issued',
          'paid',
          'needs_human',
          'abandoned',
        ]),
        metrics: z
          .object({
            tool_calls: z.number().int().min(0).optional(),
            next_actions_created: z.number().int().min(0).optional(),
            records_created: z.number().int().min(0).optional(),
            duplicates_detected: z.number().int().min(0).optional(),
            risky_operations_blocked: z.number().int().min(0).optional(),
            manual_corrections: z.number().int().min(0).optional(),
            tokens_used: z.number().int().min(0).optional(),
            cost_units: z.number().min(0).optional(),
          })
          .default({}),
      },
      handler: async (args: { assignment_id: string; result: any; metrics: any }) => {
        const assignment = await ctx.assignmentService.complete(
          args.assignment_id,
          actor,
          args.result,
          args.metrics,
        );
        await ctx.metricsService.refreshDaily(await ctx.assignmentService.all());
        return assignment;
      },
    },

    {
      name: 'sales_transfer_account',
      description:
        'Передать закреплённый объект другому агенту с обязательной причиной. После превышения лимита передач объект уходит в HUMAN_REVIEW.',
      schema: {
        assignment_id: z.string().uuid(),
        to_agent: agentId,
        reason: z.string().min(10).max(300),
      },
      handler: async (args: { assignment_id: string; to_agent: AgentId; reason: string }) => {
        const assignment = await ctx.assignmentService.transfer(
          args.assignment_id,
          actor,
          args.to_agent,
          args.reason,
        );
        return {
          assignment,
          transfers_used: assignment.transfer_count,
          transfers_allowed: ctx.env.MAX_TRANSFERS,
          escalated: assignment.status === 'human_review',
        };
      },
    },

    {
      name: 'sales_get_my_assignments',
      description: 'Список активных закреплений текущего агента.',
      schema: {
        include_completed: z.boolean().default(false),
      },
      handler: async (args: { include_completed: boolean }) => {
        const rows = args.include_completed
          ? (await ctx.assignmentService.all()).filter((a) => a.assigned_agent === actor)
          : await ctx.assignmentService.mine(actor);
        return { agent: actor, count: rows.length, items: rows };
      },
    },

    {
      name: 'sales_get_agent_metrics',
      description:
        'Метрики агента и, для admin, отчёт A/B-сравнения Claude и Codex. Победитель не назначается, пока выборка недостаточна.',
      schema: {
        agent: agentId.optional().describe('Только admin может смотреть чужие метрики'),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        include_comparison: z.boolean().default(false),
      },
      handler: async (args: {
        agent?: AgentId;
        from?: string;
        to?: string;
        include_comparison: boolean;
      }) => {
        const target = args.agent ?? actor;
        if (target !== actor && !isAdmin) {
          throw new DomainError('FORBIDDEN', 'Only admin may read another agent’s metrics');
        }

        const all = await ctx.assignmentService.all();
        const perf = ctx.metricsService.performance(all, {
          ...(args.from !== undefined ? { from: args.from } : {}),
          ...(args.to !== undefined ? { to: args.to } : {}),
        });

        const base = {
          agent: target,
          performance: perf[target],
          daily: (await ctx.metricsService.loadDaily()).filter((r) => r.agent === target),
        };

        if (!args.include_comparison) return base;
        if (!isAdmin) {
          throw new DomainError('FORBIDDEN', 'Only admin may request the A/B comparison report');
        }

        return {
          ...base,
          experiment: ctx.metricsService.experimentStatus(all),
          comparison: ctx.metricsService.report(all),
        };
      },
    },
  ];
}

function dedupeByEntity<T extends WorkItem>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = `${i.entity_type}:${i.entity_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

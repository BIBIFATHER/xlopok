import type { ActivityRepository } from '../bitrix/activities.js';
import type { DealRepository } from '../bitrix/deals.js';
import { dealIdFromBindings, taskToNextAction, type TaskRepository } from '../bitrix/tasks.js';
import { isOverdue, type NextAction } from '../domain/activity.js';
import { daysBetween, toDealSummary, type Deal, type DealSummary } from '../domain/deal.js';

export interface OverdueFollowup extends NextAction {
  dealId: number | null;
  daysOverdue: number | null;
}

export interface StaleDeal extends DealSummary {
  daysInStage: number | null;
}

export interface DealWithoutNextAction extends DealSummary {
  daysSinceStageChange: number | null;
}

/**
 * Follow-up hygiene: what is overdue, what has no planned next step and what
 * has been sitting in one stage for too long.
 */
export class FollowupService {
  constructor(
    private readonly deals: DealRepository,
    private readonly activities: ActivityRepository,
    private readonly tasks: TaskRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Overdue open activities and overdue open tasks, merged and sorted. */
  async overdueFollowups(params: {
    assignedById?: number;
    limit: number;
  }): Promise<OverdueFollowup[]> {
    const now = this.now();
    const [activities, tasks] = await Promise.all([
      this.activities.overdue({
        now,
        ...(params.assignedById !== undefined ? { responsibleId: params.assignedById } : {}),
        limit: params.limit,
      }),
      this.tasks.overdue({
        now,
        ...(params.assignedById !== undefined ? { responsibleId: params.assignedById } : {}),
        limit: params.limit,
      }),
    ]);

    const fromActivities: OverdueFollowup[] = activities.map((a) => ({
      source: 'activity',
      id: a.id,
      title: a.subject,
      dueAt: a.deadlineAt,
      responsibleId: a.responsibleId,
      overdue: true,
      dealId: a.ownerType === 'deal' ? a.ownerId : null,
      daysOverdue: daysBetween(a.deadlineAt, now),
    }));

    const fromTasks: OverdueFollowup[] = tasks.map((t) => {
      const action = taskToNextAction(t, now);
      return {
        ...action,
        dealId: dealIdFromBindings(t.crmBindings),
        daysOverdue: t.deadlineAt ? daysBetween(t.deadlineAt, now) : null,
      };
    });

    return [...fromActivities, ...fromTasks]
      .sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? ''))
      .slice(0, params.limit);
  }

  /** Open deals with neither an open activity nor an open task attached. */
  async dealsWithoutNextAction(params: {
    assignedById?: number;
    categoryId?: number;
    limit: number;
  }): Promise<DealWithoutNextAction[]> {
    const now = this.now();
    const openDeals = await this.deals.searchAll({
      onlyOpen: true,
      ...(params.assignedById !== undefined ? { assignedById: params.assignedById } : {}),
      ...(params.categoryId !== undefined ? { categoryId: params.categoryId } : {}),
    });
    const ids = openDeals.map((d) => d.id);
    const [openActivities, openTasks] = await Promise.all([
      this.activities.openForDeals(ids),
      this.tasks.openForDeals(ids),
    ]);

    const covered = new Set<number>();
    for (const a of openActivities) if (a.ownerId !== null) covered.add(a.ownerId);
    for (const t of openTasks) {
      const dealId = dealIdFromBindings(t.crmBindings);
      if (dealId !== null) covered.add(dealId);
    }

    return openDeals
      .filter((d) => !covered.has(d.id))
      .slice(0, params.limit)
      .map((d) => ({
        ...toDealSummary(d),
        daysSinceStageChange: daysBetween(d.stageChangedAt ?? d.createdAt, now),
      }));
  }

  /** Open deals whose stage has not changed for at least `thresholdDays`. */
  async staleDeals(params: {
    thresholdDays: number;
    assignedById?: number;
    categoryId?: number;
    limit: number;
  }): Promise<StaleDeal[]> {
    const now = this.now();
    const openDeals = await this.deals.searchAll({
      onlyOpen: true,
      ...(params.assignedById !== undefined ? { assignedById: params.assignedById } : {}),
      ...(params.categoryId !== undefined ? { categoryId: params.categoryId } : {}),
    });

    return openDeals
      .map((d) => ({
        deal: d,
        days: daysBetween(d.stageChangedAt ?? d.createdAt, now),
      }))
      .filter((x) => x.days !== null && x.days >= params.thresholdDays)
      .sort((a, b) => (b.days ?? 0) - (a.days ?? 0))
      .slice(0, params.limit)
      .map((x) => ({ ...toDealSummary(x.deal), daysInStage: x.days }));
  }

  /** The single most relevant planned step for one deal. */
  async nextActionForDeal(dealId: number): Promise<NextAction | null> {
    const now = this.now();
    const [activities, tasks] = await Promise.all([
      this.activities.openFor('deal', dealId, 5),
      this.tasks.openFor('deal', dealId, 5),
    ]);

    const candidates: NextAction[] = [
      ...activities.map<NextAction>((a) => ({
        source: 'activity',
        id: a.id,
        title: a.subject,
        dueAt: a.deadlineAt,
        responsibleId: a.responsibleId,
        overdue: isOverdue(a.deadlineAt, now),
      })),
      ...tasks.map((t) => taskToNextAction(t, now)),
    ];

    if (candidates.length === 0) return null;
    return candidates.sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'))[0]!;
  }
}

export type { Deal };

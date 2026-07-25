import type { ActivityRepository } from '../bitrix/activities.js';
import type { DealRepository } from '../bitrix/deals.js';
import type { FollowupService } from './followup-service.js';

export interface StageBucket {
  stageId: string;
  count: number;
  totalOpportunity: number;
}

export interface SalesSummary {
  generatedAt: string;
  scope: { assignedById: number | null; categoryId: number | null; inactivityDays: number };
  openDeals: { count: number; totalOpportunity: number; currency: string | null };
  byStage: StageBucket[];
  overdueFollowups: number;
  dealsWithoutNextAction: number;
  dealsWithoutActivityInPeriod: number;
  /** Set when a cap was hit and the numbers are a lower bound. */
  truncated: boolean;
}

const MAX_DEALS_SCANNED = 500;

/** Portfolio-level health snapshot assembled from read-only calls. */
export class SalesAuditService {
  constructor(
    private readonly deals: DealRepository,
    private readonly activities: ActivityRepository,
    private readonly followups: FollowupService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async summary(params: {
    assignedById?: number;
    categoryId?: number;
    inactivityDays: number;
    limit: number;
  }): Promise<SalesSummary> {
    const now = this.now();
    const since = new Date(now.getTime() - params.inactivityDays * 86_400_000);

    const openDeals = await this.deals.searchAll(
      {
        onlyOpen: true,
        ...(params.assignedById !== undefined ? { assignedById: params.assignedById } : {}),
        ...(params.categoryId !== undefined ? { categoryId: params.categoryId } : {}),
      },
      MAX_DEALS_SCANNED,
    );

    const [overdue, withoutNext, activeDealIds] = await Promise.all([
      this.followups.overdueFollowups({
        ...(params.assignedById !== undefined ? { assignedById: params.assignedById } : {}),
        limit: params.limit,
      }),
      this.followups.dealsWithoutNextAction({
        ...(params.assignedById !== undefined ? { assignedById: params.assignedById } : {}),
        ...(params.categoryId !== undefined ? { categoryId: params.categoryId } : {}),
        limit: MAX_DEALS_SCANNED,
      }),
      this.activities.dealIdsWithActivitySince(since),
    ]);

    const buckets = new Map<string, StageBucket>();
    let totalOpportunity = 0;
    let currency: string | null = null;
    for (const deal of openDeals) {
      const stageId = deal.stageId ?? 'UNKNOWN';
      const bucket = buckets.get(stageId) ?? { stageId, count: 0, totalOpportunity: 0 };
      bucket.count += 1;
      bucket.totalOpportunity += deal.opportunity ?? 0;
      buckets.set(stageId, bucket);
      totalOpportunity += deal.opportunity ?? 0;
      currency ??= deal.currencyId;
    }

    const stale = openDeals.filter((d) => !activeDealIds.has(d.id)).length;

    return {
      generatedAt: now.toISOString(),
      scope: {
        assignedById: params.assignedById ?? null,
        categoryId: params.categoryId ?? null,
        inactivityDays: params.inactivityDays,
      },
      openDeals: { count: openDeals.length, totalOpportunity, currency },
      byStage: [...buckets.values()].sort((a, b) => b.count - a.count),
      overdueFollowups: overdue.length,
      dealsWithoutNextAction: withoutNext.length,
      dealsWithoutActivityInPeriod: stale,
      truncated: openDeals.length >= MAX_DEALS_SCANNED,
    };
  }
}

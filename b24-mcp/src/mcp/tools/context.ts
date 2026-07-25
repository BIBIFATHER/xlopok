import { ActivityRepository } from '../../bitrix/activities.js';
import { CompanyRepository } from '../../bitrix/companies.js';
import { ContactRepository } from '../../bitrix/contacts.js';
import { DealRepository } from '../../bitrix/deals.js';
import { TaskRepository } from '../../bitrix/tasks.js';
import type { BitrixClient } from '../../bitrix/client.js';
import { DuplicateService } from '../../services/duplicate-service.js';
import { FollowupService } from '../../services/followup-service.js';
import { SalesAuditService } from '../../services/sales-audit-service.js';
import { AuditLog } from '../../audit/audit-log.js';
import { CallBudget } from '../../security/rate-limit.js';
import { ReplayGuard } from '../../security/auth.js';
import { loadEnv, type Env } from '../../config/env.js';
import {
  FileAssignmentStore,
  type AssignmentStore,
} from '../../agents/assignments.js';
import { DailyPerformanceStore } from '../../agents/metrics.js';
import { identityFromEnv, type Identity } from '../../agents/roles.js';
import { AssignmentService } from '../../services/assignment-service.js';
import { MetricsService } from '../../services/metrics-service.js';
import { ApprovalService } from '../../services/approval-service.js';
import { DeadLetterQueue } from '../../services/dead-letter-queue.js';
import {
  FileIdempotencyStore,
  IdempotencyService,
  type IdempotencyStore,
} from '../../services/idempotency-service.js';
import { MAX_WRITE_BATCH } from '../permissions.js';

/** Everything a tool handler needs, assembled once at start-up. */
export interface ToolContext {
  env: Env;
  /** Identity of the caller this context serves. */
  identity: Identity;
  client: BitrixClient;
  companies: CompanyRepository;
  contacts: ContactRepository;
  deals: DealRepository;
  activities: ActivityRepository;
  tasks: TaskRepository;
  duplicates: DuplicateService;
  followups: FollowupService;
  salesAudit: SalesAuditService;
  assignments: AssignmentStore;
  assignmentService: AssignmentService;
  metricsService: MetricsService;
  approvals: ApprovalService;
  idempotency: IdempotencyService;
  deadLetters: DeadLetterQueue;
  performance: DailyPerformanceStore;
  audit: AuditLog;
  budget: CallBudget;
  replay: ReplayGuard;
  now: () => Date;
}

export interface BuildContextOptions {
  client: BitrixClient;
  env?: Env;
  identity?: Identity;
  audit?: AuditLog;
  assignments?: AssignmentStore;
  performance?: DailyPerformanceStore;
  idempotencyStore?: IdempotencyStore;
  now?: () => Date;
}

export function buildToolContext(opts: BuildContextOptions): ToolContext {
  const env = opts.env ?? loadEnv();
  const now = opts.now ?? (() => new Date());
  const audit = opts.audit ?? new AuditLog();
  const assignmentStore = opts.assignments ?? new FileAssignmentStore(env.DATA_DIR);
  const performance = opts.performance ?? new DailyPerformanceStore(env.DATA_DIR);

  const companies = new CompanyRepository(opts.client);
  const contacts = new ContactRepository(opts.client);
  const deals = new DealRepository(opts.client);
  const activities = new ActivityRepository(opts.client);
  const tasks = new TaskRepository(opts.client);

  const followups = new FollowupService(deals, activities, tasks, now);

  return {
    env,
    identity: opts.identity ?? identityFromEnv(env),
    client: opts.client,
    companies,
    contacts,
    deals,
    activities,
    tasks,
    duplicates: new DuplicateService(companies, contacts),
    followups,
    salesAudit: new SalesAuditService(deals, activities, followups, now),
    assignments: assignmentStore,
    assignmentService: new AssignmentService(assignmentStore, audit, env, now),
    metricsService: new MetricsService(
      performance,
      env.ROUTING_MIN_SAMPLE,
      env.AB_TEST_ENABLED,
      now,
    ),
    approvals: new ApprovalService(MAX_WRITE_BATCH, now),
    idempotency: new IdempotencyService(
      opts.idempotencyStore ?? new FileIdempotencyStore(env.DATA_DIR),
      now,
    ),
    deadLetters: new DeadLetterQueue(env.DATA_DIR),
    performance,
    audit,
    budget: new CallBudget(),
    replay: new ReplayGuard(),
    now,
  };
}

/** A context bound to a different caller, sharing all stateful singletons. */
export function withIdentity(ctx: ToolContext, identity: Identity): ToolContext {
  return { ...ctx, identity };
}

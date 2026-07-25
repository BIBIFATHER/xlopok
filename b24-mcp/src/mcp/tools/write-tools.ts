import { z } from 'zod';
import type { ToolContext } from './context.js';
import type { ReadToolDefinition } from './read-tools.js';
import { ENTITY_TYPE } from '../../bitrix/client.js';
import { companyField, dealField } from '../../bitrix/field-map.js';
import { DomainError } from '../../domain/errors.js';
import { normalizePhone } from '../../domain/contact.js';
import { OWNER_TYPE_ID } from '../../domain/activity.js';
import { crmBinding } from '../../bitrix/tasks.js';
import {
  assertBatchSize,
  assertIdempotencyKey,
  assertNoSelfApproval,
  assertOwnsAccount,
  assertStageTransitionAllowed,
} from '../permissions.js';
import type { EntityType } from '../../agents/assignments.js';

/**
 * Write tools. These are BUILT here but only REGISTERED when WRITE_ENABLED is
 * true (see server.ts) — with the flag off the names do not exist on the wire.
 *
 * Every handler follows the same contract:
 *   validate → check assignment ownership → check duplicates → build a diff →
 *   audit → (dry_run ? return the plan : apply) → audit the outcome.
 */

const positiveId = z.number().int().positive();
const idempotencyKey = z
  .string()
  .min(8)
  .max(120)
  .describe('Уникальный ключ операции; повтор с тем же ключом не создаст дубль');
const dryRun = z
  .boolean()
  .default(true)
  .describe('true — только показать план изменений, ничего не записывать');

export interface WriteDiff {
  entity: string;
  operation: 'create' | 'update' | 'append';
  target_id: number | null;
  changes: Array<{ field: string; from: unknown; to: unknown }>;
  side_effects: string[];
}

interface Plan {
  diff: WriteDiff;
  apply: () => Promise<unknown>;
  methods: string[];
}

export function buildWriteTools(ctx: ToolContext): ReadToolDefinition[] {
  const actor = ctx.identity.agentId;
  const isAdmin = actor === 'admin';

  /** Shared pre-flight + audit + dry-run wrapper. */
  async function run(
    tool: string,
    args: { idempotency_key: string; dry_run: boolean },
    build: () => Promise<Plan>,
  ): Promise<unknown> {
    assertIdempotencyKey(args.idempotency_key);
    assertBatchSize(1);

    const replayKey = `${tool}:${args.idempotency_key}`;
    if (!args.dry_run && !ctx.replay.claim(replayKey)) {
      throw new DomainError('INVALID_REQUEST', 'This idempotency_key was already used', {
        tool,
      });
    }

    const started = Date.now();
    const plan = await build();

    if (args.dry_run) {
      await ctx.audit.record({
        actor,
        tool,
        mode: 'dry-run',
        outcome: 'ok',
        methods: plan.methods,
        diff: plan.diff,
        idempotencyKey: args.idempotency_key,
        durationMs: Date.now() - started,
      });
      return { applied: false, dry_run: true, diff: plan.diff };
    }

    try {
      const result = await plan.apply();
      await ctx.audit.record({
        actor,
        tool,
        mode: 'write',
        outcome: 'ok',
        methods: plan.methods,
        diff: plan.diff,
        idempotencyKey: args.idempotency_key,
        durationMs: Date.now() - started,
      });
      return { applied: true, dry_run: false, diff: plan.diff, result };
    } catch (err) {
      await ctx.audit.record({
        actor,
        tool,
        mode: 'write',
        outcome: 'error',
        methods: plan.methods,
        idempotencyKey: args.idempotency_key,
        durationMs: Date.now() - started,
        error: err instanceof Error ? err.message : 'unknown error',
      });
      throw err;
    }
  }

  /** Rule 3 — refuse to touch an account another agent currently holds. */
  async function assertAccountFree(entity_type: EntityType, entity_id: number): Promise<void> {
    const held = await ctx.assignments.activeFor(entity_type, entity_id, ctx.now());
    assertOwnsAccount({
      actor,
      holder: held?.assigned_agent ?? null,
      entity: `${entity_type} ${entity_id}`,
      isAdmin,
    });
  }

  async function assertNoDuplicates(input: {
    title?: string;
    phones?: string[];
    emails?: string[];
    force: boolean;
  }): Promise<void> {
    const matches = await ctx.duplicates.findDuplicates({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.phones !== undefined ? { phones: input.phones } : {}),
      ...(input.emails !== undefined ? { emails: input.emails } : {}),
    });
    if (matches.length > 0 && !input.force) {
      throw new DomainError('DUPLICATE_FOUND', 'Possible duplicates found — review before creating', {
        matches,
      });
    }
  }

  /** Custom-field payload built only from fields the portal actually has. */
  function mapCustom(
    values: Record<string, unknown>,
    resolve: (name: never) => string | undefined,
  ): { fields: Record<string, unknown>; skipped: string[] } {
    const fields: Record<string, unknown> = {};
    const skipped: string[] = [];
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const code = resolve(name as never);
      if (!code) {
        skipped.push(name);
        continue;
      }
      fields[code] = value;
    }
    return { fields, skipped };
  }

  return [
    {
      name: 'crm_create_company',
      description:
        'Создание компании после обязательной проверки дублей. По умолчанию dry-run: возвращает план изменений без записи.',
      schema: {
        title: z.string().min(3).max(200),
        phones: z.array(z.string().min(5).max(30)).max(10).default([]),
        emails: z.array(z.string().email()).max(10).default([]),
        city: z.string().max(80).optional(),
        website: z.string().url().optional(),
        segment: z.string().max(80).optional(),
        assigned_by_id: positiveId.optional(),
        force_create_despite_duplicates: z.boolean().default(false),
        idempotency_key: idempotencyKey,
        dry_run: dryRun,
      },
      handler: async (args: any) =>
        run('crm_create_company', args, async () => {
          await assertNoDuplicates({
            title: args.title,
            phones: args.phones,
            emails: args.emails,
            force: args.force_create_despite_duplicates,
          });

          const custom = mapCustom(
            { segment: args.segment, city: args.city, website: args.website },
            companyField as (n: never) => string | undefined,
          );

          const fields: Record<string, unknown> = {
            title: args.title,
            ...(args.city ? { addressCity: args.city } : {}),
            ...(args.website ? { webUrl: args.website } : {}),
            ...(args.assigned_by_id ? { assignedById: args.assigned_by_id } : {}),
            ...(args.phones.length
              ? { phone: normalizePhones(args.phones).map((v) => ({ VALUE: v, VALUE_TYPE: 'WORK' })) }
              : {}),
            ...(args.emails.length
              ? { email: args.emails.map((v: string) => ({ VALUE: v, VALUE_TYPE: 'WORK' })) }
              : {}),
            ...custom.fields,
          };

          return {
            methods: ['crm.duplicate.findbycomm', 'crm.item.add'],
            diff: {
              entity: 'company',
              operation: 'create',
              target_id: null,
              changes: Object.entries(fields).map(([field, to]) => ({ field, from: null, to })),
              side_effects: custom.skipped.length
                ? [`Поля без маппинга в field-map пропущены: ${custom.skipped.join(', ')}`]
                : [],
            },
            apply: () =>
              ctx.client.call('crm.item.add', { entityTypeId: ENTITY_TYPE.COMPANY, fields }),
          };
        }),
    },

    {
      name: 'crm_create_contact',
      description: 'Создание контакта после проверки дублей по телефону и email. По умолчанию dry-run.',
      schema: {
        first_name: z.string().min(1).max(80),
        last_name: z.string().max(80).optional(),
        post: z.string().max(120).optional(),
        company_id: positiveId.optional(),
        phones: z.array(z.string().min(5).max(30)).max(10).default([]),
        emails: z.array(z.string().email()).max(10).default([]),
        assigned_by_id: positiveId.optional(),
        force_create_despite_duplicates: z.boolean().default(false),
        idempotency_key: idempotencyKey,
        dry_run: dryRun,
      },
      handler: async (args: any) =>
        run('crm_create_contact', args, async () => {
          if (args.company_id) await assertAccountFree('company', args.company_id);
          await assertNoDuplicates({
            phones: args.phones,
            emails: args.emails,
            force: args.force_create_despite_duplicates,
          });

          const fields: Record<string, unknown> = {
            name: args.first_name,
            ...(args.last_name ? { lastName: args.last_name } : {}),
            ...(args.post ? { post: args.post } : {}),
            ...(args.company_id ? { companyId: args.company_id } : {}),
            ...(args.assigned_by_id ? { assignedById: args.assigned_by_id } : {}),
            ...(args.phones.length
              ? { phone: normalizePhones(args.phones).map((v) => ({ VALUE: v, VALUE_TYPE: 'WORK' })) }
              : {}),
            ...(args.emails.length
              ? { email: args.emails.map((v: string) => ({ VALUE: v, VALUE_TYPE: 'WORK' })) }
              : {}),
          };

          return {
            methods: ['crm.duplicate.findbycomm', 'crm.item.add'],
            diff: {
              entity: 'contact',
              operation: 'create',
              target_id: null,
              changes: Object.entries(fields).map(([field, to]) => ({ field, from: null, to })),
              side_effects: [],
            },
            apply: () =>
              ctx.client.call('crm.item.add', { entityTypeId: ENTITY_TYPE.CONTACT, fields }),
          };
        }),
    },

    {
      name: 'crm_create_deal',
      description:
        'Создание сделки по компании. Цена и стадия закрытия не задаются — только рабочие поля. По умолчанию dry-run.',
      schema: {
        title: z.string().min(3).max(200),
        company_id: positiveId,
        contact_id: positiveId.optional(),
        category_id: z.number().int().min(0).optional(),
        stage_id: z.string().max(64).optional(),
        assigned_by_id: positiveId.optional(),
        need: z.string().max(500).optional(),
        estimated_quantity: z.number().int().min(0).optional(),
        next_step: z.string().max(200).optional(),
        next_step_at: z.string().datetime().optional(),
        idempotency_key: idempotencyKey,
        dry_run: dryRun,
      },
      handler: async (args: any) =>
        run('crm_create_deal', args, async () => {
          await assertAccountFree('company', args.company_id);
          if (args.stage_id) assertStageTransitionAllowed(args.stage_id);

          const custom = mapCustom(
            {
              need: args.need,
              estimated_quantity: args.estimated_quantity,
              next_step: args.next_step,
              next_step_at: args.next_step_at,
            },
            dealField as (n: never) => string | undefined,
          );

          const fields: Record<string, unknown> = {
            title: args.title,
            companyId: args.company_id,
            ...(args.contact_id ? { contactIds: [args.contact_id] } : {}),
            ...(args.category_id !== undefined ? { categoryId: args.category_id } : {}),
            ...(args.stage_id ? { stageId: args.stage_id } : {}),
            ...(args.assigned_by_id ? { assignedById: args.assigned_by_id } : {}),
            ...custom.fields,
          };

          return {
            methods: ['crm.item.add'],
            diff: {
              entity: 'deal',
              operation: 'create',
              target_id: null,
              changes: Object.entries(fields).map(([field, to]) => ({ field, from: null, to })),
              side_effects: [
                'Сумма и валюта не заполняются шлюзом — цены задаёт человек',
                ...(custom.skipped.length
                  ? [`Поля без маппинга пропущены: ${custom.skipped.join(', ')}`]
                  : []),
              ],
            },
            apply: () => ctx.client.call('crm.item.add', { entityTypeId: ENTITY_TYPE.DEAL, fields }),
          };
        }),
    },

    {
      name: 'crm_add_note',
      description: 'Добавление комментария в таймлайн компании, контакта или сделки.',
      schema: {
        entity_type: z.enum(['company', 'contact', 'deal']),
        entity_id: positiveId,
        text: z.string().min(3).max(4000),
        idempotency_key: idempotencyKey,
        dry_run: dryRun,
      },
      handler: async (args: any) =>
        run('crm_add_note', args, async () => {
          await assertAccountFree(args.entity_type, args.entity_id);
          const fields = {
            ENTITY_ID: args.entity_id,
            ENTITY_TYPE: args.entity_type,
            COMMENT: args.text,
          };
          return {
            methods: ['crm.timeline.comment.add'],
            diff: {
              entity: args.entity_type,
              operation: 'append',
              target_id: args.entity_id,
              changes: [{ field: 'timeline_comment', from: null, to: args.text }],
              side_effects: ['Комментарий виден пользователям портала; клиенту ничего не уходит'],
            },
            apply: () => ctx.client.call('crm.timeline.comment.add', { fields }),
          };
        }),
    },

    {
      name: 'crm_add_call_summary',
      description:
        'Резюме звонка в таймлайн: итог, договорённости и следующий шаг. Структурированный текст, никаких сообщений клиенту.',
      schema: {
        entity_type: z.enum(['company', 'contact', 'deal']),
        entity_id: positiveId,
        outcome: z.enum([
          'connected',
          'no_answer',
          'callback_requested',
          'not_interested',
          'qualified',
        ]),
        summary: z.string().min(10).max(4000),
        agreements: z.array(z.string().max(300)).max(10).default([]),
        next_step: z.string().max(300).optional(),
        next_step_at: z.string().datetime().optional(),
        idempotency_key: idempotencyKey,
        dry_run: dryRun,
      },
      handler: async (args: any) =>
        run('crm_add_call_summary', args, async () => {
          await assertAccountFree(args.entity_type, args.entity_id);
          const text = [
            `Итог звонка: ${args.outcome}`,
            '',
            args.summary,
            ...(args.agreements.length
              ? ['', 'Договорённости:', ...args.agreements.map((a: string) => `— ${a}`)]
              : []),
            ...(args.next_step ? ['', `Следующий шаг: ${args.next_step}`] : []),
            ...(args.next_step_at ? [`Срок: ${args.next_step_at}`] : []),
            '',
            `Автор записи: ${actor}`,
          ].join('\n');

          return {
            methods: ['crm.timeline.comment.add'],
            diff: {
              entity: args.entity_type,
              operation: 'append',
              target_id: args.entity_id,
              changes: [{ field: 'call_summary', from: null, to: text }],
              side_effects: ['Следующая задача не создаётся автоматически — используйте crm_create_followup'],
            },
            apply: () =>
              ctx.client.call('crm.timeline.comment.add', {
                fields: {
                  ENTITY_ID: args.entity_id,
                  ENTITY_TYPE: args.entity_type,
                  COMMENT: text,
                },
              }),
          };
        }),
    },

    {
      name: 'crm_create_followup',
      description:
        'Создание следующего действия (задачи) по компании, контакту или сделке с конкретным сроком.',
      schema: {
        entity_type: z.enum(['company', 'contact', 'deal']),
        entity_id: positiveId,
        title: z.string().min(5).max(200),
        description: z.string().max(2000).optional(),
        deadline: z.string().datetime(),
        responsible_id: positiveId,
        idempotency_key: idempotencyKey,
        dry_run: dryRun,
      },
      handler: async (args: any) =>
        run('crm_create_followup', args, async () => {
          await assertAccountFree(args.entity_type, args.entity_id);
          if (Date.parse(args.deadline) < ctx.now().getTime()) {
            throw new DomainError('INVALID_REQUEST', 'Deadline must be in the future');
          }
          const fields = {
            TITLE: args.title,
            DESCRIPTION: args.description ?? '',
            RESPONSIBLE_ID: args.responsible_id,
            DEADLINE: args.deadline,
            UF_CRM_TASK: [crmBinding(args.entity_type as 'deal', args.entity_id)],
          };
          return {
            methods: ['tasks.task.add'],
            diff: {
              entity: 'task',
              operation: 'create',
              target_id: null,
              changes: Object.entries(fields).map(([field, to]) => ({ field, from: null, to })),
              side_effects: [`Задача привязана к ${args.entity_type} ${args.entity_id}`],
            },
            apply: () => ctx.client.call('tasks.task.add', { fields }),
          };
        }),
    },

    {
      name: 'crm_update_next_step',
      description:
        'Обновление безопасных полей сделки: следующий шаг, срок, потребность и оценка объёма. Сумма, валюта и стадия здесь не меняются.',
      schema: {
        deal_id: positiveId,
        next_step: z.string().max(300).optional(),
        next_step_at: z.string().datetime().optional(),
        need: z.string().max(500).optional(),
        estimated_quantity: z.number().int().min(0).optional(),
        ai_summary: z.string().max(2000).optional(),
        ai_confidence: z.number().min(0).max(1).optional(),
        idempotency_key: idempotencyKey,
        dry_run: dryRun,
      },
      handler: async (args: any) =>
        run('crm_update_next_step', args, async () => {
          await assertAccountFree('deal', args.deal_id);
          const before = await ctx.deals.getById(args.deal_id);

          const requested: Record<string, unknown> = {
            next_step: args.next_step,
            next_step_at: args.next_step_at,
            need: args.need,
            estimated_quantity: args.estimated_quantity,
            ai_summary: args.ai_summary,
            ai_confidence: args.ai_confidence,
          };
          const custom = mapCustom(requested, dealField as (n: never) => string | undefined);

          if (Object.keys(custom.fields).length === 0) {
            throw new DomainError(
              'INVALID_REQUEST',
              custom.skipped.length
                ? `None of the requested fields are mapped in field-map: ${custom.skipped.join(', ')}`
                : 'Nothing to update',
            );
          }

          return {
            methods: ['crm.item.get', 'crm.item.update'],
            diff: {
              entity: 'deal',
              operation: 'update',
              target_id: args.deal_id,
              changes: Object.entries(requested)
                .filter(([name, value]) => value !== undefined && !custom.skipped.includes(name))
                .map(([name, to]) => ({
                  field: name,
                  from: (before.custom as Record<string, unknown>)[name] ?? null,
                  to,
                })),
              side_effects: custom.skipped.length
                ? [`Поля без маппинга пропущены: ${custom.skipped.join(', ')}`]
                : [],
            },
            apply: () =>
              ctx.client.call('crm.item.update', {
                entityTypeId: ENTITY_TYPE.DEAL,
                id: args.deal_id,
                fields: custom.fields,
              }),
          };
        }),
    },

    {
      name: 'crm_update_deal_stage',
      description:
        'Предложение и применение смены стадии сделки. Перевод в проигрыш требует подтверждения другим участником (approved_by).',
      schema: {
        deal_id: positiveId,
        target_stage_id: z.string().min(1).max(64),
        reason: z.string().min(5).max(500),
        approved_by: z
          .enum(['claude_sales_agent', 'codex_sales_agent', 'admin'])
          .optional()
          .describe('Требуется для перевода в проигрышную стадию; не может совпадать с автором'),
        idempotency_key: idempotencyKey,
        dry_run: dryRun,
      },
      handler: async (args: any) =>
        run('crm_update_deal_stage', args, async () => {
          await assertAccountFree('deal', args.deal_id);
          const before = await ctx.deals.getById(args.deal_id);

          const lost = /^(LOSE|APOLOGY)/i.test(
            (args.target_stage_id as string).split(':').pop() ?? '',
          );
          if (lost) {
            // Rule 9: no self-approval of a risky change.
            assertNoSelfApproval(actor, args.approved_by);
            assertStageTransitionAllowed(args.target_stage_id, { humanConfirmed: true });
          } else {
            assertStageTransitionAllowed(args.target_stage_id);
          }

          return {
            methods: ['crm.item.get', 'crm.item.update'],
            diff: {
              entity: 'deal',
              operation: 'update',
              target_id: args.deal_id,
              changes: [
                { field: 'stageId', from: before.stageId, to: args.target_stage_id },
                { field: 'reason', from: null, to: args.reason },
              ],
              side_effects: lost
                ? [`Проигрыш подтверждён: ${args.approved_by}`]
                : ['Сумма и валюта сделки не изменяются'],
            },
            apply: () =>
              ctx.client.call('crm.item.update', {
                entityTypeId: ENTITY_TYPE.DEAL,
                id: args.deal_id,
                fields: { stageId: args.target_stage_id },
              }),
          };
        }),
    },
  ];
}

function normalizePhones(values: string[]): string[] {
  return values.map((v) => normalizePhone(v) ?? v);
}

export { OWNER_TYPE_ID };

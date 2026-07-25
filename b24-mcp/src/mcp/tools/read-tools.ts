import { z } from 'zod';
import type { ToolContext } from './context.js';
import { assertQueryIsSpecific } from '../permissions.js';
import { DuplicateService } from '../../services/duplicate-service.js';
import { toCompanySummary } from '../../domain/company.js';
import { toContactSummary } from '../../domain/contact.js';
import { toDealSummary } from '../../domain/deal.js';
import { DomainError, NotFoundError } from '../../domain/errors.js';
import { prepareOutreach } from '../../services/outreach-service.js';

/**
 * Read-only tools. None of them accepts a REST method name, a raw filter or a
 * field code — the shape below is the entire attack surface exposed to agents.
 */

const positiveId = z.number().int().positive();

function limitSchema(ctx: ToolContext) {
  return z.number().int().min(1).max(ctx.env.MAX_PAGE_SIZE).default(20);
}

export interface ReadToolDefinition {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: any) => Promise<unknown>;
}

export function buildReadTools(ctx: ToolContext): ReadToolDefinition[] {
  const limit = limitSchema(ctx);
  const offset = z.number().int().min(0).max(10_000).default(0);

  return [
    {
      name: 'crm_search_companies',
      description:
        'Поиск компаний по названию, телефону, email или городу. Телефон и email ищутся через индекс дублей Битрикс24. Возвращает нормализованный постраничный список.',
      schema: {
        query: z
          .string()
          .min(3)
          .max(120)
          .optional()
          .describe('Название, телефон или email. Тип определяется автоматически.'),
        city: z.string().min(2).max(80).optional(),
        assigned_by_id: positiveId.optional().describe('ID ответственного менеджера'),
        limit,
        offset,
      },
      handler: async (args: {
        query?: string;
        city?: string;
        assigned_by_id?: number;
        limit: number;
        offset: number;
      }) => {
        assertQueryIsSpecific({
          ...(args.query !== undefined ? { query: args.query } : {}),
          filtersProvided: [args.city, args.assigned_by_id].filter((v) => v !== undefined).length,
        });

        if (args.query) {
          const classified = DuplicateService.classifyQuery(args.query);
          if (classified.kind !== 'text') {
            const items = await ctx.duplicates.companiesByCommunication(
              classified.kind,
              classified.value,
            );
            return {
              matched_by: classified.kind,
              total: items.length,
              next_offset: null,
              items: items.slice(0, args.limit).map(toCompanySummary),
            };
          }
        }

        const result = await ctx.companies.search({
          ...(args.query !== undefined ? { title: args.query } : {}),
          ...(args.city !== undefined ? { city: args.city } : {}),
          ...(args.assigned_by_id !== undefined ? { assignedById: args.assigned_by_id } : {}),
          limit: args.limit,
          offset: args.offset,
        });

        return {
          matched_by: 'title',
          total: result.total,
          next_offset: result.nextOffset,
          items: result.items.map(toCompanySummary),
        };
      },
    },

    {
      name: 'crm_get_company',
      description:
        'Карточка компании: реквизиты, связанные контакты, открытые сделки, последние касания и следующее запланированное действие.',
      schema: {
        company_id: positiveId,
        activities_limit: z.number().int().min(1).max(50).default(10),
      },
      handler: async (args: { company_id: number; activities_limit: number }) => {
        const company = await ctx.companies.getById(args.company_id);
        const [contacts, deals, activities] = await Promise.all([
          ctx.contacts.findByCompany(company.id, 25),
          ctx.deals.findByCompany(company.id, true, 25),
          ctx.activities.recentFor('company', company.id, args.activities_limit),
        ]);

        const nextActions = await Promise.all(
          deals.slice(0, 5).map((d) => ctx.followups.nextActionForDeal(d.id)),
        );
        const nextAction =
          nextActions
            .filter((a): a is NonNullable<typeof a> => a !== null)
            .sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'))[0] ?? null;

        return {
          company,
          contacts: contacts.map(toContactSummary),
          open_deals: deals.map(toDealSummary),
          recent_activities: activities,
          next_action: nextAction,
        };
      },
    },

    {
      name: 'crm_search_contacts',
      description:
        'Поиск контактов по имени, телефону, email или компании. Телефоны нормализуются перед поиском. Слишком широкие запросы отклоняются.',
      schema: {
        query: z.string().min(3).max(120).optional(),
        company_id: positiveId.optional(),
        assigned_by_id: positiveId.optional(),
        limit,
        offset,
      },
      handler: async (args: {
        query?: string;
        company_id?: number;
        assigned_by_id?: number;
        limit: number;
        offset: number;
      }) => {
        assertQueryIsSpecific({
          ...(args.query !== undefined ? { query: args.query } : {}),
          filtersProvided: [args.company_id, args.assigned_by_id].filter((v) => v !== undefined)
            .length,
        });

        if (args.query) {
          const classified = DuplicateService.classifyQuery(args.query);
          if (classified.kind !== 'text') {
            const items = await ctx.duplicates.contactsByCommunication(
              classified.kind,
              classified.value,
            );
            return {
              matched_by: classified.kind,
              normalized_query: classified.value,
              total: items.length,
              next_offset: null,
              items: items.slice(0, args.limit).map(toContactSummary),
            };
          }
        }

        const result = await ctx.contacts.search({
          ...(args.query !== undefined ? { name: args.query } : {}),
          ...(args.company_id !== undefined ? { companyId: args.company_id } : {}),
          ...(args.assigned_by_id !== undefined ? { assignedById: args.assigned_by_id } : {}),
          limit: args.limit,
          offset: args.offset,
        });

        return {
          matched_by: 'name',
          total: result.total,
          next_offset: result.nextOffset,
          items: result.items.map(toContactSummary),
        };
      },
    },

    {
      name: 'crm_get_contact',
      description:
        'Карточка контакта: данные, компания, связанные сделки и история последних касаний.',
      schema: {
        contact_id: positiveId,
        activities_limit: z.number().int().min(1).max(50).default(10),
      },
      handler: async (args: { contact_id: number; activities_limit: number }) => {
        const contact = await ctx.contacts.getById(args.contact_id);
        const [company, deals, activities] = await Promise.all([
          contact.companyId ? ctx.companies.getById(contact.companyId).catch(() => null) : null,
          ctx.deals.findByContact(contact.id, 25),
          ctx.activities.recentFor('contact', contact.id, args.activities_limit),
        ]);

        return {
          contact,
          company: company ? toCompanySummary(company) : null,
          deals: deals.map(toDealSummary),
          recent_activities: activities,
        };
      },
    },

    {
      name: 'crm_search_deals',
      description:
        'Поиск сделок по стадии, ответственному, компании и датам создания. Возвращает только безопасный набор полей.',
      schema: {
        stage_id: z.string().min(1).max(64).optional(),
        category_id: z.number().int().min(0).optional().describe('ID воронки'),
        assigned_by_id: positiveId.optional(),
        company_id: positiveId.optional(),
        contact_id: positiveId.optional(),
        created_from: z.string().datetime().optional(),
        created_to: z.string().datetime().optional(),
        only_open: z.boolean().default(true),
        limit,
        offset,
      },
      handler: async (args: {
        stage_id?: string;
        category_id?: number;
        assigned_by_id?: number;
        company_id?: number;
        contact_id?: number;
        created_from?: string;
        created_to?: string;
        only_open: boolean;
        limit: number;
        offset: number;
      }) => {
        const result = await ctx.deals.search({
          ...(args.stage_id !== undefined ? { stageId: args.stage_id } : {}),
          ...(args.category_id !== undefined ? { categoryId: args.category_id } : {}),
          ...(args.assigned_by_id !== undefined ? { assignedById: args.assigned_by_id } : {}),
          ...(args.company_id !== undefined ? { companyId: args.company_id } : {}),
          ...(args.contact_id !== undefined ? { contactId: args.contact_id } : {}),
          ...(args.created_from !== undefined ? { createdFrom: args.created_from } : {}),
          ...(args.created_to !== undefined ? { createdTo: args.created_to } : {}),
          onlyOpen: args.only_open,
          limit: args.limit,
          offset: args.offset,
        });

        return {
          total: result.total,
          next_offset: result.nextOffset,
          items: result.items.map(toDealSummary),
        };
      },
    },

    {
      name: 'crm_get_deal',
      description:
        'Карточка сделки: основные поля, компания, контакты, последние активности, следующее действие и причина проигрыша (если поле настроено).',
      schema: {
        deal_id: positiveId,
        activities_limit: z.number().int().min(1).max(50).default(10),
      },
      handler: async (args: { deal_id: number; activities_limit: number }) => {
        const deal = await ctx.deals.getById(args.deal_id);
        const [company, contacts, activities, nextAction] = await Promise.all([
          deal.companyId ? ctx.companies.getById(deal.companyId).catch(() => null) : null,
          ctx.contacts.getManyByIds(deal.contactIds.slice(0, 20)),
          ctx.activities.recentFor('deal', deal.id, args.activities_limit),
          ctx.followups.nextActionForDeal(deal.id),
        ]);

        return {
          deal,
          company: company ? toCompanySummary(company) : null,
          contacts: contacts.map(toContactSummary),
          recent_activities: activities,
          next_action: nextAction,
          loss_reason: deal.custom.loss_reason ?? null,
        };
      },
    },

    {
      name: 'crm_get_overdue_followups',
      description:
        'Просроченные касания: незавершённые дела и задачи с истёкшим дедлайном. Можно ограничить одним менеджером.',
      schema: {
        assigned_by_id: positiveId.optional(),
        limit,
      },
      handler: async (args: { assigned_by_id?: number; limit: number }) => {
        const items = await ctx.followups.overdueFollowups({
          ...(args.assigned_by_id !== undefined ? { assignedById: args.assigned_by_id } : {}),
          limit: args.limit,
        });
        return { generated_at: ctx.now().toISOString(), count: items.length, items };
      },
    },

    {
      name: 'crm_get_deals_without_next_action',
      description:
        'Открытые сделки, у которых нет ни одного запланированного дела и ни одной открытой задачи.',
      schema: {
        assigned_by_id: positiveId.optional(),
        category_id: z.number().int().min(0).optional(),
        limit,
      },
      handler: async (args: {
        assigned_by_id?: number;
        category_id?: number;
        limit: number;
      }) => {
        const items = await ctx.followups.dealsWithoutNextAction({
          ...(args.assigned_by_id !== undefined ? { assignedById: args.assigned_by_id } : {}),
          ...(args.category_id !== undefined ? { categoryId: args.category_id } : {}),
          limit: args.limit,
        });
        return { generated_at: ctx.now().toISOString(), count: items.length, items };
      },
    },

    {
      name: 'crm_get_stale_deals',
      description:
        'Сделки, застрявшие на одной стадии дольше указанного числа дней (по дате последнего перехода стадии).',
      schema: {
        threshold_days: z.number().int().min(1).max(365).default(14),
        assigned_by_id: positiveId.optional(),
        category_id: z.number().int().min(0).optional(),
        limit,
      },
      handler: async (args: {
        threshold_days: number;
        assigned_by_id?: number;
        category_id?: number;
        limit: number;
      }) => {
        const items = await ctx.followups.staleDeals({
          thresholdDays: args.threshold_days,
          ...(args.assigned_by_id !== undefined ? { assignedById: args.assigned_by_id } : {}),
          ...(args.category_id !== undefined ? { categoryId: args.category_id } : {}),
          limit: args.limit,
        });
        return {
          generated_at: ctx.now().toISOString(),
          threshold_days: args.threshold_days,
          count: items.length,
          items,
        };
      },
    },

    {
      name: 'crm_get_sales_summary',
      description:
        'Сводка по продажам: открытые сделки, распределение по стадиям, просроченные касания, сделки без следующего шага и без активности за период.',
      schema: {
        assigned_by_id: positiveId.optional(),
        category_id: z.number().int().min(0).optional(),
        inactivity_days: z.number().int().min(1).max(365).default(14),
        limit,
      },
      handler: async (args: {
        assigned_by_id?: number;
        category_id?: number;
        inactivity_days: number;
        limit: number;
      }) => {
        return ctx.salesAudit.summary({
          ...(args.assigned_by_id !== undefined ? { assignedById: args.assigned_by_id } : {}),
          ...(args.category_id !== undefined ? { categoryId: args.category_id } : {}),
          inactivityDays: args.inactivity_days,
          limit: args.limit,
        });
      },
    },

    {
      name: 'crm_find_duplicates',
      description:
        'Проверка на дубли по телефону, email и названию до создания записи. Обязательный шаг перед любым crm_create_*.',
      schema: {
        title: z.string().min(3).max(200).optional(),
        phones: z.array(z.string().min(5).max(30)).max(20).default([]),
        emails: z.array(z.string().email()).max(20).default([]),
      },
      handler: async (args: { title?: string; phones: string[]; emails: string[] }) => {
        if (!args.title && args.phones.length === 0 && args.emails.length === 0) {
          throw new DomainError(
            'INVALID_REQUEST',
            'Provide at least a title, a phone or an email to check for duplicates',
          );
        }
        const matches = await ctx.duplicates.findDuplicates({
          ...(args.title !== undefined ? { title: args.title } : {}),
          phones: args.phones,
          emails: args.emails,
        });
        return {
          duplicates_found: matches.length,
          safe_to_create: matches.length === 0,
          matches,
        };
      },
    },

    {
      name: 'crm_prepare_outreach',
      description:
        'Квалификация клиента, расчёт lead score и подготовка плана первого или повторного касания вместе с черновиком письма. Ничего не отправляет — только черновик.',
      schema: {
        company_id: positiveId,
        channel: z.enum(['call', 'email', 'messenger']).optional(),
        sender_name: z.string().min(2).max(80).optional(),
      },
      handler: async (args: {
        company_id: number;
        channel?: 'call' | 'email' | 'messenger';
        sender_name?: string;
      }) => {
        const company = await ctx.companies.getById(args.company_id);
        const [contacts, deals, activities] = await Promise.all([
          ctx.contacts.findByCompany(company.id, 10),
          ctx.deals.findByCompany(company.id, false, 25),
          ctx.activities.recentFor('company', company.id, 20),
        ]);

        return prepareOutreach({
          company,
          contacts,
          deals,
          activities,
          now: ctx.now(),
          ...(args.channel !== undefined ? { preferredChannel: args.channel } : {}),
          ...(args.sender_name !== undefined ? { senderName: args.sender_name } : {}),
        });
      },
    },
  ];
}

export { NotFoundError };

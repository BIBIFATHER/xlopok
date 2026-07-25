import type { Company } from '../domain/company.js';
import type { Contact } from '../domain/contact.js';
import type { Deal } from '../domain/deal.js';
import type { Activity } from '../domain/activity.js';
import { daysBetween } from '../domain/deal.js';

/**
 * Qualification, lead scoring and outreach drafting.
 *
 * Everything here is deterministic and local: the gateway prepares a DRAFT and
 * returns it to the agent. It never sends anything to a client — delivery stays
 * a human action, by policy.
 */

export interface LeadScoreBreakdown {
  factor: string;
  points: number;
  detail: string;
}

export interface LeadScore {
  score: number;
  band: 'A' | 'B' | 'C' | 'D';
  breakdown: LeadScoreBreakdown[];
  missing_data: string[];
}

export interface QualificationInput {
  company: Company;
  contacts: Contact[];
  deals: Deal[];
  activities: Activity[];
  now: Date;
}

const BANDS: Array<[number, LeadScore['band']]> = [
  [70, 'A'],
  [45, 'B'],
  [25, 'C'],
  [0, 'D'],
];

/**
 * Scoring model, v1. Weights are intentionally simple and explainable — the
 * breakdown is returned so a human can audit any score.
 */
export function calculateLeadScore(input: QualificationInput): LeadScore {
  const { company, contacts, deals, activities, now } = input;
  const breakdown: LeadScoreBreakdown[] = [];
  const missing: string[] = [];

  const volume = numeric(company.custom.estimated_monthly_volume);
  if (volume === null) missing.push('estimated_monthly_volume');
  else
    breakdown.push({
      factor: 'estimated_monthly_volume',
      points: volume >= 500 ? 25 : volume >= 100 ? 18 : volume >= 30 ? 10 : 4,
      detail: `${volume} шт/мес`,
    });

  const locations = numeric(company.custom.number_of_locations);
  if (locations === null) missing.push('number_of_locations');
  else
    breakdown.push({
      factor: 'number_of_locations',
      points: locations >= 10 ? 15 : locations >= 3 ? 9 : 4,
      detail: `${locations} точек`,
    });

  if (company.custom.current_supplier) {
    breakdown.push({
      factor: 'current_supplier',
      points: 8,
      detail: 'Есть текущий поставщик — понятен объём и цикл закупки',
    });
  } else {
    missing.push('current_supplier');
  }

  const reachable = contacts.some((c) => c.phones.length > 0 || c.emails.length > 0);
  breakdown.push({
    factor: 'reachability',
    points: reachable ? 12 : 0,
    detail: reachable ? 'Есть телефон или email контактного лица' : 'Нет способа связи',
  });
  if (!reachable) missing.push('contact_channel');

  if (company.city) breakdown.push({ factor: 'city', points: 5, detail: company.city });
  else missing.push('city');

  const meaningful = activities.filter((a) => a.completed).length;
  breakdown.push({
    factor: 'engagement',
    points: Math.min(15, meaningful * 3),
    detail: `${meaningful} завершённых касаний`,
  });

  const won = deals.filter((d) => d.closed && !isLost(d)).length;
  if (won > 0) {
    breakdown.push({ factor: 'repeat_customer', points: 20, detail: `${won} закрытых сделок` });
  }

  const lastTouch = activities[0]?.createdAt ?? company.updatedAt;
  const idle = daysBetween(lastTouch, now);
  if (idle !== null && idle > 120) {
    breakdown.push({ factor: 'recency_penalty', points: -8, detail: `${idle} дней без контакта` });
  }

  const score = clamp(breakdown.reduce((sum, b) => sum + b.points, 0), 0, 100);
  const band = BANDS.find(([threshold]) => score >= threshold)?.[1] ?? 'D';

  return { score, band, breakdown, missing_data: missing };
}

export type OutreachKind = 'first_touch' | 'follow_up' | 'reactivation' | 'repeat_sale';

export interface OutreachPlan {
  kind: OutreachKind;
  rationale: string;
  lead_score: LeadScore;
  /** Ordered steps the agent should take; the gateway performs none of them. */
  steps: string[];
  /** Discovery questions matched to the gaps in the card. */
  questions: string[];
  draft_channel: 'call' | 'email' | 'messenger';
  draft_subject: string;
  draft_body: string;
  /** Explicit reminder that nothing was sent. */
  delivery: 'draft_only';
}

export interface OutreachInput extends QualificationInput {
  preferredChannel?: 'call' | 'email' | 'messenger';
  senderName?: string;
}

export function prepareOutreach(input: OutreachInput): OutreachPlan {
  const leadScore = calculateLeadScore(input);
  const { company, contacts, deals, activities, now } = input;

  const hadContact = activities.length > 0;
  const openDeal = deals.find((d) => !d.closed);
  const wonBefore = deals.some((d) => d.closed && !isLost(d));
  const idle = daysBetween(activities[0]?.createdAt ?? company.updatedAt, now);

  let kind: OutreachKind;
  if (wonBefore) kind = 'repeat_sale';
  else if (!hadContact) kind = 'first_touch';
  else if (idle !== null && idle > 90) kind = 'reactivation';
  else kind = 'follow_up';

  const contact = contacts[0] ?? null;
  const name = contact?.firstName ?? contact?.fullName ?? 'коллеги';
  const sender = input.senderName ?? 'Canvas Lab';

  const channel =
    input.preferredChannel ??
    (contact?.emails.length ? 'email' : contact?.phones.length ? 'call' : 'email');

  const questions = buildQuestions(leadScore.missing_data, kind);

  return {
    kind,
    rationale: buildRationale(kind, idle, openDeal, leadScore),
    lead_score: leadScore,
    steps: buildSteps(kind, channel, leadScore),
    questions,
    draft_channel: channel,
    draft_subject: buildSubject(kind, company.title),
    draft_body: buildBody({ kind, name, sender, company: company.title, questions }),
    delivery: 'draft_only',
  };
}

function buildRationale(
  kind: OutreachKind,
  idle: number | null,
  openDeal: Deal | undefined,
  score: LeadScore,
): string {
  const parts = [`Тип касания: ${kind}`, `lead score ${score.score} (${score.band})`];
  if (idle !== null) parts.push(`${idle} дн. без активности`);
  if (openDeal) parts.push(`открытая сделка #${openDeal.id} на стадии ${openDeal.stageId}`);
  if (score.missing_data.length) parts.push(`не хватает данных: ${score.missing_data.join(', ')}`);
  return parts.join('; ');
}

function buildSteps(kind: OutreachKind, channel: string, score: LeadScore): string[] {
  const steps = [
    `Проверить карточку компании и закрыть пробелы: ${score.missing_data.join(', ') || 'пробелов нет'}`,
    `Связаться по каналу «${channel}» и задать квалифицирующие вопросы`,
    'Зафиксировать резюме разговора через crm_add_call_summary',
    'Создать следующее действие через crm_create_followup с конкретной датой',
  ];
  if (kind === 'repeat_sale') {
    steps.splice(1, 0, 'Поднять историю прошлых отгрузок и предложить повторный объём');
  }
  if (score.band === 'A') steps.push('Предложить перевод сделки на следующую стадию (crm_update_deal_stage)');
  return steps;
}

function buildQuestions(missing: string[], kind: OutreachKind): string[] {
  const map: Record<string, string> = {
    estimated_monthly_volume: 'Какой ориентировочный объём холстов в месяц вы закупаете?',
    number_of_locations: 'Сколько у вас точек или магазинов?',
    current_supplier: 'С каким поставщиком работаете сейчас и что в нём устраивает?',
    contact_channel: 'По какому номеру или почте удобнее обсуждать заказы?',
    city: 'В каком городе основной склад или точка приёмки?',
  };
  const questions = missing.map((m) => map[m]).filter((q): q is string => Boolean(q));
  if (kind === 'repeat_sale') questions.push('Когда планируете следующую закупку?');
  else questions.push('Какие размеры холстов вам нужны чаще всего?');
  return questions;
}

function buildSubject(kind: OutreachKind, company: string): string {
  switch (kind) {
    case 'repeat_sale':
      return `Повторная поставка холстов для ${company}`;
    case 'reactivation':
      return `Возобновляем работу по холстам — ${company}`;
    case 'follow_up':
      return `По итогам разговора: холсты для ${company}`;
    default:
      return `Оптовые холсты для ${company}`;
  }
}

function buildBody(p: {
  kind: OutreachKind;
  name: string;
  sender: string;
  company: string;
  questions: string[];
}): string {
  const opener: Record<OutreachKind, string> = {
    first_touch: `Здравствуйте, ${p.name}! Меня зовут ${p.sender}, мы поставляем холсты оптом.`,
    follow_up: `Здравствуйте, ${p.name}! Возвращаюсь к нашему разговору по холстам.`,
    reactivation: `Здравствуйте, ${p.name}! Мы давно не общались — хочу уточнить, актуальна ли тема холстов.`,
    repeat_sale: `Здравствуйте, ${p.name}! Спасибо за прошлые заказы — предлагаю обсудить следующую партию.`,
  };

  return [
    opener[p.kind],
    '',
    'Чтобы предложить точную цену и сроки, уточните, пожалуйста:',
    ...p.questions.map((q) => `— ${q}`),
    '',
    'Готов подготовить расчёт и прислать образцы.',
    '',
    'ЧЕРНОВИК. Отправка выполняется человеком вручную.',
  ].join('\n');
}

function isLost(deal: Deal): boolean {
  return /^(LOSE|APOLOGY)/i.test((deal.stageId ?? '').split(':').pop() ?? '');
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

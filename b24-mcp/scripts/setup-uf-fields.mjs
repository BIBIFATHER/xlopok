#!/usr/bin/env node
/**
 * Создание пользовательских полей Canvas Lab в Битрикс24 и заполнение
 * FIELD_MAP_COMPANY / FIELD_MAP_DEAL в b24-mcp/.env.
 *
 * Идемпотентно: повторный запуск не дублирует поля (существующие пропускаются).
 * Коды полей детерминированы: UF_CRM_<FIELD_NAME>. После создания скрипт читает
 * crm.company.fields / crm.deal.fields и вписывает в .env только реально
 * существующие коды.
 *
 * Запуск:
 *   node --env-file=.env scripts/setup-uf-fields.mjs        # план (dry)
 *   node --env-file=.env scripts/setup-uf-fields.mjs --go    # создать + записать .env
 *
 * Секреты не печатаются.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const ENV_PATH = resolve(ROOT, '.env');
const GO = process.argv.includes('--go');

const webhook = process.env.BITRIX24_WEBHOOK_URL;
if (!webhook || !/\/rest\/\d+\/[A-Za-z0-9]+\/?$/.test(webhook)) {
  console.error('BITRIX24_WEBHOOK_URL не задан/неверен. Запусти с --env-file=.env');
  process.exit(1);
}
const base = webhook.replace(/\/+$/, '') + '/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, params) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(base + method + '.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params || {}),
      });
      return await r.json();
    } catch {
      if (i === 4) return { error: 'NETWORK' };
      await sleep(700 * (i + 1));
    }
  }
}

/** [домен, FIELD_NAME, тип, подпись, {multiple?, list?}] */
const COMPANY = [
  ['segment', 'CL_SEGMENT', 'enumeration', 'Сегмент', { list: ['Багетная мастерская', 'Художественный салон', 'Сеть', 'Опт', 'Маркетплейс'] }],
  ['city', 'CL_CITY', 'string', 'Город'],
  ['website', 'CL_WEBSITE', 'url', 'Сайт'],
  ['number_of_locations', 'CL_LOCATIONS', 'integer', 'Количество точек'],
  ['sales_channels', 'CL_SALES_CHANNELS', 'enumeration', 'Каналы продаж', { multiple: true, list: ['Розница', 'Опт', 'Онлайн', 'Маркетплейс'] }],
  ['current_supplier', 'CL_CURRENT_SUPPLIER', 'string', 'Текущий поставщик'],
  ['estimated_monthly_volume', 'CL_MONTHLY_VOLUME', 'integer', 'Оценка объёма, шт/мес'],
  ['canvas_assortment', 'CL_ASSORTMENT', 'enumeration', 'Ассортимент холстов', { multiple: true, list: ['Хлопок', 'Лён', 'Синтетика', 'Грунтованный', 'Негрунтованный'] }],
  ['price_segment', 'CL_PRICE_SEGMENT', 'enumeration', 'Ценовой сегмент', { list: ['Эконом', 'Средний', 'Премиум'] }],
  ['lead_score', 'CL_LEAD_SCORE', 'integer', 'Lead score'],
  ['data_quality', 'CL_DATA_QUALITY', 'enumeration', 'Качество данных', { list: ['high', 'medium', 'low'] }],
  ['verification_status', 'CL_VERIFICATION', 'enumeration', 'Статус верификации', { list: ['Не проверен', 'Проверен', 'Отклонён'] }],
  ['last_meaningful_contact_at', 'CL_LAST_CONTACT', 'date', 'Последний значимый контакт'],
  ['next_expected_purchase_at', 'CL_NEXT_PURCHASE', 'date', 'Ожидаемая следующая закупка'],
];

const DEAL = [
  ['need', 'CL_NEED', 'string', 'Потребность'],
  ['interested_sizes', 'CL_SIZES', 'enumeration', 'Интересующие размеры', { multiple: true, list: ['20x30', '30x40', '40x50', '50x60', '60x80', 'другой'] }],
  ['estimated_quantity', 'CL_QUANTITY', 'integer', 'Оценка количества'],
  ['estimated_revenue', 'CL_REVENUE', 'money', 'Оценка выручки'],
  ['price_sent_at', 'CL_PRICE_SENT', 'date', 'Прайс отправлен'],
  ['samples_sent_at', 'CL_SAMPLES_SENT', 'date', 'Образцы отправлены'],
  ['next_step', 'CL_NEXT_STEP', 'string', 'Следующий шаг'],
  ['next_step_at', 'CL_NEXT_STEP_AT', 'date', 'Срок следующего шага'],
  ['loss_reason', 'CL_LOSS_REASON', 'enumeration', 'Причина проигрыша', { list: ['Цена', 'Сроки', 'Нет ответа', 'Выбрал конкурента', 'Нет потребности'] }],
  ['ai_summary', 'CL_AI_SUMMARY', 'string', 'Резюме AI'],
  ['ai_confidence', 'CL_AI_CONFIDENCE', 'double', 'Уверенность AI'],
];

function buildFields([, name, type, label, opts = {}]) {
  const fields = {
    FIELD_NAME: name,
    USER_TYPE_ID: type,
    LABEL: label,
    EDIT_FORM_LABEL: label,
    LIST_COLUMN_LABEL: label,
    MULTIPLE: opts.multiple ? 'Y' : 'N',
    MANDATORY: 'N',
    SHOW_FILTER: 'Y',
    XML_ID: name,
  };
  if (type === 'enumeration' && opts.list) {
    fields.LIST = opts.list.map((v, i) => ({ VALUE: v, SORT: (i + 1) * 100, XML_ID: `${name}_${i + 1}` }));
  }
  return fields;
}

async function createAll(defs, method, entityFields) {
  const existing = await call(entityFields, {});
  const known = new Set(Object.keys(existing.result || {}));
  let created = 0, skipped = 0, failed = 0;
  for (const def of defs) {
    const code = 'UF_CRM_' + def[1];
    if (known.has(code)) { skipped++; continue; }
    if (!GO) { created++; continue; } // в dry просто считаем «будет создано»
    const res = await call(method, { fields: buildFields(def) });
    await sleep(600);
    if (res.error) {
      // Дубль по XML_ID/имени — считаем ок.
      if (/exist|уже/i.test(res.error_description || res.error || '')) skipped++;
      else { failed++; console.error(`  ошибка ${def[1]}: ${res.error_description || res.error}`); }
    } else created++;
  }
  return { created, skipped, failed };
}

async function buildMap(defs, entityFields) {
  const fields = await call(entityFields, {});
  const present = new Set(Object.keys(fields.result || {}));
  const map = {};
  for (const [domain, name] of defs.map((d) => [d[0], d[1]])) {
    const code = 'UF_CRM_' + name;
    if (present.has(code)) map[domain] = code;
  }
  return map;
}

function writeEnvMap(companyMap, dealMap) {
  let env = readFileSync(ENV_PATH, 'utf8');
  const set = (key, val) => {
    const line = `${key}=${JSON.stringify(val)}`;
    env = new RegExp(`^${key}=.*$`, 'm').test(env)
      ? env.replace(new RegExp(`^${key}=.*$`, 'm'), line)
      : env + (env.endsWith('\n') ? '' : '\n') + line + '\n';
  };
  set('FIELD_MAP_COMPANY', companyMap);
  set('FIELD_MAP_DEAL', dealMap);
  writeFileSync(ENV_PATH, env);
}

async function main() {
  console.error(`Режим: ${GO ? 'СОЗДАНИЕ' : 'план (dry, без --go)'}`);
  console.error(`Поля компании: ${COMPANY.length}, поля сделки: ${DEAL.length}`);

  const co = await createAll(COMPANY, 'crm.company.userfield.add', 'crm.company.fields');
  console.error(`Компания: создано ${co.created}, пропущено ${co.skipped}, ошибок ${co.failed}`);
  const dl = await createAll(DEAL, 'crm.deal.userfield.add', 'crm.deal.fields');
  console.error(`Сделка: создано ${dl.created}, пропущено ${dl.skipped}, ошибок ${dl.failed}`);

  if (!GO) {
    console.error('\nЭто план. Для создания полей и записи .env добавь --go');
    return;
  }

  const companyMap = await buildMap(COMPANY, 'crm.company.fields');
  const dealMap = await buildMap(DEAL, 'crm.deal.fields');
  writeEnvMap(companyMap, dealMap);
  console.error(`\nFIELD_MAP записан в .env:`);
  console.error(`  компания: ${Object.keys(companyMap).length}/${COMPANY.length} полей`);
  console.error(`  сделка:   ${Object.keys(dealMap).length}/${DEAL.length} полей`);
  console.error('Перезапусти шлюз, чтобы поля подхватились.');
}

main().catch((e) => { console.error('fatal:', e.message); process.exit(1); });

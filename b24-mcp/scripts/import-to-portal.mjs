#!/usr/bin/env node
/**
 * Разовый импортер компаний из companies.csv в Битрикс24 через входящий вебхук.
 *
 * НЕ через шлюз (шлюз остаётся read-only). Прямые вызовы crm.item.add с:
 *   - дедупликацией по телефону/email (crm.duplicate.findbycomm);
 *   - лимитом скорости (портал: 2 rps);
 *   - докачкой: прогресс в data/import/portal-progress.json, повторный запуск
 *     пропускает уже загруженные строки;
 *   - логом каждой строки в data/import/portal-import.log.jsonl;
 *   - защитой: без флага --go ничего не пишет, только показывает план.
 *
 * Запуск:
 *   node --env-file=.env scripts/import-to-portal.mjs            # план (dry)
 *   node --env-file=.env scripts/import-to-portal.mjs --limit 20 --go
 *   node --env-file=.env scripts/import-to-portal.mjs --all --go
 *
 * Секреты не печатаются.
 */
import { readFile, appendFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const CSV = resolve(ROOT, 'data/import/bitrix-csv/companies.csv');
const PROGRESS = resolve(ROOT, 'data/import/portal-progress.json');
const LOG = resolve(ROOT, 'data/import/portal-import.log.jsonl');

const args = process.argv.slice(2);
const GO = args.includes('--go');
const ALL = args.includes('--all');
const limIdx = args.indexOf('--limit');
const LIMIT = ALL ? Infinity : limIdx >= 0 ? Number(args[limIdx + 1]) : 20;

const webhook = process.env.BITRIX24_WEBHOOK_URL;
if (!webhook || !/\/rest\/\d+\/[A-Za-z0-9]+\/?$/.test(webhook)) {
  console.error('BITRIX24_WEBHOOK_URL не задан или неверной формы. Запусти с --env-file=.env');
  process.exit(1);
}
const base = webhook.replace(/\/+$/, '') + '/';

const RPS = Number(process.env.RATE_LIMIT_RPS || 2);
const gap = Math.ceil(1000 / RPS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, params) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(base + method + '.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const j = await r.json();
      if (j.error) {
        // Ретраим только временные ошибки портала.
        if (/QUERY_LIMIT|OVERLOAD|INTERNAL/i.test(j.error) && attempt < 4) {
          await sleep(gap * attempt * 2);
          continue;
        }
        return { error: j.error };
      }
      return { result: j.result };
    } catch (e) {
      if (attempt === 4) return { error: 'NETWORK' };
      await sleep(gap * attempt * 2);
    }
  }
  return { error: 'UNKNOWN' };
}

/** Простой парсер CSV с кавычками (по одной записи на строку, без переносов в ячейках). */
function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.length > 0);
  const rows = lines.map((line) => {
    const cells = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { cells.push(cur); cur = ''; }
        else cur += c;
      }
    }
    cells.push(cur);
    return cells;
  });
  const header = rows.shift();
  return rows.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
}

function loadProgress() {
  if (!existsSync(PROGRESS)) return { done: {} };
  try { return JSON.parse(readFileSync(PROGRESS, 'utf8')); } catch { return { done: {} }; }
}
async function saveProgress(p) {
  await mkdir(dirname(PROGRESS), { recursive: true });
  await writeFile(PROGRESS, JSON.stringify(p), 'utf8');
}
async function log(entry) {
  await mkdir(dirname(LOG), { recursive: true });
  await appendFile(LOG, JSON.stringify(entry) + '\n', 'utf8');
}

function phoneKey(v) {
  const d = (v || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

async function findDuplicate(phone, email) {
  if (phone) {
    const r = await call('crm.duplicate.findbycomm', { type: 'PHONE', values: [phone], entity_type: 'COMPANY' });
    await sleep(gap);
    if (r.result && Array.isArray(r.result.COMPANY) && r.result.COMPANY.length) return r.result.COMPANY[0];
  }
  if (email) {
    const r = await call('crm.duplicate.findbycomm', { type: 'EMAIL', values: [email], entity_type: 'COMPANY' });
    await sleep(gap);
    if (r.result && Array.isArray(r.result.COMPANY) && r.result.COMPANY.length) return r.result.COMPANY[0];
  }
  return null;
}

async function main() {
  const rows = parseCsv(await readFile(CSV, 'utf8'));
  const progress = loadProgress();

  const pending = rows.filter((r) => {
    const key = phoneKey(r['Телефон']) || (r['E-mail'] || '').toLowerCase() || r['Название'];
    return key && !progress.done[key];
  });
  const slice = pending.slice(0, LIMIT);

  console.error(`CSV строк: ${rows.length}, осталось: ${pending.length}, в этот заход: ${slice.length}`);
  console.error(`Режим: ${GO ? 'ЗАПИСЬ' : 'план (dry-run, без --go)'}, лимит: ${ALL ? 'все' : LIMIT}, скорость: ${RPS} rps`);
  if (!GO) {
    console.error('Это только план. Для записи добавь --go');
    console.error('Оценка времени записи всех: ~' + Math.ceil((pending.length * 2 * gap) / 60000) + ' мин');
    return;
  }

  let created = 0, skipped = 0, failed = 0;
  for (const r of slice) {
    const title = (r['Название'] || '').trim();
    const phone = phoneKey(r['Телефон']);
    const email = (r['E-mail'] || '').trim().toLowerCase();
    const key = phone || email || title;
    if (!title) { skipped++; progress.done[key] = 'no_title'; continue; }

    const dupId = await findDuplicate(phone ? '+7' + phone : '', email);
    if (dupId) {
      skipped++;
      progress.done[key] = 'dup:' + dupId;
      await log({ ts: new Date().toISOString(), title_len: title.length, action: 'skip_dup', id: dupId });
      await saveProgress(progress);
      continue;
    }

    const fields = { title };
    if (r['Телефон']) fields.phone = [{ VALUE: r['Телефон'], VALUE_TYPE: 'WORK' }];
    if (email) fields.email = [{ VALUE: email, VALUE_TYPE: 'WORK' }];
    if (r['Источник']) fields.comments = 'Импорт: ' + r['Источник'];

    const res = await call('crm.item.add', { entityTypeId: 4, fields });
    await sleep(gap);
    if (res.error) {
      failed++;
      await log({ ts: new Date().toISOString(), action: 'error', error: res.error });
    } else {
      created++;
      const id = res.result?.item?.id ?? null;
      progress.done[key] = 'created:' + id;
      await log({ ts: new Date().toISOString(), action: 'created', id });
    }
    await saveProgress(progress);
    if ((created + skipped + failed) % 25 === 0) {
      console.error(`… создано ${created}, пропущено(дубли) ${skipped}, ошибок ${failed}`);
    }
  }

  console.error(`ГОТОВО: создано ${created}, пропущено ${skipped}, ошибок ${failed}`);
  console.error(`Лог: ${LOG}`);
  console.error(`Прогресс сохранён — повторный запуск продолжит с места остановки.`);
}

main().catch((e) => { console.error('fatal:', e.message); process.exit(1); });

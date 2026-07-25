// Боевой smoke-тест write-пути ЧЕРЕЗ ШЛЮЗ (не напрямую REST).
// Создаёт ОДНУ тестовую компанию с dry_run:false: проходит дедуп, идемпотентность,
// audit log и реальный crm.item.add. Помечена «ТЕСТ write-smoke» — легко удалить.
//
// Запуск: node --env-file=.env scripts/write-smoke.mjs
import { loadEnv } from '../dist/config/env.js';
import { HttpBitrixClient } from '../dist/bitrix/client.js';
import { buildToolContext } from '../dist/mcp/tools/context.js';
import { buildWriteTools } from '../dist/mcp/tools/write-tools.js';

const env = loadEnv();
if (!env.WRITE_ENABLED) {
  console.error('WRITE_ENABLED=false — сначала включи write-режим.');
  process.exit(1);
}

const client = new HttpBitrixClient({ env });
const ctx = buildToolContext({ client, env, identity: { agentId: 'claude_sales_agent', via: 'bearer' } });
const create = new Map(buildWriteTools(ctx).map((t) => [t.name, t])).get('crm_create_company');

const parse = (schema, args) => {
  const out = {};
  for (const [k, s] of Object.entries(schema)) {
    const p = s.safeParse(args[k]);
    if (p.success && p.data !== undefined) out[k] = p.data;
    else if (args[k] !== undefined) throw new Error(`arg ${k}: ${p.error.issues[0]?.message}`);
  }
  return out;
};

const args = {
  title: 'ТЕСТ write-smoke Canvas Lab',
  phones: ['+7 999 555-44-33'],
  emails: ['write-smoke@example.test'],
  city: 'Москва',
  idempotency_key: 'write-smoke-' + new Date().toISOString().slice(0, 10),
  dry_run: false,
};

try {
  const res = await create.handler(parse(create.schema, args));
  console.log('applied:', res.applied);
  console.log('операция:', res.diff.operation, '| полей:', res.diff.changes.length);
  console.log('REST-методы:', client.drainCallLog().join(', '));
  const id = res.result?.item?.id ?? null;
  console.log('создана компания id:', id);
  console.log('\nПроверь: CRM → Компании → «ТЕСТ write-smoke Canvas Lab».');
  console.log('Audit: b24-mcp/audit/audit.jsonl (последняя запись — эта операция).');
} catch (e) {
  console.log('отклонено:', e.code || e.message);
  if (e.code === 'DUPLICATE_FOUND') {
    console.log('→ дедуп сработал: компания с таким телефоном/email уже есть (повторный запуск).');
  }
}

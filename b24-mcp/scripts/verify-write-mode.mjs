// Проверка write-режима БЕЗ записи в CRM.
// Регистрация write-инструментов + dry-run создания компании (отдаёт diff,
// crm.item.add не вызывается) + проверка предохранителей.
import { loadEnv } from '../dist/config/env.js';
import { HttpBitrixClient } from '../dist/bitrix/client.js';
import { buildToolContext } from '../dist/mcp/tools/context.js';
import { buildReadTools } from '../dist/mcp/tools/read-tools.js';
import { buildWriteTools } from '../dist/mcp/tools/write-tools.js';
import { buildSalesTools } from '../dist/mcp/tools/sales-tools.js';

const env = loadEnv();
const client = new HttpBitrixClient({ env });
const ctx = buildToolContext({ client, env, identity: { agentId: 'claude_sales_agent', via: 'bearer' } });

const write = buildWriteTools(ctx);
const all = [...buildReadTools(ctx), ...buildSalesTools(ctx), ...write];
console.log('WRITE_ENABLED:', env.WRITE_ENABLED);
console.log('write-инструментов зарегистрировано:', write.map((t) => t.name).join(', '));
console.log('всего инструментов:', all.length);

const tool = new Map(write.map((t) => [t.name, t]));

// 1. dry-run создания компании: diff без записи.
const parse = (schema, args) => {
  const out = {};
  for (const [k, s] of Object.entries(schema)) {
    const p = s.safeParse(args[k]);
    if (p.success && p.data !== undefined) out[k] = p.data;
    else if (args[k] !== undefined) throw new Error(`arg ${k}: ${p.error.issues[0]?.message}`);
  }
  return out;
};

const create = tool.get('crm_create_company');
const res = await create.handler(
  parse(create.schema, {
    title: 'Проверка write-режима (dry-run)',
    phones: ['+7 999 000-77-88'],
    idempotency_key: 'verify-write-mode-0001',
    dry_run: true,
  }),
);
console.log('\n[1] crm_create_company dry-run:');
console.log('  applied:', res.applied, '(должно быть false)');
console.log('  diff.operation:', res.diff.operation);
console.log('  полей в diff:', res.diff.changes.length);
console.log('  crm.item.add вызван?', client.drainCallLog().includes('crm.item.add') ? 'ДА (ошибка!)' : 'нет ✓');

// 2. предохранитель: проигрыш без approver.
const stage = tool.get('crm_update_deal_stage');
try {
  await stage.handler(
    parse(stage.schema, {
      deal_id: 1,
      target_stage_id: 'C0:LOSE',
      reason: 'проверка предохранителя',
      idempotency_key: 'verify-lose-0001',
      dry_run: true,
    }),
  );
  console.log('\n[2] проигрыш без approver: ПРОШЁЛ (ошибка!)');
} catch (e) {
  console.log('\n[2] проигрыш без approver:', e.code === 'CONFIRMATION_REQUIRED' ? 'отклонён ✓' : e.code);
}

// 3. предохранитель: удаление недоступно.
console.log('[3] delete-инструмент есть?', tool.has('crm_delete_company') || tool.has('crm_delete') ? 'ДА (ошибка!)' : 'нет ✓');

// 4. предохранитель: idempotency обязателен.
try {
  await create.handler(parse(create.schema, { title: 'Без ключа', dry_run: true }));
  console.log('[4] без idempotency_key: ПРОШЁЛ (ошибка!)');
} catch (e) {
  console.log('[4] без idempotency_key: отклонён ✓', '(' + (e.message || e.code).slice(0, 40) + ')');
}

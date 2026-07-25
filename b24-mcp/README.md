# Canvas Lab — безопасный MCP-шлюз к Битрикс24

Шлюз, через который AI-агенты работают с CRM Canvas Lab (оптовые продажи холстов),
не получая прямого доступа к REST API Битрикс24.

**Текущее состояние: только чтение.** `WRITE_ENABLED=false` — write-инструменты
не регистрируются вообще, их имён нет в `tools/list`. Боевой вебхук не подключён,
импорт базы выполнен только в режиме dry-run.

## Что это даёт

- Агенты вызывают ~19 доменных инструментов вместо произвольных REST-методов.
- Allowlist методов Битрикс24; универсального `bitrix_call` не существует.
- Ни один метод удаления не входит в allowlist — удалить данные через шлюз нельзя.
- Секреты (вебхук, токены) не попадают в логи, ошибки и ответы инструментов.
- Телефоны и email маскируются в логах и audit log.
- Два равноправных агента — `claude_sales_agent` и `codex_sales_agent` — с
  одинаковым набором инструментов и общим механизмом распределения работы.

## Установка

```bash
cd b24-mcp
npm install
cp .env.example .env      # заполнить вручную
```

Требуется Node.js ≥ 20.

Минимум для локального запуска в read-only:

```dotenv
BITRIX24_WEBHOOK_URL=https://<portal>.bitrix24.ru/rest/<user>/<secret>/
MCP_AUTH_TOKEN=<openssl rand -hex 32>
WRITE_ENABLED=false
AGENT_ID=claude_sales_agent
```

## Команды

```bash
npm run dev            # stdio-сервер из исходников (tsx)
npm run build          # сборка в dist/
npm start              # запуск собранного сервера
npm run typecheck
npm run lint
npm test
npm run secret-scan    # проверка на утечку вебхука/токенов в репозитории
npm run import:dry-run # подготовка Excel-артефактов (в CRM ничего не пишет)
npm run validate:live  # read-only проверка на тестовом портале (WRITE_ENABLED=false)
```

## Проверка на тестовом портале

`npm run validate:live` прогоняет все read-only инструменты на реальном
тестовом портале, ничего не создавая и не меняя. Отдельно проверяет оба
диалекта `tasks.task.list` (legacy и REST v3) и подсказывает подтверждённое
значение `TASKS_API_MODE`. Отчёт и обезличенные fixtures пишутся в
`data/validation/` и `tests/fixtures/live/`. Секреты и персональные данные в
артефакты не попадают. Подробно — [docs/LIVE_READONLY_VALIDATION.md](docs/LIVE_READONLY_VALIDATION.md).

HTTP-режим:

```bash
TRANSPORT=http PORT=8787 npm run dev
curl -s http://127.0.0.1:8787/health | jq       # без авторизации, без секретов
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $CLAUDE_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Подключение к Claude Code

```bash
claude mcp add canvaslab-crm \
  --env AGENT_ID=claude_sales_agent \
  --env WRITE_ENABLED=false \
  -- node /Users/anton/Documents/Хлопок/b24-mcp/dist/mcp/server.js
```

Или через HTTP (шлюз запущен отдельно):

```bash
claude mcp add --transport http canvaslab-crm http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer $CLAUDE_MCP_TOKEN"
```

## Подключение к Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.canvaslab_crm]
command = "node"
args = ["/Users/anton/Documents/Хлопок/b24-mcp/dist/mcp/server.js"]
env = { AGENT_ID = "codex_sales_agent", WRITE_ENABLED = "false" }
```

Через HTTP — тот же адрес, но с `CODEX_MCP_TOKEN`. Токены у агентов обязаны
различаться: иначе audit log и A/B-сравнение не отличат, кто что сделал.

## Инструменты

### Чтение (доступны всегда)

| Инструмент | Назначение |
|---|---|
| `crm_search_companies` | Поиск компаний по названию, телефону, email, городу |
| `crm_get_company` | Карточка: контакты, открытые сделки, касания, следующее действие |
| `crm_search_contacts` | Поиск контактов; телефон нормализуется до E.164 |
| `crm_get_contact` | Контакт, компания, сделки, история касаний |
| `crm_search_deals` | Сделки по стадии, ответственному, компании, датам |
| `crm_get_deal` | Сделка, компания, контакты, активности, следующий шаг, причина проигрыша |
| `crm_get_overdue_followups` | Просроченные дела и задачи, фильтр по менеджеру |
| `crm_get_deals_without_next_action` | Открытые сделки без запланированного шага |
| `crm_get_stale_deals` | Сделки, застрявшие на стадии дольше N дней |
| `crm_get_sales_summary` | Сводка: воронка, просрочки, «немые» сделки |
| `crm_find_duplicates` | Проверка дублей до создания записи |
| `crm_prepare_outreach` | Квалификация, lead score, план касания, черновик письма |

### Распределение работы (доступны всегда — состояние локальное, CRM не меняется)

`sales_get_available_work`, `sales_claim_account`, `sales_release_account`,
`sales_complete_assignment`, `sales_transfer_account`, `sales_get_my_assignments`,
`sales_get_agent_metrics`.

### Запись (только при `WRITE_ENABLED=true`)

`crm_create_company`, `crm_create_contact`, `crm_create_deal`, `crm_add_note`,
`crm_add_call_summary`, `crm_create_followup`, `crm_update_next_step`,
`crm_update_deal_stage`.

Для каждой записи: обязательный `idempotency_key`, `dry_run=true` по умолчанию,
проверка дублей перед созданием, diff планируемых изменений, запись в audit log,
проверка, что объект не закреплён за другим агентом.

## Примеры вызовов

```jsonc
// Поиск по телефону — уходит в индекс дублей Битрикс24
{"name": "crm_search_companies", "arguments": {"query": "8 916 111-22-33"}}

// Гигиена воронки
{"name": "crm_get_stale_deals", "arguments": {"threshold_days": 21, "limit": 20}}

// Подготовка касания (ничего не отправляет)
{"name": "crm_prepare_outreach", "arguments": {"company_id": 1, "channel": "email"}}

// Взять клиента в работу
{"name": "sales_claim_account",
 "arguments": {"entity_type": "company", "entity_id": 1,
               "reason": "первичная квалификация", "idempotency_key": "claim-1-2026-07-24"}}

// Запись (только при WRITE_ENABLED=true) — сначала план, без изменений
{"name": "crm_create_followup",
 "arguments": {"entity_type": "deal", "entity_id": 100,
               "title": "Позвонить по образцам", "deadline": "2026-07-30T09:00:00.000Z",
               "responsible_id": 5, "idempotency_key": "fu-100-1", "dry_run": true}}
```

## Что запрещено навсегда

Независимо от `WRITE_ENABLED` и роли:

- удаление любых записей CRM;
- вызов произвольного REST-метода;
- отправка сообщений, писем и SMS клиентам;
- выставление счетов и изменение цен;
- закрытие сделки как проигранной без подтверждения вторым участником;
- массовые операции сверх лимита без подтверждения admin.

## Документация

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — слои, потоки данных, риски
- [docs/ROLES.md](docs/ROLES.md) — роли, токены, разрешения
- [docs/BITRIX24_CHECKLIST.md](docs/BITRIX24_CHECKLIST.md) — что создать руками в портале
- [docs/AB_TESTING.md](docs/AB_TESTING.md) — протокол сравнения Claude и Codex
- [docs/IMPORT.md](docs/IMPORT.md) — порядок dry-run импорта базы
- [docs/PORTALS.md](docs/PORTALS.md) — подключение тестового и боевого портала
- [docs/LIVE_READONLY_VALIDATION.md](docs/LIVE_READONLY_VALIDATION.md) — read-only проверка на тестовом портале, диалекты задач

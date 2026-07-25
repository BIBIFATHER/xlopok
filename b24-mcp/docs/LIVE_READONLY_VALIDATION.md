# Live read-only проверка на тестовом портале

Прогон всех read-only инструментов и обоих диалектов `tasks.task.list` на
реальном **тестовом** портале Битрикс24. Ничего не создаёт, не меняет и не
удаляет.

## Результат прогона на b24-55epq5 (25.07.2026)

Портал: `b24-55epq5.bitrix24.ru` (тестовый, пустой — сущностей ещё нет).
Вебхук: scope `crm`, `task`, `tasks`, `user` (+прочие), пользователь id 1, admin.

| Показатель | Значение |
|---|---|
| Итог | **29 ok, 0 failed, 4 skipped** |
| Скипы | `crm_get_company/contact/deal`, `crm_prepare_outreach` — на портале нет сущностей для запроса по id |
| CRM | доступен: `crm.item.fields` → 42 поля компании, 0 кастомных (UF Canvas Lab ещё не созданы) |
| Все 12 read-инструментов | отвечают, пустой результат обрабатывается корректно |
| Неизвестное поле в `select` | принимается, игнорируется |
| Неизвестное поле в `filter` | отклоняется — `INVALID_ARG_VALUE` (портал не молчит) |
| **Диалект задач** | **`confirmed_mode = legacy`** |

### Задачи: что выяснилось про два диалекта

**legacy (классический webhook)** — работает полностью: объектный фильтр с
префиксами, `start`, конверт `tasks`. Это рабочий режим для Canvas Lab.

**REST v3 (`/rest/api/…`)** — endpoint на портале **есть и отвечает**, но для
нашей нагрузки непригоден:

- поля DTO другие: CRM-привязка — `crmItemIds` (не `ufCrmTask`), дата — `created`
  (не `createdDate`); `tasks.task.field.list` существует **только** по v3
  (по webhook — `ERROR_METHOD_NOT_FOUND`);
- в фильтре v3 **фильтруется только `id`** (`tasks.task.field.list` → filterable
  лишь `id`); фильтр по `status` → `BITRIX_REST_V3_EXCEPTION_VALIDATION`
  («требуется атрибут Filterable»);
- значит запросы «открытые задачи по статусу» и «задачи по сделке» через v3 на
  этом портале не выражаются.

Адаптер `bitrix/tasks.ts` знает про оба диалекта и правильные имена полей v3, но
по умолчанию и на этом портале используется **legacy** (`TASKS_API_MODE=legacy`).
v3 остаётся подключённым для порталов, где Filterable-полей больше.

## Гарантии безопасности

Раннер (`src/validation/live-readonly.ts`):

- отказывается стартовать при `WRITE_ENABLED=true`;
- вызывает только read-инструменты; отдельная проба `guard.write_tools_absent`
  проверяет, что ни один write-инструмент не зарегистрирован;
- не выполняет ни одного `*.add` / `*.update` / `*.delete`;
- webhook URL, токены и персональные данные не попадают в отчёт, fixtures и
  stdout (маскирование + обезличивание);
- fixtures проходят двухпроходное обезличивание: имена, названия, телефоны и
  email заменяются на стабильные псевдонимы, включая вхождения внутри
  сгенерированного текста (например, черновика письма).

## Предусловия

```dotenv
BITRIX24_WEBHOOK_URL=https://<test-portal>.bitrix24.ru/rest/<user>/<secret>/
MCP_AUTH_TOKEN=<32+ hex>
WRITE_ENABLED=false
AGENT_ID=claude_sales_agent
DATA_DIR=data/test
LOG_LEVEL=info
```

Все проверки идут по заранее созданным тестовым сущностям портала. Боевой
портал не подключать. Excel-базу не импортировать.

## Запуск

```bash
npm run validate:live
```

Артефакты:

- `data/validation/live-validation-report.json` — полный отчёт;
- `tests/fixtures/live/*.json` — обезличенные ответы (shape + значения-плейсхолдеры);
- `tests/fixtures/live/index.json` — список сохранённых fixtures.

stdout печатает только сводку: счётчики, статус диалектов задач, список
упавших проб с кодами.

## Что проверяется

| Группа | Пробы |
|---|---|
| `guard` | write-инструменты не зарегистрированы |
| `rights` | `profile`, scope `crm` (`crm.item.fields`), scope `tasks` (`tasks.task.field.list`) |
| `discovery` | чтение страницы компаний, контактов, сделок |
| `pagination` | размер страницы `crm.item.list`, `next`, отсутствие пересечения страниц |
| `edge` | пустой результат; неизвестное поле в `select`; неизвестное поле в `filter` |
| `tasks` | оба диалекта: список, сырой конверт, пагинация v3, битая пагинация v3, неизвестное поле |
| `tools` | все 12 read-инструментов на реальных сущностях + пустой поиск |

## Особый случай — tasks.task.list

Проверяется **отдельно в двух вариантах**, потому что какой из них отвечает —
свойство конкретного портала, а не то, что можно выбрать вслепую.

### 1. Классический (`TASKS_API_MODE=legacy`)

Через вебхук, метод `tasks.task.list`:

```jsonc
{
  "select": ["ID", "TITLE", "DEADLINE", "RESPONSIBLE_ID", "STATUS", "UF_CRM_TASK"],
  "filter": { "@STATUS": [1,2,3,4,6], "<DEADLINE": "<ISO>", "UF_CRM_TASK": "D_100" },
  "order":  { "DEADLINE": "ASC" },
  "start":  0
}
```

- фильтр — объект с префиксами (`@` — в списке, `<` `>` `!` — сравнения);
- пагинация — `start` (страница 50, следующая `start += 50`);
- строки приходят в ключе `tasks` (или `result`).

### 2. REST v3 (`TASKS_API_MODE=v3`)

Через endpoint `…/rest/api/<user>/<token>/tasks.task.list`:

```jsonc
{
  "select": ["id", "title", "deadline", "responsibleId", "status", "ufCrmTask"],
  "filter": [ ["status", "in", [1,2,3,4,6]], ["deadline", "<", "<ISO>"], ["ufCrmTask", "in", ["D_100"]] ],
  "order":  { "deadline": "ASC" },
  "pagination": { "limit": 50, "offset": 0 }
}
```

- фильтр — массив условий `["field","op",value]` или `["field",value]`;
- пагинация — объект `pagination` (`limit` ≤ 1000, `offset`);
- строки приходят в `result.items`, поля в camelCase.

### Различия

| | legacy | v3 |
|---|---|---|
| Endpoint | `<webhook>/tasks.task.list.json` | `<portal>/rest/api/<user>/<token>/tasks.task.list` |
| Фильтр | объект с префиксами | массив условий |
| Пагинация | `start` (шаг 50) | `pagination.limit`/`offset` |
| Строки | `tasks` / `result` | `result.items` |
| Имена полей | UPPER_SNAKE | camelCase |
| Ошибки валидации | общий код | `BITRIX_REST_V3_EXCEPTION_*` |

Оба диалекта нормализуются адаптером к единому доменному `Task`; проба
`tasks…both dialects…same domain Task` подтверждает совпадение результата.

## Как фиксируются результаты

Блок `tasks_api` отчёта:

```jsonc
{
  "legacy": "ok | failed | skipped",
  "v3": "ok | failed | skipped",
  "confirmed_mode": "legacy | v3 | null",
  "notes": ["Классический контракт отвечает.", "REST v3 endpoint отвечает."]
}
```

Каждая проба содержит: `status`, `note` (без данных), `errorCode`,
`durationMs`, `shape` (ключи и типы, без значений), `count`.

Что зафиксирует прогон:

- **какие варианты реально работают** — `tasks_api.legacy` / `tasks_api.v3`;
- **формат ответа** — `shape` проб `tasks.*.raw_envelope`;
- **пагинация** — пробы `paging.crm_item_list`, `tasks.v3.pagination`;
- **ограничения фильтров** — `edge.*`, `tasks.*.unknown_field`,
  `tasks.v3.unfilterable_field`;
- **различия endpoint'ов** — сравнение legacy и v3 конвертов;
- **коды ошибок** — `errorCode` каждой упавшей пробы;
- **права служебного пользователя** — блок `rights`;
- **поведение при пустом результате** — `empty.crm_item_list`,
  `tool.crm_search_companies.empty`;
- **поведение при недоступном поле** — `unknown_field.*`, `unknown_filter.*`.

## После проверки

1. Взять `confirmed_mode` из отчёта, выставить `TASKS_API_MODE`.
2. Если оба варианта работают — не считать legacy автоматически долгосрочным:
   выбор фиксируется конфигом, адаптер позволяет переключиться без правки кода.
3. Проверить, что fixtures в `tests/fixtures/live/` обезличены
   (тест `tests/fixtures.test.ts` это гарантирует в CI).
4. Не включать write-инструменты.

## Ограничения

- Раннер обходит только заранее созданные тестовые сущности; если на портале
  нет, например, задач — соответствующие пробы вернут пустой результат, а
  `confirmed_mode` определится по тому, какой endpoint ответил без ошибки
  доступа.
- Обезличивание строится на распознавании ключей и значений; при появлении
  нестандартных полей проверить свежие fixtures глазами перед коммитом.
- Fixtures в репозитории (если сгенерированы из mock) помечены полем
  `source: "mock …"` — это референсные формы, не данные портала. Перегенерировать
  на тестовом портале командой `npm run validate:live`.

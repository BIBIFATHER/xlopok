import ExcelJS from 'exceljs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  findDuplicateGroups,
  normalizeRow,
  companyKey,
  type DuplicateGroup,
  type NormalizedRow,
  type RawRow,
} from './normalize.js';
import { logger } from '../security/logger.js';
import { isEntrypoint } from '../config/entrypoint.js';

/**
 * Dry-run preparation of the legacy base for Bitrix24.
 *
 * This script NEVER writes to the CRM and never touches the source workbook.
 * It produces review artefacts only; the actual import is a separate, manually
 * confirmed step.
 */

const DEFAULT_SOURCE = 'data/raw/ЕДИНАЯ_БАЗА_КОНТАКТОВ_CRM_2026.xlsx';
const DEFAULT_OUT = 'data/import';

export interface ImportSummary {
  source_file: string;
  generated_at: string;
  total_rows: number;
  companies: number;
  contacts: number;
  leads_for_review: number;
  duplicate_groups: number;
  duplicate_rows: number;
  invalid_rows: number;
  quality: Record<'high' | 'medium' | 'low', number>;
  issues: Record<string, number>;
  with_phone: number;
  with_email: number;
  with_valid_email: number;
  in_crm_already: number;
}

export async function readRows(sourcePath: string): Promise<RawRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(sourcePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('Source workbook has no worksheets');

  const rows: RawRow[] = [];
  sheet.eachRow((row, index) => {
    if (index === 1) return; // header
    const v = (i: number): string => cellText(row.getCell(i).value);
    rows.push({
      row_number: index,
      base_period: v(1),
      phone_e164: v(2),
      phone_formatted: v(3),
      contact_name: v(4),
      company: v(5),
      email: v(6),
      source_category: v(7),
      in_crm_2023_2024: v(8),
      in_video_file: v(9),
      video_status: v(10),
      crm_entity_types: v(11),
      activity_years: v(12),
    });
  });
  return rows;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('result' in value) return String((value as { result: unknown }).result ?? '');
    if (value instanceof Date) return value.toISOString();
    return '';
  }
  return String(value);
}

export interface PreparedImport {
  normalized: NormalizedRow[];
  companies: NormalizedRow[];
  contacts: NormalizedRow[];
  leadsForReview: NormalizedRow[];
  invalid: NormalizedRow[];
  duplicates: DuplicateGroup[];
  summary: ImportSummary;
}

export function prepare(rows: RawRow[], sourcePath: string): PreparedImport {
  const normalized = rows.map(normalizeRow);

  // A row is unusable if we have no way to reach the client at all.
  const invalid = normalized.filter((r) => !r.phone && !r.email);
  const usable = normalized.filter((r) => r.phone || r.email);

  const duplicates = findDuplicateGroups(usable);
  const duplicateRowNumbers = new Set<number>();
  for (const g of duplicates) for (const r of g.rows.slice(1)) duplicateRowNumbers.add(r.row_number);

  // One company card per distinct company key; the first row wins.
  const companySeen = new Set<string>();
  const companies: NormalizedRow[] = [];
  for (const r of usable) {
    if (!r.company_title) continue;
    const key = companyKey(r.company_title);
    if (companySeen.has(key)) continue;
    companySeen.add(key);
    companies.push(r);
  }

  const contacts = usable.filter((r) => r.contact_full_name && r.company_title);
  // Rows a human must look at before they become accounts: no company identity
  // at all, or a name that could be either a brand or a person.
  const leadsForReview = usable.filter(
    (r) => !r.company_title || r.issues.includes('company_vs_person_ambiguous'),
  );

  const issues: Record<string, number> = {};
  for (const r of normalized) for (const i of r.issues) issues[i] = (issues[i] ?? 0) + 1;

  const summary: ImportSummary = {
    source_file: basename(sourcePath),
    generated_at: new Date().toISOString(),
    total_rows: normalized.length,
    companies: companies.length,
    contacts: contacts.length,
    leads_for_review: leadsForReview.length,
    duplicate_groups: duplicates.length,
    duplicate_rows: duplicateRowNumbers.size,
    invalid_rows: invalid.length,
    quality: {
      high: normalized.filter((r) => r.data_quality === 'high').length,
      medium: normalized.filter((r) => r.data_quality === 'medium').length,
      low: normalized.filter((r) => r.data_quality === 'low').length,
    },
    issues,
    with_phone: normalized.filter((r) => r.phone).length,
    with_email: normalized.filter((r) => r.email).length,
    with_valid_email: normalized.filter((r) => r.email && !r.email_is_synthetic).length,
    in_crm_already: normalized.filter((r) => r.in_crm).length,
  };

  return { normalized, companies, contacts, leadsForReview, invalid, duplicates, summary };
}

async function writeSheet(
  path: string,
  sheetName: string,
  headers: string[],
  rows: Array<Array<string | number | null>>,
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'canvas-lab-b24-mcp (dry-run)';
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };
  for (const row of rows) ws.addRow(row);
  ws.columns.forEach((c) => {
    c.width = 26;
  });
  await wb.xlsx.writeFile(path);
}

export async function writeArtifacts(prepared: PreparedImport, outDir: string): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const written: string[] = [];

  const companiesPath = join(outDir, 'companies_import.xlsx');
  await writeSheet(
    companiesPath,
    'companies',
    ['row', 'TITLE', 'PHONE', 'EMAIL', 'LEGAL_FORM', 'SOURCE', 'IN_CRM', 'DATA_QUALITY', 'ISSUES'],
    prepared.companies.map((r) => [
      r.row_number,
      r.company_title,
      r.phone,
      r.email,
      r.legal_form,
      r.source_category,
      r.in_crm ? 'Y' : 'N',
      r.data_quality,
      r.issues.join(', '),
    ]),
  );
  written.push(companiesPath);

  const contactsPath = join(outDir, 'contacts_import.xlsx');
  await writeSheet(
    contactsPath,
    'contacts',
    ['row', 'NAME', 'LAST_NAME', 'COMPANY_TITLE', 'PHONE', 'EMAIL', 'DATA_QUALITY', 'ISSUES'],
    prepared.contacts.map((r) => [
      r.row_number,
      r.contact_first_name,
      r.contact_last_name,
      r.company_title,
      r.phone,
      r.email,
      r.data_quality,
      r.issues.join(', '),
    ]),
  );
  written.push(contactsPath);

  const leadsPath = join(outDir, 'leads_review.xlsx');
  await writeSheet(
    leadsPath,
    'leads_review',
    ['row', 'NAME_AS_IS', 'PHONE', 'EMAIL', 'SOURCE', 'IN_CRM', 'WHY_REVIEW'],
    prepared.leadsForReview.map((r) => [
      r.row_number,
      r.company_title ?? r.contact_full_name,
      r.phone,
      r.email,
      r.source_category,
      r.in_crm ? 'Y' : 'N',
      r.company_title
        ? 'Название похоже и на бренд, и на ФИО — уточнить тип карточки'
        : 'Не удалось определить компанию — требуется ручная проверка',
    ]),
  );
  written.push(leadsPath);

  const duplicatesPath = join(outDir, 'duplicates.xlsx');
  await writeSheet(
    duplicatesPath,
    'duplicates',
    ['key_type', 'key', 'row', 'COMPANY', 'CONTACT', 'PHONE', 'EMAIL'],
    prepared.duplicates.flatMap((g) =>
      g.rows.map((r) => [
        g.key_type,
        g.key,
        r.row_number,
        r.company_title,
        r.contact_full_name,
        r.phone,
        r.email,
      ]),
    ),
  );
  written.push(duplicatesPath);

  const invalidPath = join(outDir, 'invalid_rows.xlsx');
  await writeSheet(
    invalidPath,
    'invalid_rows',
    ['row', 'COMPANY_RAW', 'CONTACT_RAW', 'PHONE_RAW', 'EMAIL_RAW', 'ISSUES'],
    prepared.invalid.map((r) => [
      r.row_number,
      r.company_title,
      r.contact_full_name,
      r.phone,
      r.email,
      r.issues.join(', '),
    ]),
  );
  written.push(invalidPath);

  const reportPath = join(outDir, 'data_quality_report.md');
  await writeFile(reportPath, buildReport(prepared), 'utf8');
  written.push(reportPath);

  return written;
}

export function buildReport(prepared: PreparedImport): string {
  const s = prepared.summary;
  const pct = (n: number): string => `${((n / Math.max(1, s.total_rows)) * 100).toFixed(1)}%`;

  const issueRows = Object.entries(s.issues)
    .sort((a, b) => b[1] - a[1])
    .map(([issue, count]) => `| ${issue} | ${count} | ${pct(count)} |`)
    .join('\n');

  const dupByType = prepared.duplicates.reduce<Record<string, number>>((acc, g) => {
    acc[g.key_type] = (acc[g.key_type] ?? 0) + 1;
    return acc;
  }, {});

  return `# Отчёт качества данных — исходная база Canvas Lab

Источник: \`${s.source_file}\` (файл не изменялся)
Сформировано: ${s.generated_at}
Режим: **dry-run**, запись в Битрикс24 не выполнялась.

## Объём

| Показатель | Значение | Доля |
|---|---:|---:|
| Всего строк | ${s.total_rows} | 100% |
| С телефоном | ${s.with_phone} | ${pct(s.with_phone)} |
| С email | ${s.with_email} | ${pct(s.with_email)} |
| С «живым» email (не сгенерированным) | ${s.with_valid_email} | ${pct(s.with_valid_email)} |
| Уже отмечены как присутствующие в CRM 2023–2024 | ${s.in_crm_already} | ${pct(s.in_crm_already)} |

## Результат подготовки

| Файл | Записей | Назначение |
|---|---:|---|
| companies_import.xlsx | ${s.companies} | Уникальные компании к созданию |
| contacts_import.xlsx | ${s.contacts} | Контактные лица с привязкой к компании |
| leads_review.xlsx | ${s.leads_for_review} | Строки без определяемой компании — ручная проверка |
| duplicates.xlsx | ${s.duplicate_rows} строк в ${s.duplicate_groups} группах | Совпадения по телефону, email и названию |
| invalid_rows.xlsx | ${s.invalid_rows} | Нет ни телефона, ни email — импорт бессмысленен |

Группы дублей по типу ключа: ${Object.entries(dupByType)
    .map(([k, v]) => `${k} — ${v}`)
    .join(', ') || 'нет'}.

## Качество

| Уровень | Строк | Доля |
|---|---:|---:|
| high | ${s.quality.high} | ${pct(s.quality.high)} |
| medium | ${s.quality.medium} | ${pct(s.quality.medium)} |
| low | ${s.quality.low} | ${pct(s.quality.low)} |

## Найденные проблемы

| Проблема | Строк | Доля |
|---|---:|---:|
${issueRows || '| — | 0 | 0% |'}

### Как читать проблемы

- \`phone_missing_or_invalid\` — телефон отсутствует или не приводится к формату E.164.
- \`email_invalid\` — значение в колонке E-mail не является адресом.
- \`email_synthetic\` — адрес вида \`<номер телефона>@домен\`: технический, для рассылок непригоден.
- \`company_name_missing\` — в ячейке компании только идентификатор или мусор.
- \`contact_name_missing\` — не удалось выделить ФИО контактного лица.

## Что нужно решить до импорта

1. Подтвердить правило слияния дублей: побеждает строка с наибольшим числом заполненных полей или самая свежая по годам активности.
2. Решить, что делать со строками \`leads_review\` — заводить лидами или отбрасывать.
3. Подтвердить, что синтетические email не попадают в поле EMAIL карточки (иначе они уйдут в рассылки).
4. Создать в Битрикс24 пользовательские поля Canvas Lab и заполнить \`FIELD_MAP_COMPANY\` / \`FIELD_MAP_DEAL\`.
5. Согласовать ответственного по умолчанию для импортируемых карточек.

## Ограничения этого отчёта

- Дубли ищутся только внутри файла; совпадения с текущим содержимым портала не проверялись (нужен боевой вебхук).
- Разделение «компания / контакт» эвристическое: смешанные ячейки вида \`ООО "Х" / Фамилия\` разбираются по правилу, но исключения возможны.
- Сегмент, объём закупок и прочие поля Canvas Lab в источнике отсутствуют — заполняются агентами в процессе работы.
`;
}

export async function runDryRun(
  sourcePath = DEFAULT_SOURCE,
  outDir = DEFAULT_OUT,
): Promise<ImportSummary> {
  const source = resolve(sourcePath);
  const rows = await readRows(source);
  const prepared = prepare(rows, source);
  const written = await writeArtifacts(prepared, resolve(outDir));
  logger.info('import dry-run complete', {
    rows: prepared.summary.total_rows,
    files: written.map((f) => basename(f)),
  });
  return prepared.summary;
}

if (isEntrypoint(import.meta.url)) {
  const [, , sourceArg, outArg] = process.argv;
  runDryRun(sourceArg ?? DEFAULT_SOURCE, outArg ?? DEFAULT_OUT)
    .then((summary) => {
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    })
    .catch((err: unknown) => {
      logger.error('import dry-run failed', {
        message: err instanceof Error ? err.message : 'unknown',
      });
      process.exit(1);
    });
}

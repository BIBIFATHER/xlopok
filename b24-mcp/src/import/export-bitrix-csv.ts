import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readRows, prepare } from './run-import.js';
import { isEntrypoint } from '../config/entrypoint.js';
import { logger } from '../security/logger.js';

/**
 * Export the prepared base as CSV ready for Bitrix24's native CRM import
 * (CRM → Компании/Контакты → ⚙ → Импорт).
 *
 * Read-only: reads the source workbook, writes CSV. Nothing touches the portal.
 * The native import UI does the actual insert and its own duplicate control, so
 * the gateway stays out of the bulk-write path entirely.
 */

const DEFAULT_SOURCE = 'data/raw/ЕДИНАЯ_БАЗА_КОНТАКТОВ_CRM_2026.xlsx';
const DEFAULT_OUT = 'data/import/bitrix-csv';

/** UTF-8 BOM so Excel and Bitrix read Cyrillic correctly. */
const BOM = '﻿';

function csvCell(value: string | null): string {
  const s = (value ?? '').replace(/\r?\n/g, ' ').trim();
  // Always quote — the safest cross-tool CSV, and values may contain ; or ,.
  return `"${s.replace(/"/g, '""')}"`;
}

function csvRow(cells: Array<string | null>): string {
  return cells.map(csvCell).join(',');
}

export async function exportCsv(sourcePath = DEFAULT_SOURCE, outDir = DEFAULT_OUT): Promise<{
  companies: number;
  contacts: number;
  files: string[];
}> {
  const rows = await readRows(resolve(sourcePath));
  const prepared = prepare(rows, resolve(sourcePath));
  await mkdir(resolve(outDir), { recursive: true });

  // Companies. One phone/email per column — Bitrix maps these to WORK by default.
  const companyHeader = ['Название', 'Телефон', 'E-mail', 'Город', 'Веб-сайт', 'Источник'];
  const companyLines = [csvRow(companyHeader)];
  for (const c of prepared.companies) {
    companyLines.push(
      csvRow([c.company_title, c.phone, c.email, /* city unknown in source */ null, null, c.source_category]),
    );
  }
  const companiesPath = join(resolve(outDir), 'companies.csv');
  await writeFile(companiesPath, BOM + companyLines.join('\r\n') + '\r\n', 'utf8');

  // Contacts. Company name lets Bitrix link on import (or create the company).
  const contactHeader = ['Имя', 'Фамилия', 'Должность', 'Компания', 'Телефон', 'E-mail'];
  const contactLines = [csvRow(contactHeader)];
  for (const c of prepared.contacts) {
    contactLines.push(
      csvRow([
        c.contact_first_name,
        c.contact_last_name,
        null,
        c.company_title,
        c.phone,
        c.email,
      ]),
    );
  }
  const contactsPath = join(resolve(outDir), 'contacts.csv');
  await writeFile(contactsPath, BOM + contactLines.join('\r\n') + '\r\n', 'utf8');

  // Leads-for-review as a separate CSV so the ambiguous rows are not mixed in.
  const leadHeader = ['Название', 'Телефон', 'E-mail', 'Причина проверки'];
  const leadLines = [csvRow(leadHeader)];
  for (const l of prepared.leadsForReview) {
    leadLines.push(
      csvRow([
        l.company_title ?? l.contact_full_name,
        l.phone,
        l.email,
        l.company_title ? 'Бренд или ФИО — уточнить' : 'Компания не определена',
      ]),
    );
  }
  const leadsPath = join(resolve(outDir), 'leads_review.csv');
  await writeFile(leadsPath, BOM + leadLines.join('\r\n') + '\r\n', 'utf8');

  return {
    companies: prepared.companies.length,
    contacts: prepared.contacts.length,
    files: [companiesPath, contactsPath, leadsPath],
  };
}

if (isEntrypoint(import.meta.url)) {
  const [, , src, out] = process.argv;
  exportCsv(src ?? DEFAULT_SOURCE, out ?? DEFAULT_OUT)
    .then((r) => {
      process.stdout.write(
        JSON.stringify({ companies: r.companies, contacts: r.contacts, files: r.files }, null, 2) +
          '\n',
      );
    })
    .catch((err: unknown) => {
      logger.error('csv export failed', { message: err instanceof Error ? err.message : 'unknown' });
      process.exit(1);
    });
}

import { describe, expect, it } from 'vitest';
import {
  cleanCompany,
  cleanEmail,
  findDuplicateGroups,
  isAmbiguousName,
  looksLikePerson,
  normalizeRow,
  splitNameCell,
  type RawRow,
} from '../src/import/normalize.js';
import { prepare } from '../src/import/run-import.js';
import { normalizePhone, phoneTail } from '../src/domain/contact.js';

function row(overrides: Partial<RawRow>): RawRow {
  return {
    row_number: 2,
    base_period: 'База 2026 год',
    phone_e164: '73952533050',
    phone_formatted: '+7 395 253-30-50',
    contact_name: 'ООО "Линер" / Филатов',
    company: '"Линер” /',
    email: 'butkova@liner.irkutsk.ru',
    source_category: 'Общий (CRM + Видео)',
    in_crm_2023_2024: 'Да',
    in_video_file: 'Да',
    video_status: 'частично читается',
    crm_entity_types: 'COMPANY',
    activity_years: '2023, 2024',
    ...overrides,
  };
}

describe('phone normalisation', () => {
  it('maps Russian formats to a single E.164 form', () => {
    expect(normalizePhone('8 916 111-22-33')).toBe('+79161112233');
    expect(normalizePhone('+7 (916) 111 22 33')).toBe('+79161112233');
    expect(normalizePhone('9161112233')).toBe('+79161112233');
    expect(normalizePhone('123')).toBeNull();
  });

  it('produces a stable duplicate key', () => {
    expect(phoneTail('8 916 111-22-33')).toBe(phoneTail('+7 916 111 22 33'));
  });
});

describe('company/person classification', () => {
  it('strips separators and quotes from company cells', () => {
    expect(cleanCompany('"Линер” /')).toBe('"Линер"');
    expect(cleanCompany('. = GALACENTER')).toBe('GALACENTER');
    expect(cleanCompany('18503,')).toBeNull();
  });

  it('treats a trade name as a company by default', () => {
    expect(looksLikePerson('GALACENTER')).toBe(false);
    expect(looksLikePerson('Арт Багет')).toBe(false);
    expect(splitNameCell('Deloks.ru').company).toBe('Deloks.ru');
  });

  it('recognises a person by patronymic or initials', () => {
    expect(looksLikePerson('Иванов Пётр Сергеевич')).toBe(true);
    expect(looksLikePerson('Храновский В.А.')).toBe(true);
  });

  it('keeps a legal form attached to the company', () => {
    const parsed = splitNameCell('ООО "Линер" / Филатов');
    expect(parsed.company).toBe('ООО "Линер"');
    expect(parsed.person).toBe('Филатов');
  });

  it('flags two plain Cyrillic words as ambiguous', () => {
    expect(isAmbiguousName('Арт Багет')).toBe(true);
    expect(isAmbiguousName('GALACENTER')).toBe(false);
  });
});

describe('email cleaning', () => {
  it('detects synthetic phone-based addresses', () => {
    expect(cleanEmail('79155238324@yandex.ru').synthetic).toBe(true);
    expect(cleanEmail('buyer@artbaget.ru').synthetic).toBe(false);
  });

  it('rejects malformed addresses', () => {
    expect(cleanEmail('663-39-62@nikita').valid).toBe(false);
  });
});

describe('row normalisation', () => {
  it('produces a full normalised record', () => {
    const n = normalizeRow(row({}));
    expect(n.company_title).toBe('ООО "Линер"');
    expect(n.phone).toBe('+73952533050');
    expect(n.email).toBe('butkova@liner.irkutsk.ru');
    expect(n.in_crm).toBe(true);
    expect(n.activity_years).toEqual([2023, 2024]);
  });

  it('marks a row with neither phone nor email as low quality', () => {
    const n = normalizeRow(row({ phone_e164: '', phone_formatted: '', email: '' }));
    expect(n.data_quality).toBe('low');
    expect(n.issues).toContain('phone_missing_or_invalid');
  });
});

describe('duplicate detection inside the file', () => {
  it('groups rows sharing a phone', () => {
    const rows = [
      normalizeRow(row({ row_number: 2 })),
      normalizeRow(row({ row_number: 3, contact_name: 'Другая компания', company: '' })),
    ];
    const groups = findDuplicateGroups(rows);
    expect(groups.some((g) => g.key_type === 'phone' && g.rows.length === 2)).toBe(true);
  });

  it('ignores synthetic emails when grouping', () => {
    const rows = [
      normalizeRow(row({ row_number: 2, email: '79155238324@yandex.ru', phone_e164: '79155238324' })),
      normalizeRow(row({ row_number: 3, email: '79155238324@yandex.ru', phone_e164: '79991112233' })),
    ];
    const groups = findDuplicateGroups(rows);
    expect(groups.some((g) => g.key_type === 'email')).toBe(false);
  });
});

describe('import preparation', () => {
  it('splits the base into companies, contacts and review lists without touching the source', () => {
    const rows = [
      row({ row_number: 2 }),
      row({ row_number: 3, contact_name: 'GALACENTER', company: '', email: '', phone_e164: '74956633962' }),
      row({ row_number: 4, contact_name: '', company: '', email: '', phone_e164: '', phone_formatted: '' }),
    ];
    const prepared = prepare(rows, 'test.xlsx');

    expect(prepared.summary.total_rows).toBe(3);
    expect(prepared.summary.invalid_rows).toBe(1);
    expect(prepared.companies.map((c) => c.company_title)).toContain('GALACENTER');
    expect(prepared.summary.companies).toBeGreaterThan(0);
    expect(prepared.summary.generated_at).toBeTruthy();
  });
});

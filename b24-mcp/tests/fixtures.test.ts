import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards the committed fixtures under tests/fixtures/live.
 *
 * These are reference response shapes. They must stay anonymised: no real
 * client names, no live phone/email, no webhook or token. If a future
 * `npm run validate:live` run overwrites them with real data that slips past
 * the anonymiser, this test fails before it can be committed.
 */
const DIR = join(process.cwd(), 'tests/fixtures/live');

const FORBIDDEN = [
  /\/rest\/\d+\/[A-Za-z0-9]{8,}/, // webhook path
  /Арт Багет/,
  /Ромашка/,
  /artbaget/i,
  /\b7?9161112233\b/, // sample real phone digits
  /buyer@/,
];

describe('committed live fixtures', () => {
  const files = existsSync(DIR)
    ? readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'index.json')
    : [];

  it('the fixtures directory exists and is populated', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s contains no PII or secrets', (file) => {
    const text = readFileSync(join(DIR, file), 'utf8');
    for (const pattern of FORBIDDEN) {
      expect(text, `${file} matched ${pattern}`).not.toMatch(pattern);
    }
    // Must still be valid JSON with preserved structure.
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('captures both task dialects as reference shapes', () => {
    expect(files).toContain('tasks.legacy.list.json');
    expect(files).toContain('tasks.v3.list.json');
  });
});

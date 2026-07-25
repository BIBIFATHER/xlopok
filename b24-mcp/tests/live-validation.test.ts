import { describe, expect, it } from 'vitest';
import { testEnv } from './helpers/env.js';
import { sampleFixtures } from './helpers/fixtures.js';
import { MockBitrixClient } from './mocks/bitrix-mock.js';
import { validateLive } from '../src/validation/live-readonly.js';
import type { MockFixtures } from './mocks/bitrix-mock.js';

/**
 * The live runner is exercised here against the mock so its safety properties
 * are enforced in CI without a portal: write-safety, secret-free report,
 * anonymised fixtures, and probing of BOTH task dialects.
 */
function richFixtures(): MockFixtures {
  const base = sampleFixtures();
  return {
    ...base,
    tasks: [
      {
        id: 900,
        title: 'Отправить прайс клиенту Ромашка',
        deadline: '2026-06-15T09:00:00+03:00',
        responsibleId: 5,
        status: 2,
        ufCrmTask: ['D_100'],
        createdDate: '2026-06-01T09:00:00+03:00',
      },
    ],
  };
}

describe('live read-only validation runner', () => {
  it('refuses to run with WRITE_ENABLED=true', async () => {
    const env = testEnv({ WRITE_ENABLED: 'true' });
    await expect(validateLive(env, new MockBitrixClient(richFixtures()))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('runs read-only, never issues a write REST method', async () => {
    const env = testEnv({ WRITE_ENABLED: 'false' });
    const client = new MockBitrixClient(richFixtures(), /* writeEnabled */ false);
    const { report } = await validateLive(env, client);

    const writeMethods = client.calls.filter((c) =>
      /\.(add|update|delete)$/.test(c.method) || c.method.endsWith('.comment.add'),
    );
    expect(writeMethods).toHaveLength(0);
    expect(report.summary.total).toBeGreaterThan(15);
    expect(report.portal).toBe('test');
  });

  it('probes both legacy and v3 task dialects', async () => {
    const env = testEnv();
    const { report } = await validateLive(env, new MockBitrixClient(richFixtures(), false));
    expect(report.tasks_api.legacy).toBe('ok');
    expect(report.tasks_api.v3).toBe('ok');
    expect(report.tasks_api.confirmed_mode).toBe('legacy');
    expect(report.probes.some((p) => p.id === 'tasks.legacy.list')).toBe(true);
    expect(report.probes.some((p) => p.id === 'tasks.v3.list')).toBe(true);
  });

  it('keeps secrets and personal data out of the report', async () => {
    const env = testEnv();
    const { report } = await validateLive(env, new MockBitrixClient(richFixtures(), false));
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('s3cr3ttok3nvalue1234');
    expect(serialized).not.toContain('/rest/1/');
    expect(serialized).not.toContain('Ромашка');
    expect(serialized).not.toContain('artbaget.ru');
  });

  it('anonymises captured fixtures', async () => {
    const env = testEnv();
    const { fixtures } = await validateLive(env, new MockBitrixClient(richFixtures(), false));
    const serialized = JSON.stringify([...fixtures.values()]);
    expect(fixtures.size).toBeGreaterThan(0);
    expect(serialized).not.toContain('Ромашка');
    expect(serialized).not.toContain('Арт Багет');
    expect(serialized).not.toContain('9161112233');
  });

  it('confirms the write toolset stays unregistered', async () => {
    const env = testEnv();
    const { report } = await validateLive(env, new MockBitrixClient(richFixtures(), false));
    const guard = report.probes.find((p) => p.id === 'guard.write_tools_absent');
    expect(guard?.status).toBe('ok');
  });
});

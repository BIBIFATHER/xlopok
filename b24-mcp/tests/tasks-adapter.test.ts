import { describe, expect, it } from 'vitest';
import { testEnv, TEST_WEBHOOK } from './helpers/env.js';
import { MockBitrixClient, emptyFixtures } from './mocks/bitrix-mock.js';
import {
  LegacyTasksApi,
  V3TasksApi,
  TaskRepository,
  createTasksApi,
  unwrapTasks,
} from '../src/bitrix/tasks.js';
import { HttpBitrixClient } from '../src/bitrix/client.js';
import { RateLimiter } from '../src/security/rate-limit.js';

function tasksFixture() {
  return {
    ...emptyFixtures(),
    tasks: [
      {
        id: 900,
        title: 'Отправить прайс',
        deadline: '2026-06-15T09:00:00+03:00',
        responsibleId: 5,
        status: 2,
        ufCrmTask: ['D_100'],
        crmItemIds: ['D_100'],
        createdDate: '2026-06-01T09:00:00+03:00',
      },
      {
        id: 901,
        title: 'Закрытая задача',
        deadline: '2026-06-20T09:00:00+03:00',
        responsibleId: 5,
        status: 5,
        ufCrmTask: ['D_100'],
        crmItemIds: ['D_100'],
        createdDate: '2026-06-02T09:00:00+03:00',
      },
    ],
  };
}

describe('tasks adapter — both dialects', () => {
  it('legacy sends an object filter with prefixes and reads the tasks envelope', async () => {
    const client = new MockBitrixClient(tasksFixture());
    const api = new LegacyTasksApi(client);
    const page = await api.list({ openOnly: true, crmBindings: ['D_100'] });

    expect(page.mode).toBe('legacy');
    expect(page.items.map((t) => t.id)).toEqual([900]); // status 5 excluded
    const call = client.calls.find((c) => c.method === 'tasks.task.list')!;
    expect(Array.isArray(call.params.filter)).toBe(false);
    expect((call.params.filter as any)['@STATUS']).toBeDefined();
    expect(call.params.start).toBe(0);
  });

  it('v3 sends an array filter with a pagination object and reads result.items', async () => {
    const client = new MockBitrixClient(tasksFixture());
    const api = new V3TasksApi(client);
    const page = await api.list({ openOnly: true, crmBindings: ['D_100'] });

    expect(page.mode).toBe('v3');
    expect(page.items.map((t) => t.id)).toEqual([900]);
    const call = client.calls.find((c) => c.method === 'tasks.task.list')!;
    expect(Array.isArray(call.params.filter)).toBe(true);
    expect(call.params.pagination).toMatchObject({ limit: 50, offset: 0 });
    expect(call.params.start).toBeUndefined();
    // v3 calls are tagged in the audit call log.
    expect(client.drainCallLog()).toContain('tasks.task.list#v3');
  });

  it('both dialects normalise to the same domain Task', async () => {
    const legacy = await new LegacyTasksApi(new MockBitrixClient(tasksFixture())).list({
      openOnly: true,
    });
    const v3 = await new V3TasksApi(new MockBitrixClient(tasksFixture())).list({ openOnly: true });
    expect(legacy.items[0]).toEqual(v3.items[0]);
  });

  it('unwrapTasks handles tasks, result.items and bare arrays', () => {
    expect(unwrapTasks({ tasks: [{ id: 1 }] })).toHaveLength(1);
    expect(unwrapTasks({ result: { items: [{ id: 1 }] } })).toHaveLength(1);
    expect(unwrapTasks([{ id: 1 }])).toHaveLength(1);
    expect(unwrapTasks({})).toHaveLength(0);
  });

  it('createTasksApi honours TASKS_API_MODE', () => {
    testEnv({ TASKS_API_MODE: 'v3' });
    expect(createTasksApi(new MockBitrixClient()).mode).toBe('v3');
    testEnv({ TASKS_API_MODE: 'legacy' });
    expect(createTasksApi(new MockBitrixClient()).mode).toBe('legacy');
  });

  it('repository defaults to the configured mode', () => {
    testEnv({ TASKS_API_MODE: 'v3' });
    expect(new TaskRepository(new MockBitrixClient()).mode).toBe('v3');
  });
});

describe('v3 endpoint routing', () => {
  it('builds the /rest/api/ path and never the webhook for v3', async () => {
    const env = testEnv();
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ result: { items: [] } }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new HttpBitrixClient({ env, fetchImpl, limiter: new RateLimiter(1000) });
    await client.call('tasks.task.list', { select: ['id'] }, { api: 'v3' });
    await client.call('tasks.task.list', { select: ['ID'] });

    expect(urls[0]).toContain('/rest/api/1/');
    expect(urls[0]).toContain('/tasks.task.list');
    expect(urls[0]).not.toContain('.json');
    expect(urls[1]).toContain('/tasks.task.list.json');
    // Sanity: both derive from the same secret but the token is not our concern
    // here — the redaction test covers leakage.
    expect(urls.every((u) => u.startsWith(TEST_WEBHOOK.replace(/\/rest\/.*/, '')))).toBe(true);
  });

  it('refuses a v3 call for a method with no v3 variant', async () => {
    const env = testEnv();
    const client = new HttpBitrixClient({
      env,
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    });
    await expect(client.call('crm.item.list', {}, { api: 'v3' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('maps a v3 validation error to INVALID_REQUEST', async () => {
    const env = testEnv();
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'BITRIX_REST_V3_EXCEPTION_INVALIDPAGINATIONEXCEPTION',
            message: 'bad page',
          },
        }),
        { status: 400 },
      )) as unknown as typeof fetch;
    const client = new HttpBitrixClient({ env, fetchImpl, limiter: new RateLimiter(1000) });
    await expect(
      client.call('tasks.task.list', { pagination: { limit: 'x' } }, { api: 'v3' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { testEnv, TEST_WEBHOOK, TEST_ADMIN_TOKEN } from './helpers/env.js';
import {
  clearSecrets,
  maskEmail,
  maskPhone,
  redactValue,
  registerSecret,
  scrubSecrets,
} from '../src/security/redaction.js';
import { logger, setLogLevel } from '../src/security/logger.js';
import { HttpBitrixClient } from '../src/bitrix/client.js';
import { MockBitrixClient } from './mocks/bitrix-mock.js';
import { DomainError, mapBitrixError } from '../src/domain/errors.js';
import { RateLimiter } from '../src/security/rate-limit.js';

describe('secret redaction', () => {
  beforeEach(() => {
    clearSecrets();
  });

  it('scrubs a registered webhook URL from arbitrary text', () => {
    registerSecret(TEST_WEBHOOK);
    const text = `calling ${TEST_WEBHOOK}crm.item.list.json failed`;
    expect(scrubSecrets(text)).not.toContain('s3cr3ttok3nvalue1234');
  });

  it('scrubs webhook-shaped URLs even when never registered', () => {
    const text = 'GET https://other.bitrix24.ru/rest/9/abcdefgh1234/crm.deal.list.json';
    expect(scrubSecrets(text)).not.toContain('abcdefgh1234');
  });

  it('masks phone numbers and emails', () => {
    expect(maskPhone('звонок на +7 916 794-85-87')).toBe('звонок на 79****87');
    expect(maskEmail('пишите на anosov.anton@gmail.com')).toBe('пишите на a***@gmail.com');
  });

  it('redacts nested structures', () => {
    registerSecret(TEST_ADMIN_TOKEN);
    const out = redactValue({
      token: TEST_ADMIN_TOKEN,
      contact: { email: 'buyer@example.com', phone: '+79161234567' },
    }) as Record<string, any>;
    expect(JSON.stringify(out)).not.toContain(TEST_ADMIN_TOKEN);
    expect(JSON.stringify(out)).not.toContain('buyer@example.com');
    expect(JSON.stringify(out)).not.toContain('79161234567');
  });
});

describe('logger', () => {
  it('writes to stderr only and never leaks a secret', () => {
    testEnv();
    setLogLevel('info');
    registerSecret(TEST_WEBHOOK);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    logger.info('calling bitrix', { url: TEST_WEBHOOK, phone: '+79161234567' });

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledOnce();
    const line = String(stderr.mock.calls[0]![0]);
    expect(line).not.toContain('s3cr3ttok3nvalue1234');
    expect(line).not.toContain('79161234567');
  });
});

describe('REST allowlist', () => {
  it('refuses an arbitrary REST method', async () => {
    const env = testEnv();
    const client = new HttpBitrixClient({
      env,
      fetchImpl: (async () => {
        throw new Error('should not be called');
      }) as unknown as typeof fetch,
    });
    await expect(client.call('crm.dealcategory.add' as any)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses every delete method', async () => {
    const client = new MockBitrixClient();
    for (const method of ['crm.deal.delete', 'crm.company.delete', 'crm.contact.delete']) {
      await expect(client.call(method as any)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('has no generic passthrough tool', async () => {
    const client = new MockBitrixClient();
    await expect(client.call('bitrix_call' as any)).rejects.toBeInstanceOf(DomainError);
  });
});

describe('bitrix error mapping', () => {
  it('never echoes the raw description', () => {
    const err = mapBitrixError('QUERY_LIMIT_EXCEEDED');
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryable).toBe(true);
  });

  it('maps auth failures without hinting at credentials', () => {
    expect(mapBitrixError('NO_AUTH_FOUND').code).toBe('AUTH');
    expect(mapBitrixError('NO_AUTH_FOUND').message).not.toMatch(/token|webhook/i);
  });
});

describe('retries and timeouts', () => {
  it('retries a read method on a retryable failure but not a write', async () => {
    const env = testEnv({ WRITE_ENABLED: 'true' });
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'QUERY_LIMIT_EXCEEDED' }), { status: 503 });
    }) as unknown as typeof fetch;

    const client = new HttpBitrixClient({
      env,
      fetchImpl,
      maxRetries: 2,
      sleep: async () => undefined,
      limiter: new RateLimiter(1000),
    });

    await expect(client.call('crm.item.list')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(calls).toBe(3);

    calls = 0;
    await expect(client.call('crm.item.add')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(calls).toBe(1);
  });
});

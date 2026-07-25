import { loadEnv, resetEnv, type Env } from '../../src/config/env.js';
import { setFieldMaps } from '../../src/bitrix/field-map.js';
import { clearSecrets } from '../../src/security/redaction.js';

export const TEST_WEBHOOK = 'https://portal.bitrix24.ru/rest/1/s3cr3ttok3nvalue1234/';
export const TEST_ADMIN_TOKEN = 'a'.repeat(48);
export const TEST_CLAUDE_TOKEN = 'c'.repeat(48);
export const TEST_CODEX_TOKEN = 'x'.repeat(48);

/** Build a fully-populated Env without touching the real process environment. */
export function testEnv(overrides: Partial<Record<string, string>> = {}): Env {
  resetEnv();
  clearSecrets();
  setFieldMaps(null);
  const source: NodeJS.ProcessEnv = {
    BITRIX24_WEBHOOK_URL: TEST_WEBHOOK,
    MCP_AUTH_TOKEN: TEST_ADMIN_TOKEN,
    ADMIN_MCP_TOKEN: TEST_ADMIN_TOKEN,
    CLAUDE_MCP_TOKEN: TEST_CLAUDE_TOKEN,
    CODEX_MCP_TOKEN: TEST_CODEX_TOKEN,
    WRITE_ENABLED: 'false',
    LOG_LEVEL: 'error',
    DATA_DIR: 'data/test',
    ...overrides,
  };
  return loadEnv(source);
}

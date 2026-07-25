import { z } from 'zod';

/**
 * Environment contract.
 *
 * Secrets (BITRIX24_WEBHOOK_URL, MCP_AUTH_TOKEN) are parsed here and exposed
 * only through narrow accessors. They are deliberately excluded from the
 * object returned by `describeConfig()`, which is the only shape allowed to
 * reach logs or tool responses.
 */
const BooleanString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const EnvSchema = z.object({
  BITRIX24_WEBHOOK_URL: z
    .string()
    .url()
    .refine((v) => v.startsWith('https://'), 'webhook URL must use https')
    .refine((v) => /\/rest\/\d+\/[^/]+\/?$/.test(v), 'webhook URL must look like https://<portal>/rest/<user>/<secret>/'),
  MCP_AUTH_TOKEN: z.string().min(32, 'MCP_AUTH_TOKEN must be at least 32 chars'),
  WRITE_ENABLED: BooleanString.default('false'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  MAX_PAGE_SIZE: z.coerce.number().int().min(1).max(200).default(50),
  RATE_LIMIT_RPS: z.coerce.number().min(0.1).max(10).default(2),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),
  TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  FIELD_MAP_COMPANY: z.string().default(''),
  FIELD_MAP_DEAL: z.string().default(''),

  /**
   * Which `tasks.task.list` contract the portal answers.
   * Default stays 'legacy' — the classic webhook contract. Switch to 'v3'
   * only after the live validation run confirms it on that specific portal.
   */
  TASKS_API_MODE: z.enum(['legacy', 'v3']).default('legacy'),

  /* --- agent identity ------------------------------------------------------ */
  /** Identity assumed by a locally spawned stdio process. */
  AGENT_ID: z.enum(['claude_sales_agent', 'codex_sales_agent', 'admin']).default('admin'),
  /** Per-agent bearer tokens for the HTTP transport. Optional in stdio mode. */
  CLAUDE_MCP_TOKEN: z.string().default(''),
  CODEX_MCP_TOKEN: z.string().default(''),
  ADMIN_MCP_TOKEN: z.string().default(''),

  /* --- work distribution --------------------------------------------------- */
  ROUTING_MODE: z
    .enum(['round_robin', 'performance_based', 'specialization_based'])
    .default('round_robin'),
  /** performance_based routing stays inert below this per-agent sample size. */
  ROUTING_MIN_SAMPLE: z.coerce.number().int().min(1).default(50),
  ASSIGNMENT_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  MAX_TRANSFERS: z.coerce.number().int().min(0).max(5).default(2),
  /** Directory for assignment + metrics state (JSONL). */
  DATA_DIR: z.string().default('data'),
  AB_TEST_ENABLED: BooleanString.default('false'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/** Parse and cache process.env. Throws a redacted error on invalid config. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Only field names + messages — never the offending values.
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper — drops the memoised env. */
export function resetEnv(): void {
  cached = null;
}

/** Base URL for REST calls, normalised to a single trailing slash. */
export function webhookBaseUrl(env: Env = loadEnv()): string {
  return env.BITRIX24_WEBHOOK_URL.replace(/\/+$/, '') + '/';
}

/** Safe, secret-free view of the configuration for logs and diagnostics. */
export function describeConfig(env: Env = loadEnv()): Record<string, unknown> {
  return {
    writeEnabled: env.WRITE_ENABLED,
    logLevel: env.LOG_LEVEL,
    maxPageSize: env.MAX_PAGE_SIZE,
    rateLimitRps: env.RATE_LIMIT_RPS,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    transport: env.TRANSPORT,
    webhookConfigured: env.BITRIX24_WEBHOOK_URL.length > 0,
    authTokenConfigured: env.MCP_AUTH_TOKEN.length > 0,
    agentId: env.AGENT_ID,
    tasksApiMode: env.TASKS_API_MODE,
    routingMode: env.ROUTING_MODE,
    assignmentLockMinutes: env.ASSIGNMENT_LOCK_MINUTES,
    maxTransfers: env.MAX_TRANSFERS,
    abTestEnabled: env.AB_TEST_ENABLED,
  };
}

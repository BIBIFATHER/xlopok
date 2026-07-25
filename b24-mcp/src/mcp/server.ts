import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { describeConfig, loadEnv, type Env } from '../config/env.js';
import { isEntrypoint } from '../config/entrypoint.js';
import { HttpBitrixClient, type BitrixClient } from '../bitrix/client.js';
import { logger, setLogLevel } from '../security/logger.js';
import { DomainError } from '../domain/errors.js';
import {
  identityFromBearer,
  identityFromEnv,
  registerAgentSecrets,
  type Identity,
} from '../agents/roles.js';
import { buildToolContext, withIdentity, type ToolContext } from './tools/context.js';
import { buildReadTools, type ReadToolDefinition } from './tools/read-tools.js';
import { buildWriteTools } from './tools/write-tools.js';
import { buildSalesTools } from './tools/sales-tools.js';
import { PERMANENTLY_FORBIDDEN } from './permissions.js';

const SERVER_NAME = 'canvas-lab-b24-mcp';
const SERVER_VERSION = '0.1.0';

/**
 * Tool registration is role-aware and flag-aware:
 *  - read tools: everyone;
 *  - sales/assignment tools: everyone (local state only);
 *  - write tools: registered ONLY when WRITE_ENABLED=true. With the flag off
 *    the tool names are absent from tools/list, so an agent cannot even try.
 */
export function toolsForIdentity(ctx: ToolContext): ReadToolDefinition[] {
  const tools = [...buildReadTools(ctx), ...buildSalesTools(ctx)];
  if (ctx.env.WRITE_ENABLED) tools.push(...buildWriteTools(ctx));
  return tools;
}

/** Structured, secret-free error envelope returned to the caller. */
function toErrorPayload(err: unknown): { error: { code: string; message: string; details?: unknown } } {
  if (err instanceof DomainError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    };
  }
  return { error: { code: 'INTERNAL', message: 'Internal gateway error' } };
}

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        'Canvas Lab Bitrix24 gateway.',
        `Режим записи: ${ctx.env.WRITE_ENABLED ? 'включён' : 'выключен (только чтение)'}.`,
        `Роль вызывающего: ${ctx.identity.agentId}.`,
        `Запрещено всегда: ${PERMANENTLY_FORBIDDEN.join('; ')}.`,
      ].join(' '),
    },
  );

  for (const tool of toolsForIdentity(ctx)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      async (args: unknown) => {
        const started = Date.now();
        const budgetKey = `${ctx.identity.agentId}:${tool.name}`;
        try {
          if (!ctx.budget.tryConsume(budgetKey)) {
            throw new DomainError('RATE_LIMITED', 'Per-agent call budget exceeded for this tool');
          }
          const result = await tool.handler(args);
          if (isReadOnlyTool(tool.name)) {
            await ctx.audit.record({
              actor: ctx.identity.agentId,
              tool: tool.name,
              mode: 'read',
              outcome: 'ok',
              methods: ctx.client.drainCallLog(),
              args: args as Record<string, unknown>,
              durationMs: Date.now() - started,
            });
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          const payload = toErrorPayload(err);
          await ctx.audit.record({
            actor: ctx.identity.agentId,
            tool: tool.name,
            mode: isReadOnlyTool(tool.name) ? 'read' : 'write',
            outcome: payload.error.code === 'FORBIDDEN' ? 'denied' : 'error',
            methods: ctx.client.drainCallLog(),
            args: args as Record<string, unknown>,
            durationMs: Date.now() - started,
            error: payload.error.message,
          });
          logger.warn('tool call failed', { tool: tool.name, code: payload.error.code });
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
          };
        }
      },
    );
  }

  return server;
}

function isReadOnlyTool(name: string): boolean {
  return name.startsWith('crm_search') || name.startsWith('crm_get') || name === 'crm_find_duplicates' || name === 'crm_prepare_outreach' || name.startsWith('sales_get');
}

/* -------------------------------- bootstrap ------------------------------- */

async function startStdio(env: Env, client: BitrixClient): Promise<() => Promise<void>> {
  const ctx = buildToolContext({ client, env, identity: identityFromEnv(env) });
  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP server ready on stdio', describeConfig(env));
  return async () => {
    await server.close();
  };
}

async function startHttp(env: Env, client: BitrixClient): Promise<() => Promise<void>> {
  const baseCtx = buildToolContext({ client, env, identity: { agentId: 'admin', via: 'bearer' } });

  const http = createServer((req, res) => {
    void handleHttpRequest(req, res, env, baseCtx);
  });

  await new Promise<void>((resolve) => http.listen(env.PORT, resolve));
  logger.info(`MCP server ready on http://127.0.0.1:${env.PORT}/mcp`, describeConfig(env));

  return async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  };
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  env: Env,
  baseCtx: ToolContext,
): Promise<void> {
  // Health check is intentionally unauthenticated and secret-free.
  if (req.url?.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        server: SERVER_NAME,
        version: SERVER_VERSION,
        config: describeConfig(env),
      }),
    );
    return;
  }

  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } }));
    return;
  }

  let identity: Identity;
  try {
    identity = identityFromBearer(req.headers.authorization, env);
  } catch {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'AUTH', message: 'Unauthorized' } }));
    return;
  }

  // Stateless per-request server: each agent gets its own identity-bound tools.
  const ctx = withIdentity(baseCtx, identity);
  const server = createMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    logger.error('http transport failure', { message: err instanceof Error ? err.message : 'unknown' });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'Internal gateway error' } }));
    }
  }
}

export async function main(): Promise<void> {
  const env = loadEnv();
  setLogLevel(env.LOG_LEVEL);
  registerAgentSecrets(env);

  const client = new HttpBitrixClient({ env });
  const stop = env.TRANSPORT === 'http' ? await startHttp(env, client) : await startStdio(env, client);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`shutting down (${signal})`);
    try {
      await stop();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// Executed directly (not when imported by tests).
if (isEntrypoint(import.meta.url)) {
  main().catch((err) => {
    logger.error('fatal startup error', { message: err instanceof Error ? err.message : 'unknown' });
    process.exit(1);
  });
}

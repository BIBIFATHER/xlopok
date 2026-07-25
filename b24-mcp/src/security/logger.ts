import { redactValue, scrubSecrets } from './redaction.js';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

let threshold: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

/**
 * All output goes to stderr: stdout is the MCP stdio transport and must carry
 * nothing but JSON-RPC frames. Every field passes through redaction first.
 */
function emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (ORDER[level] > ORDER[threshold]) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg: scrubSecrets(message),
    ...(context ? { ctx: redactValue(context) } : {}),
  };
  console.error(JSON.stringify(record));
}

export const logger = {
  error: (m: string, c?: Record<string, unknown>) => emit('error', m, c),
  warn: (m: string, c?: Record<string, unknown>) => emit('warn', m, c),
  info: (m: string, c?: Record<string, unknown>) => emit('info', m, c),
  debug: (m: string, c?: Record<string, unknown>) => emit('debug', m, c),
};

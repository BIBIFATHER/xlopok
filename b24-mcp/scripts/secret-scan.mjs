#!/usr/bin/env node
/**
 * Secret scan.
 *
 * Fails the build when a Bitrix24 webhook, a long token literal or a committed
 * .env file appears anywhere in the tracked sources. Run before every commit:
 *   npm run secret-scan
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'data', 'coverage']);
const SCAN_EXT = new Set(['.ts', '.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.example', '']);

const PATTERNS = [
  {
    name: 'bitrix24-webhook-url',
    re: /https:\/\/[\w.-]+\.bitrix24\.[a-z]{2,3}\/rest\/\d+\/[A-Za-z0-9]{8,}/g,
  },
  { name: 'bearer-token-literal', re: /Bearer\s+[A-Za-z0-9_\-]{32,}/g },
  { name: 'hex-secret-literal', re: /\b[0-9a-f]{40,}\b/g },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
];

// Deliberate, non-secret occurrences: docs and tests use obvious placeholders.
const ALLOWED = [
  /portal\.bitrix24\.ru\/rest\/1\/s3cr3ttok3nvalue1234/,
  /other\.bitrix24\.ru\/rest\/9\/abcdefgh1234/,
  /<portal>/,
  /YOUR_WEBHOOK/,
];

const findings = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') {
      if (entry.name !== '.github') continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(full);
      continue;
    }
    if (entry.name === '.env' || entry.name.startsWith('.env.local')) {
      findings.push({ file: relative(ROOT, full), rule: 'committed-env-file', sample: entry.name });
      continue;
    }
    if (!SCAN_EXT.has(extname(entry.name)) && entry.name !== '.env.example') continue;
    const info = await stat(full);
    if (info.size > 2_000_000) continue;
    await scanFile(full);
  }
}

async function scanFile(path) {
  const text = await readFile(path, 'utf8').catch(() => '');
  if (!text) return;
  for (const { name, re } of PATTERNS) {
    for (const match of text.matchAll(re)) {
      const value = match[0];
      if (ALLOWED.some((a) => a.test(value))) continue;
      findings.push({
        file: relative(ROOT, path),
        rule: name,
        sample: value.slice(0, 12) + '…',
      });
    }
  }
}

await walk(ROOT);

if (findings.length > 0) {
  console.error('Secret scan FAILED:');
  for (const f of findings) console.error(`  ${f.file}: ${f.rule} (${f.sample})`);
  process.exit(1);
}
console.error('Secret scan passed: no webhook URLs, token literals or .env files found.');

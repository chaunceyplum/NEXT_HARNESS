/**
 * Vitest (unlike `next dev`/`next build`) does not load .env.local on its
 * own — evals need it for MCP_ENDPOINT_URL, provider credentials, and
 * DEFAULT_MODEL, so this loads it into process.env before any eval file (and
 * therefore before lib/mcp-client.ts reads MCP_ENDPOINT_URL at import time).
 * Never overrides a variable already set in the real environment, so a
 * one-off `EVAL_MODEL=anthropic:haiku npm run eval:agent` still wins.
 */
import fs from 'node:fs';
import path from 'node:path';

const envPath = path.resolve(import.meta.dirname, '..', '.env.local');

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Bundles each aws/lambdas/<name>/index.ts into a self-contained aws/dist/<name>/index.mjs.
 *
 * The `@` alias resolves to the repo root — the same alias tsconfig.json's
 * `paths` gives Next.js — so Lambda code importing `@/lib/llm/tool-catalog`
 * etc. resolves to the exact same source files Next.js uses. No copying,
 * no drift between what the control plane and the Lambdas think the agent
 * does.
 *
 * Run: node aws/esbuild.mjs   (or `npm run build:aws`, see package.json)
 * Then: cd aws && sam build && sam deploy
 */

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const LAMBDAS = ['init-run', 'agent-step', 'exec-tools', 'request-approval', 'inject-rejection', 'finalize'];

async function buildOne(name) {
  await build({
    entryPoints: [path.join(__dirname, 'lambdas', name, 'index.ts')],
    outfile: path.join(__dirname, 'dist', name, 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    sourcemap: true,
    minify: false,
    alias: { '@': repoRoot },
    // Every dependency here (AI SDK + provider packages, AWS SDK v3 clients)
    // is pure JS with no native/binary deps, so bundle everything rather
    // than externalizing — each function is self-contained and doesn't
    // depend on whatever SDK version the Lambda runtime happens to ship.
    external: [],
    banner: {
      // esbuild's ESM output has no require()/__dirname; a few transitive
      // deps still reference require() at module scope.
      js: "import { createRequire as __harnessCreateRequire } from 'module'; const require = __harnessCreateRequire(import.meta.url);",
    },
    logLevel: 'info',
  });
}

async function main() {
  for (const name of LAMBDAS) {
    await buildOne(name);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

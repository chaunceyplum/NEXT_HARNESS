# Tech

## Next.js: read the bundled docs first

This is NOT the Next.js you know. This version (`next` ^16.4) has breaking
changes: APIs, conventions and file structure may all differ from your
training data. Read the relevant guide in `node_modules/next/dist/docs/`
before writing any Next.js code, and heed deprecation notices. (Same rule as
`AGENTS.md` / `CLAUDE.md` at the repo root.)

## Stack

- Next.js ^16.4 (App Router, `output: "standalone"`), React ^19.3, TypeScript 5
- Vercel AI SDK `ai` ^7 with `@ai-sdk/anthropic`, `@ai-sdk/openai`,
  `@ai-sdk/amazon-bedrock`
- zod ^4 for schemas
- Tailwind CSS 4
- vitest ^4 for unit tests and evals
- Node 22 (Docker `node:22-alpine`)

## AI SDK v7 rules used in this codebase

- The system prompt goes in `instructions` (a `SystemModelMessage` with
  provider cache markers), not inside `messages`; v7 rejects system messages
  in `messages`.
- The agent loop is `streamText` with `stopWhen: [stepCountIs(maxSteps), ...]`
  and `prepareStep` for budget wrap-up and context compression.
- Tool approval uses the `toolApproval` option; it returns
  `'not-applicable'`, `{ type: 'approved' }` or `{ type: 'denied', reason }`.
- Per-step trace and side-effect tracking happen in `onStepEnd`.
- "History-bound" models (see `HISTORY_BOUND_MODEL_RE` in `lib/llm/agent.ts`)
  must not have earlier messages rewritten or tools swapped mid-run; use
  append-only notes and server-side context editing for them.
- Keep the tool list fixed for a whole agent loop (prompt cache and the
  history-bound check depend on it); extra tools are reached through
  `find_tools` / `call_tool`.

## Runtime model

- One Node process. Jobs (`lib/run-jobs.ts`), pending approvals
  (`lib/llm/approvals.ts`), the kill switch (`lib/kill-switch.ts`) and the
  read cache (`lib/llm/tool-call-cache.ts`) live in memory on `globalThis`
  so dev-mode module reloading doesn't split them. Don't move these to
  separate processes.
- Persistence goes through the MCP server's `execute_sql` tool
  (`lib/mcp-sql.ts`), which has no parameter binding: always escape values
  with the helpers in `lib/mcp-sql.ts`.
- Configuration is read from environment variables at request time; there
  are no `NEXT_PUBLIC_` variables. Document new variables in
  `.env.local.example` and `ENVIRONMENT_VARIABLES.md`.

## Commands

| Command | Use |
| --- | --- |
| `npm run dev` | Local dev server |
| `npx tsc --noEmit -p .` | Typecheck (CI) |
| `npm run lint` | ESLint (CI) |
| `npm test` | Unit tests, vitest (CI) |
| `npm run build` | Production build (CI) |
| `npm run eval:agent`, `eval:launch`, `eval:all` | Evals against real providers (need `.env.local`) |
| `docker compose up -d --build` | Run the app container |

## Conventions

- Match the surrounding code: comment density, naming and idiom. Files open
  with a block comment explaining why the module exists.
- Most modules in `lib/` have a sibling `*.test.ts`; add or update tests with
  every change.
- Failures of optional helpers (memory, knowledge lookup, critic, judge)
  never fail the run: log a warning and continue.
- Request options can only tighten deployment limits and policies, never
  loosen them.

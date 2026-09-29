# Multi-stage build. Full node_modules only exist in the deps/builder/evals
# stages. The `runner` image gets just what `output: "standalone"`
# (next.config.ts) traced as actually used.
#
# Targets:
#   runner (default)  the app: `docker compose up`
#   evals             the eval suite, which needs vitest and the full source:
#                     `docker compose run --rm evals`

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Every model/MCP setting is read at request time, not build time (there are
# no NEXT_PUBLIC_ variables), so no credentials are needed, or wanted, here.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Evals: vitest against real providers; results persist via the MCP server ──
FROM node:22-alpine AS evals
WORKDIR /app
ENV NODE_ENV=test NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 evals && chown -R evals:nodejs /app
USER evals
ENTRYPOINT ["npm", "run"]
CMD ["eval:all"]

# ── Runtime: the app ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1

# Next's own convention for standalone output: a dedicated non-root user.
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

# /api/models answers from the in-process model registry: no MCP, model, or
# database call, so it reflects "the server is up", not upstream health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/models > /dev/null || exit 1

# Runtime config (MCP_ENDPOINT_URL, DEFAULT_MODEL, ANTHROPIC_API_KEY, ...) is
# injected by compose's env_file (or `docker run --env-file`), never baked
# into the image. See .env.local.example.
CMD ["node", "server.js"]

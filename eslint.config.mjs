import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// ── Architecture boundaries (see .kiro/steering/structure.md) ────────────────
//
// lib/llm is layered:
//   models/   lowest: model registry, routing, pricing. Imports no other layer.
//   tools/    the MCP tool layer. Never imports runtime/, and reaches domains
//             only through the registry (lib/llm/domains/index.ts).
//   quality/  answer checks. May use the pure tool taxonomy, never the tool
//             runtime, the agent runtime or a domain's internals.
//   domains/  Adobe domain packs. May use the planner's Plan model and the pure
//             tool taxonomy; one pack never imports another pack.
//   runtime/  the agent loop and orchestration. Reaches domains only through
//             the registry.
// Type-only imports are always allowed: they create no runtime dependency.
// Tests are exempt, so they can reach internals.

const RUNTIME = { regex: "(^|/)runtime(/|$)", message: "This layer must not import lib/llm/runtime (it sits below the agent runtime)." };
const RUNTIME_EXCEPT_PLANNER = { regex: "(^|/)runtime/(?!planner$)", message: "Domains may use only the planner's Plan model from lib/llm/runtime." };
const TOOLS = { regex: "(^|/)tools(/|$)", message: "lib/llm/models must not import the tool layer." };
const TOOLS_EXCEPT_TAXONOMY = { regex: "(^|/)tools/(?!tool-taxonomy$)", message: "Use lib/llm/tools/tool-taxonomy (pure data) here, not the tool runtime." };
const QUALITY = { regex: "(^|/)quality(/|$)", message: "lib/llm/models must not import lib/llm/quality." };
const DOMAINS = { regex: "(^|/)domains(/|$)", message: "lib/llm/models must not import lib/llm/domains." };
const DOMAIN_INTERNALS = {
  regex: "(^|/)domains/[^/]+/",
  message: "Reach a domain through the registry (lib/llm/domains), not its own modules.",
};

const layer = (files, patterns) => ({
  files,
  ignores: ["**/*.test.ts"],
  rules: {
    "@typescript-eslint/no-restricted-imports": [
      "error",
      { patterns: patterns.map((p) => ({ ...p, allowTypeImports: true })) },
    ],
  },
});

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["lib/**/*.ts", "app/**/*.ts", "app/**/*.tsx", "components/**/*.tsx"],
    ignores: ["**/*.test.ts"],
    rules: { "import/no-cycle": ["error", { ignoreExternal: true }] },
  },
  layer(["lib/llm/models/**/*.ts"], [RUNTIME, TOOLS, QUALITY, DOMAINS]),
  layer(["lib/llm/tools/**/*.ts"], [RUNTIME, DOMAIN_INTERNALS]),
  layer(["lib/llm/quality/**/*.ts"], [RUNTIME, TOOLS_EXCEPT_TAXONOMY, DOMAIN_INTERNALS]),
  layer(["lib/llm/runtime/**/*.ts"], [DOMAIN_INTERNALS]),
  layer(["lib/llm/domains/**/*.ts"], [RUNTIME_EXCEPT_PLANNER, TOOLS_EXCEPT_TAXONOMY]),
  layer(["lib/llm/domains/launch/**/*.ts"], [
    RUNTIME_EXCEPT_PLANNER,
    TOOLS_EXCEPT_TAXONOMY,
    { regex: "(^|/)segments(/|$)", message: "One domain pack must not import another." },
  ]),
  layer(["lib/llm/domains/segments/**/*.ts"], [
    RUNTIME_EXCEPT_PLANNER,
    TOOLS_EXCEPT_TAXONOMY,
    { regex: "(^|/)launch(/|$)", message: "One domain pack must not import another." },
  ]),
  layer(["lib/*.ts", "app/**/*.ts", "app/**/*.tsx", "components/**/*.tsx"], [DOMAIN_INTERNALS]),
  // lib/types holds types only: any value import would pull implementation in.
  layer(["lib/types/**/*.ts"], [{ regex: ".*", message: "lib/types holds types only; use `import type`." }]),
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;

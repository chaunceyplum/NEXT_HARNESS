import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // esbuild/SAM build output (aws/esbuild.mjs, aws/README.md) — bundled,
    // not source; would otherwise get linted as if it were hand-written.
    "aws/dist/**",
    "aws/.aws-sam/**",
  ]),
]);

export default eslintConfig;

/**
 * Pre-commit check for msb_github_commit_code, run before the MCP tool is
 * ever called (see tool-catalog.ts's callTool) — so a syntactically broken
 * file is caught before it lands in git history at all, not after.
 *
 * Be precise about what this is NOT: it does not run the target repo's
 * actual build, its test suite, or type-check against the rest of that
 * codebase (none of that is reachable without checking the repo out,
 * installing its dependencies, and running its build — this harness has no
 * such sandbox). It only checks that each file parses — valid JSON where
 * that's expected, no JS/TS/JSX syntax errors elsewhere. A file can pass
 * this and still be wrong (bad types, broken logic, doesn't match the
 * rest of the codebase's conventions) — this catches "doesn't even
 * parse," nothing more.
 */

import ts from 'typescript';

const JSON_EXTENSIONS = ['.json'];
const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot).toLowerCase();
}

/** Returns one error string per problem found; empty array means everything parses. */
export function validateCommitFiles(filesJson: string): string[] {
  let files: unknown;
  try {
    files = JSON.parse(filesJson);
  } catch (err) {
    return [`"files" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`];
  }

  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return ['"files" must be a JSON object of { path: content }'];
  }

  const errors: string[] = [];

  for (const [path, content] of Object.entries(files as Record<string, unknown>)) {
    if (typeof content !== 'string') {
      errors.push(`${path}: content must be a string`);
      continue;
    }

    const ext = extensionOf(path);

    if (JSON_EXTENSIONS.includes(ext)) {
      try {
        JSON.parse(content);
      } catch (err) {
        errors.push(`${path}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (SCRIPT_EXTENSIONS.includes(ext)) {
      const result = ts.transpileModule(content, {
        fileName: path,
        reportDiagnostics: true,
        compilerOptions: {
          jsx: ts.JsxEmit.Preserve,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ESNext,
          allowJs: true,
        },
      });
      const syntaxErrors = (result.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
      if (syntaxErrors.length > 0) {
        const messages = syntaxErrors
          .map((d) => {
            const text = ts.flattenDiagnosticMessageText(d.messageText, ' ');
            if (d.file && d.start !== undefined) {
              const { line } = d.file.getLineAndCharacterOfPosition(d.start);
              return `line ${line + 1}: ${text}`;
            }
            return text;
          })
          .join('; ');
        errors.push(`${path}: syntax error(s) — ${messages}`);
      }
    }
    // Other extensions (css, md, html, yaml, ...): no lightweight parse
    // check available here — left unvalidated rather than false-failing.
  }

  return errors;
}

/** Throws (with no side effects — no commit attempted) if msb_github_commit_code's files don't parse. No-op for every other tool. */
export async function validateBeforeCommit(toolName: string, args: Record<string, unknown>): Promise<void> {
  if (toolName !== 'msb_github_commit_code') return;

  const filesArg = args.files;
  if (typeof filesArg !== 'string') return; // wrong shape — let the MCP tool itself report the schema mismatch

  const errors = validateCommitFiles(filesArg);
  if (errors.length > 0) {
    throw new Error(`Pre-commit syntax check failed — no commit was made:\n${errors.join('\n')}`);
  }
}

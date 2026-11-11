/**
 * Tools defined locally by the harness rather than sourced from the MCP's
 * tools/list — the agent's read access to GitHub repos. The MCP's own
 * msb_github_* tools (commit_code, create_branch, create_pr, get_pr_status,
 * merge_pr) are write/status-only; there is no read tool in that catalog,
 * which means "build on top of existing code" requests would otherwise be
 * blind writes — the model generating plausible-looking code from its own
 * training data instead of what's actually in the target repo. These two
 * tools close that gap without needing to modify the MCP server (out of
 * this repo's control): they call GitHub's REST API directly.
 *
 * Merged into the regular MCP tool catalog by getMcpToolCatalog()
 * (lib/llm/tool-catalog.ts) so everything downstream — tool-RAG shortlist
 * embeddings, ALWAYS_ON_TOOLS filtering, tool selection in lib/llm/agent.ts
 * — treats them exactly like an MCP tool. Only their *execution* differs
 * (see executeMcpToolWithRetry's isLocalTool check), which is why the
 * schemas live here rather than being tacked onto the MCP-fetching code path.
 */

import type { McpToolDefinition } from './tool-catalog';
import { envTimeoutMs, fetchWithTimeout } from '../fetch-timeout';
import { loadProfileCatalog } from './profile-catalog';
import { searchProfileFields } from './segment-context';

const READ_FILE_SCHEMA = {
  type: 'object',
  properties: {
    owner: { type: 'string', description: 'Repository owner' },
    repo: { type: 'string', description: 'Repository name' },
    path: { type: 'string', description: 'File path within the repo, e.g. "src/components/Header.tsx"' },
    ref: { type: 'string', description: "Branch, tag, or commit SHA. Omit to use the repo's default branch." },
  },
  required: ['owner', 'repo', 'path'],
};

const LIST_DIRECTORY_SCHEMA = {
  type: 'object',
  properties: {
    owner: { type: 'string', description: 'Repository owner' },
    repo: { type: 'string', description: 'Repository name' },
    path: { type: 'string', description: 'Directory path within the repo. Omit for the repo root.' },
    ref: { type: 'string', description: "Branch, tag, or commit SHA. Omit to use the repo's default branch." },
  },
  required: ['owner', 'repo'],
};

const FIND_PROFILE_FIELDS_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Business words for the fields you need, e.g. "CBM member", "SEP eligible", "company size", "do not contact".',
    },
    sandbox: { type: 'string', description: 'AEP sandbox name. Omit for the default sandbox.' },
    limit: { type: 'number', description: 'Most matches to return (default 15, max 50).' },
  },
  required: ['query'],
};

export const LOCAL_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    // Not an MCP tool: built from adobe_get_union_schema + the field groups it
    // lists (profile-catalog.ts), the same catalog segment writes are checked against.
    name: 'aep_find_profile_fields',
    description:
      "Find AEP profile fields by business words before writing a segment's PQL. Searches the sandbox's full profile schema (every field group in the profile union) by field title, name and description, and returns real field paths with their type, title, description and allowed values. Use the returned paths in PQL exactly as given.",
    inputSchema: FIND_PROFILE_FIELDS_SCHEMA,
  },
  {
    name: 'github_read_file',
    description:
      'Read the current contents of a file from a GitHub repository. Use this before proposing a change to existing code (via msb_github_commit_code) so the change is grounded in what is actually there, not guessed.',
    inputSchema: READ_FILE_SCHEMA,
  },
  {
    name: 'github_list_directory',
    description:
      'List the files and subdirectories at a path in a GitHub repository. Use to explore repo structure before deciding where and how to make a change.',
    inputSchema: LIST_DIRECTORY_SCHEMA,
  },
];

const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOL_DEFINITIONS.map((d) => d.name));

export function isLocalTool(name: string): boolean {
  return LOCAL_TOOL_NAMES.has(name);
}

function requireGitHubToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      'GITHUB_TOKEN is not configured. Set it in .env.local (a fine-grained PAT with read-only "Contents" access to the target repo(s)).'
    );
  }
  return token;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}

const GITHUB_TIMEOUT_MS = 30_000;

async function githubApiRequest(path: string, ref: string | undefined, signal?: AbortSignal): Promise<unknown> {
  const token = requireGitHubToken();
  const url = `https://api.github.com/repos/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;

  return fetchWithTimeout(
    url,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'next-harness-agent',
      },
    },
    { timeoutMs: envTimeoutMs('GITHUB_TIMEOUT_MS', GITHUB_TIMEOUT_MS), label: 'GitHub API', signal },
    async (response) => {
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`GitHub API ${response.status}: ${response.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
      }
      return response.json();
    }
  );
}

async function githubReadFile(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const path = requireString(args, 'path');
  const ref = typeof args.ref === 'string' ? args.ref : undefined;

  const data = await githubApiRequest(`${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, ref, signal);

  if (Array.isArray(data)) {
    throw new Error(`"${path}" is a directory, not a file — use github_list_directory instead`);
  }
  const file = data as { type?: string; content?: string; encoding?: string; sha?: string; size?: number };
  if (file.type !== 'file' || typeof file.content !== 'string') {
    throw new Error(`"${path}" is not a readable file (type: ${file.type ?? 'unknown'})`);
  }

  const content = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf-8').toString('utf-8');
  return { path, content, sha: file.sha, size: file.size };
}

async function githubListDirectory(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const path = typeof args.path === 'string' ? args.path : '';
  const ref = typeof args.ref === 'string' ? args.ref : undefined;

  const data = await githubApiRequest(
    `${owner}/${repo}/contents/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`,
    ref,
    signal
  );

  if (!Array.isArray(data)) {
    throw new Error(`"${path || '/'}" is a file, not a directory — use github_read_file instead`);
  }
  return data.map((entry) => {
    const e = entry as { name: string; path: string; type: string; size: number };
    return { name: e.name, path: e.path, type: e.type, size: e.size };
  });
}

async function findProfileFields(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const query = requireString(args, 'query');
  const sandbox = typeof args.sandbox === 'string' && args.sandbox.trim() ? args.sandbox.trim() : undefined;
  const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : 15;
  const catalog = await loadProfileCatalog(sandbox, { signal });
  if (catalog.fields.length === 0) {
    throw new Error(`Could not read the profile schema${sandbox ? ` for sandbox "${sandbox}"` : ''}: ${catalog.error ?? 'no fields found'}`);
  }
  const matches = searchProfileFields(catalog.fields, query, limit);
  return {
    query,
    fieldCount: catalog.fields.length,
    // A partial read can miss a field: say so rather than imply "no such field".
    complete: catalog.complete,
    ...(catalog.complete ? {} : { warning: `Some field groups could not be read (${catalog.error}); a field missing here may still exist.` }),
    matches,
    ...(matches.length === 0 ? { note: 'No field matches these words. Try other words, or treat the condition as having no field.' } : {}),
  };
}

export async function executeLocalTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  switch (name) {
    case 'github_read_file':
      return githubReadFile(args, signal);
    case 'github_list_directory':
      return githubListDirectory(args, signal);
    case 'aep_find_profile_fields':
      return findProfileFields(args, signal);
    default:
      throw new Error(`Unknown local tool: ${name}`);
  }
}

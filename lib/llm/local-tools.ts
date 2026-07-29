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

export const LOCAL_TOOL_DEFINITIONS: McpToolDefinition[] = [
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

async function githubApiRequest(path: string, ref?: string): Promise<unknown> {
  const token = requireGitHubToken();
  const url = `https://api.github.com/repos/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'next-harness-agent',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GitHub API ${response.status}: ${response.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
  }

  return response.json();
}

async function githubReadFile(args: Record<string, unknown>): Promise<unknown> {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const path = requireString(args, 'path');
  const ref = typeof args.ref === 'string' ? args.ref : undefined;

  const data = await githubApiRequest(`${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, ref);

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

async function githubListDirectory(args: Record<string, unknown>): Promise<unknown> {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const path = typeof args.path === 'string' ? args.path : '';
  const ref = typeof args.ref === 'string' ? args.ref : undefined;

  const data = await githubApiRequest(
    `${owner}/${repo}/contents/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`,
    ref
  );

  if (!Array.isArray(data)) {
    throw new Error(`"${path || '/'}" is a file, not a directory — use github_read_file instead`);
  }
  return data.map((entry) => {
    const e = entry as { name: string; path: string; type: string; size: number };
    return { name: e.name, path: e.path, type: e.type, size: e.size };
  });
}

export async function executeLocalTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'github_read_file':
      return githubReadFile(args);
    case 'github_list_directory':
      return githubListDirectory(args);
    default:
      throw new Error(`Unknown local tool: ${name}`);
  }
}

/**
 * GET /api/tools
 *
 * Every tool in the live catalog (MCP tools/list plus the harness's local
 * tools) with its profile: access level, platforms, owning domain, whether it
 * is outbound / returns credentials / runs SQL, and whether a call waits for
 * approval in autonomous mode. Backed by lib/llm/tools/tool-registry.ts.
 * Read-only — use it to audit how the harness will treat each tool.
 */

import { getMcpToolCatalog } from '@/lib/llm/tools/tool-catalog';
import { describeTools } from '@/lib/llm/tools/tool-registry';
import { ApiError } from '@/lib/types';

export async function GET(): Promise<Response> {
  try {
    const catalog = await getMcpToolCatalog();
    const tools = describeTools(catalog.map((t) => t.name));
    return Response.json({ tools, total: tools.length }, { status: 200 });
  } catch (error) {
    console.error('[TOOLS] Failed to read the tool catalog:', error);
    return Response.json(
      {
        error: `Failed to read the tool catalog: ${error instanceof Error ? error.message : String(error)}`,
        code: 'INTERNAL_ERROR',
      } as ApiError,
      { status: 502 }
    );
  }
}

/**
 * aep_find_profile_fields: a harness-run tool that searches the sandbox's full
 * profile schema by business words, so a segment's PQL only uses real field
 * paths. Moved verbatim from lib/llm/tools/local-tools.ts; the tool layer now
 * picks it up through the domain registry (segmentsPack.localTools).
 */

import type { DomainLocalTool } from '../domain-pack';
import { loadProfileCatalog } from './profile-catalog';
import { searchProfileFields } from './context';

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

async function findProfileFields(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const query = args.query;
  if (typeof query !== 'string' || query.length === 0) {
    throw new Error('"query" is required and must be a non-empty string');
  }
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

export const findProfileFieldsTool: DomainLocalTool = {
  definition: {
    // Not an MCP tool: built from adobe_get_union_schema + the field groups it
    // lists (profile-catalog.ts), the same catalog segment writes are checked against.
    name: 'aep_find_profile_fields',
    description:
      "Find AEP profile fields by business words before writing a segment's PQL. Searches the sandbox's full profile schema (every field group in the profile union) by field title, name and description, and returns real field paths with their type, title, description and allowed values. Use the returned paths in PQL exactly as given.",
    inputSchema: FIND_PROFILE_FIELDS_SCHEMA,
  },
  execute: findProfileFields,
};

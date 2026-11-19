/**
 * Which Adobe objects a run created, updated or deleted, derived from its
 * recorded tool calls and results. Pure: it reads StepRecords after the
 * fact and never touches the execution path.
 *
 * The object kind and change come from the tool name, which follows
 * `<platform>_<verb>_<object>` (adobe_create_segment, reactor_update_rule,
 * cja_copy_project) or `<platform>_<object>_<verb>` (query_schedule_create).
 * `..._to_<object>` / `..._from_<object>` name the object being changed
 * (reactor_add_resources_to_library updates the library).
 *
 * The id comes from the result for a create (id, data.id, $id, @id, or an
 * "@/dataSets/<id>" style path) and from the arguments otherwise
 * (`<object>_id`, then `id`). A call whose id can't be found is left out
 * rather than guessed.
 *
 * Skipped: reads, failed or denied calls, dry-run descriptions, and tools
 * outside the Adobe platforms (GitHub, SQL, knowledge search).
 */

import type { AdobeObjectRef, AdobePlatform, ChangedObject, LineageRecord, ObjectChange, StepRecord } from '../../types';
import { effectiveToolCall } from './tool-discovery';
import { classifyTool } from './tool-taxonomy';

const PLATFORMS: readonly AdobePlatform[] = ['adobe', 'reactor', 'cja', 'dataprep', 'destination', 'source', 'flow', 'query'];

const CREATE_VERBS = new Set(['create', 'upload', 'generate', 'copy', 'install']);
const DELETE_VERBS = new Set(['delete', 'trash', 'purge']);
/** Every other write verb (update, add, remove, enable, transition, build, set, ...) changes an existing object. */
const VERBS = new Set([
  ...CREATE_VERBS,
  ...DELETE_VERBS,
  'update', 'add', 'remove', 'enable', 'disable', 'transition', 'build', 'complete', 'abort', 'cancel', 'set',
  'publish', 'share', 'merge', 'execute', 'run',
]);

/** The platform, change and object noun a write tool's name describes, or undefined for anything else. */
export function describeWrite(toolName: string): { platform: AdobePlatform; change: ObjectChange; object: string } | undefined {
  const platform = PLATFORMS.find((p) => toolName.startsWith(`${p}_`));
  if (!platform || classifyTool(toolName) === 'read') return undefined;
  const tokens = toolName.slice(platform.length + 1).split('_');
  if (tokens.length < 2) {
    // flow_enable / flow_disable: the verb alone, the object is the platform's own (a flow).
    return VERBS.has(tokens[0]) ? { platform, change: changeOf(tokens[0]), object: platform } : undefined;
  }

  let verb: string;
  let object: string[];
  if (VERBS.has(tokens[0])) {
    verb = tokens[0];
    object = tokens.slice(1);
  } else if (VERBS.has(tokens[tokens.length - 1])) {
    verb = tokens[tokens.length - 1];
    object = tokens.slice(0, -1);
  } else {
    return undefined;
  }
  // "add_resources_to_library", "remove_resources_from_library": the object is the library, and it is updated.
  const link = object.findIndex((t) => t === 'to' || t === 'from');
  if (link >= 0 && link < object.length - 1) {
    return { platform, change: 'updated', object: object.slice(link + 1).join('_') };
  }
  return { platform, change: changeOf(verb), object: object.join('_') };
}

function changeOf(verb: string): ObjectChange {
  if (CREATE_VERBS.has(verb)) return 'created';
  if (DELETE_VERBS.has(verb)) return 'deleted';
  return 'updated';
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return asObject(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);

/** The id a create returned, from the common AEP / Reactor / CJA response shapes. */
export function idFromResult(result: unknown): string | undefined {
  if (Array.isArray(result)) {
    // AEP Catalog returns ["@/dataSets/<id>"] for a new dataset.
    const path = result.find((v) => typeof v === 'string' && v.startsWith('@/'));
    return path ? str(path.split('/').pop()) : undefined;
  }
  const obj = asObject(result);
  if (!obj) {
    // A truncated result (capToolResult) is a string prefix of the JSON.
    return typeof result === 'string' ? result.match(/"id"\s*:\s*"([^"]+)"/)?.[1] : undefined;
  }
  return str(obj.id) ?? str(asObject(obj.data)?.id) ?? str(obj.$id) ?? str(obj['@id']) ?? str(asObject(obj.result)?.id);
}

function idFromArgs(args: Record<string, unknown>, object: string): string | undefined {
  return str(args[`${object}_id`]) ?? str(args.id) ?? str(args[`${object.split('_').pop()}_id`]);
}

function nameOf(args: Record<string, unknown>, result: unknown): string | undefined {
  const obj = asObject(result);
  const attrs = asObject(args.attributes) ?? asObject(asObject(obj?.data)?.attributes);
  return str(args.name) ?? str(args.title) ?? str(attrs?.name) ?? str(obj?.name) ?? str(obj?.title);
}

function sandboxOf(args: Record<string, unknown>): string | undefined {
  return str(args.sandbox) ?? str(args.sandbox_name) ?? str(args.sandboxName);
}

/** The object one executed write call changed, or undefined when it isn't an Adobe write or has no findable id. */
export function refForCall(toolName: string, input: unknown, output: unknown): { ref: AdobeObjectRef; change: ObjectChange; tool: string } | undefined {
  const call = effectiveToolCall(toolName, input);
  const write = describeWrite(call.toolName);
  if (!write) return undefined;
  if (asObject(output)?._dryRun === true) return undefined;
  const args = asObject(call.input) ?? {};
  const id = write.change === 'created' ? (idFromResult(output) ?? idFromArgs(args, write.object)) : idFromArgs(args, write.object);
  if (!id) return undefined;
  const name = nameOf(args, output);
  const sandbox = sandboxOf(args);
  return {
    ref: { kind: `${write.platform}:${write.object}`, id, ...(name ? { name } : {}), ...(sandbox ? { sandbox } : {}) },
    change: write.change,
    tool: call.toolName,
  };
}

/**
 * Every Adobe object change in these steps. Calls are paired with results
 * of the same tool in order, as the SDK emits them; a call with no result,
 * or whose result is an error, changed nothing.
 */
export function lineageFromSteps(steps: readonly StepRecord[], workerId?: string): LineageRecord[] {
  const out: LineageRecord[] = [];
  for (const step of steps) {
    const used = new Set<number>();
    for (const call of step.toolCalls) {
      const idx = step.toolResults.findIndex((r, i) => !used.has(i) && r.toolName === call.toolName);
      if (idx < 0) continue;
      used.add(idx);
      const result = step.toolResults[idx];
      if (result.error) continue;
      const change = refForCall(call.toolName, call.input, result.output);
      if (change) out.push({ ...change, step: step.stepNumber, ...((step.workerId ?? workerId) ? { workerId: step.workerId ?? workerId } : {}) });
    }
  }
  return out;
}

/** The distinct objects in a lineage, latest change last (an object created then updated appears once). */
export function objectsIn(lineage: readonly LineageRecord[]): ChangedObject[] {
  const byKey = new Map<string, ChangedObject>();
  for (const entry of lineage) {
    const key = `${entry.ref.kind}\u0000${entry.ref.id}`;
    const prev = byKey.get(key);
    // A create followed by updates is still "created" from the run's point of view.
    const change = prev?.change === 'created' && entry.change === 'updated' ? 'created' : entry.change;
    byKey.delete(key);
    byKey.set(key, { ...prev, ...entry.ref, change });
  }
  return [...byKey.values()];
}

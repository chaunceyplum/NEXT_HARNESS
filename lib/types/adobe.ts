/** Typed references to Adobe Experience Cloud objects, and run lineage (lib/llm/tools/object-refs.ts). */

/** The tool-name prefix of the Adobe product an object lives in. */
export type AdobePlatform = 'adobe' | 'reactor' | 'cja' | 'dataprep' | 'destination' | 'source' | 'flow' | 'query';

/**
 * `<platform>:<object>`, derived from the tool that touched it, e.g.
 * "adobe:segment", "adobe:dataset", "reactor:data_element",
 * "reactor:library", "cja:calculated_metric", "query:schedule".
 */
export type AdobeObjectKind = `${AdobePlatform}:${string}`;

/** One Adobe object: what it is, its id, and where it lives. */
export interface AdobeObjectRef {
  kind: AdobeObjectKind;
  id: string;
  name?: string;
  sandbox?: string;
}

export type ObjectChange = 'created' | 'updated' | 'deleted';

/** An object and the net change a run (or worker) made to it. */
export type ChangedObject = AdobeObjectRef & { change: ObjectChange };

/**
 * One change a run made to an Adobe object, derived from a successful,
 * executed (not dry-run, not denied) write tool call. Stored on the run
 * record (RunResult.lineage), so "what did run X change?" and "which run
 * created this segment?" can both be answered (lib/lineage-store.ts).
 */
export interface LineageRecord {
  ref: AdobeObjectRef;
  change: ObjectChange;
  /** The tool that made the change (call_tool unwrapped). */
  tool: string;
  /** 1-based step number within the run (or the worker, for a worker's own steps). */
  step: number;
  /** Orchestrated runs: the worker that made the change. */
  workerId?: string;
}

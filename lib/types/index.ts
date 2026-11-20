/**
 * Shared types for the harness: what a run is, stores and streams.
 *
 * One module per concept:
 *   run.ts      RunRequest, RunResult, RunRecord, RunSummary, ResumePlan
 *   stream.ts   RunStreamEvent
 *   agent.ts    agent loop steps, tool calls and results, token usage
 *   worker.ts   orchestrator-worker records
 *   plan.ts     the stored plan
 *   quality.ts  critique and RAG judgments
 *   model.ts    routing decisions and model options
 *   eval.ts     eval history
 *   adobe.ts    typed Adobe object references and run lineage
 *   api.ts      API error bodies
 *
 * Naming: …Record is something stored in a run record (or its own table),
 * …Summary a list row, …Request / …Result / …Response an API shape, …Event a
 * stream event. These modules hold types only and import no implementation.
 */

export type { RunStatus } from '../run-lifecycle';
export type { AdobeObjectKind, AdobeObjectRef, AdobePlatform, ChangedObject, LineageRecord, ObjectChange } from './adobe';
export type { ToolCallRecord, ToolResultRecord, StepRecord, TokenUsage } from './agent';
export type { WorkerStatus, WorkerResult, WorkerRecord, SeenObject } from './worker';
export type { PlanRecord } from './plan';
export type { RagJudgment, RagJudgmentRecord, CritiqueRecord } from './quality';
export type { RouteRecord, ModelOption } from './model';
export type { RunVersions, RunRequest, RunResult, ResumePlan, RunSummary, RunRecord, RunsListResponse } from './run';
export type { RunStreamEvent } from './stream';
export type { ApiError } from './api';
export type { EvalRunMetrics, EvalSuite, EvalRunSummary, EvalTrialRecord, EvalRunDetail, EvalRunsListResponse } from './eval';

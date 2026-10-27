# Shared safety state and observability for orchestrated runs (Task 7)

Task 7 stops each worker from being its own safety island. The run's single `LaunchValidationGate`, its approval gate, its abort controller and its trace are now shared across every worker instead of being rebuilt per worker, and the coordinator gains trace spans so a fan-out run reads as one tree rather than N disconnected ones. The approach leans on sharing instances that already existed for single-agent runs (the gate is embedded in the tool set the coordinator narrows per worker; the approval registry is keyed per run+tool-call; the abort signal is linked through child controllers) rather than reimplementing safety inside the worker. All four CI gates are green per `ci-task7.md` (tsc, lint, 542 tests, build), and the five new tests map one-to-one onto the four sub-tasks.

Watch for: the coordinator-span → parent-run-span link is **not** wired (confirmed) — `OrchestratorInput.tracerParent` and `LoopContext.tracerParent` are plumbed into the types and consumed by the tracer, but no caller ever supplies them, so the "run → coordinator → worker → step" tree claimed in comments and `ci-task7.md` is really "coordinator → worker → step" with the coordinator as a fresh root. Harmless (undefined falls back to a fresh trace, exactly as before) and outside the strict task-7.3 deliverable, but the comments overstate it.

**Verdict**: APPROVED

## High-level view

The shared gate (7.1) is the strongest piece: because `workerTools` narrows the run's tool set by reference and those tools were gate-wrapped once at the run level, every worker necessarily calls through the same `LaunchValidationGate` instance — there is no code path that could hand a worker an ungated tool.

Approvals (7.2) reuse the run's single `toolApproval` gate and a registry keyed by `runId:toolCallId`, so concurrent workers' risky calls coexist as distinct pending entries and resolve independently. The kill switch (7.4) works because each worker links a child abort controller to the run's registered signal, so a single `engageKillSwitch` cancels every in-flight worker at once rather than one.

Observability (7.3) adds `SpanRef`, opens one coordinator span, nests every worker under it via `shared.tracerParent`, and records a per-worker summary span carrying worker id, step, attempt, status, model and token spend. The coordinator→worker nesting is implemented and tested; the only loose end is the unused parent-run plumbing above the coordinator.

<details>
<summary>Issues (1)</summary>

1. **Unused coordinator trace-parent plumbing** — `OrchestratorInput.tracerParent` (and `LoopContext.tracerParent`) are declared and consumed but never supplied by any caller: the `runOrchestrated` call in `runAgent` omits `tracerParent`, and nothing assigns `ctx.tracerParent` in `prepareRun`. Either wire a run span above the coordinator or drop the field and soften the "run → coordinator" wording in the comments and CI evidence. Non-blocking.

</details>

<details>
<summary>Details</summary>

### One shared gate reaches every worker (7.1)

The guarantee is structural, not incidental. `buildAiTools(catalog, { launchGate: launch?.gate })` wraps each tool's `execute` with the run's single gate (agent.ts), and that wrapped tool set becomes `ctx.tools`, which `runAgent` passes straight into `runOrchestrated` as `tools`. The coordinator never rebuilds tools; it narrows per worker through `workerTools(all, step, catalog)`, whose only selection move is `out[name] = all[name]`. Copying by reference means a worker's `reactor_create_library` is the exact gate-wrapped object the run built — there is no branch that could produce an ungated variant. The gate is additionally carried on `LoopContext.launchGate` → `SharedRunState.launchGate` → the worker's `LoopContext`, which supplies the worker's Launch-mode grounding and makes the shared instance explicit rather than purely implicit in the tool closure.

The new worker test seeds a gate so a created rule component references an uninstalled `web-sdk` extension, then has the worker attempt `reactor_create_library`. The gate throws before the write, `handoffSucceeded` stays false, and the step ends `failed`. The test wires its own gate-wrapped tool rather than going through `buildAiTools`, which the CI evidence states plainly; given that `workerTools` provably forwards the run's wrapped tools, the test exercises the same wrapper shape the production path uses.

### Shared approval gate with several pending approvals (7.2)

Workers route risky calls through the run's single `toolApproval` gate (shared via `SharedRunState.toolApproval` → worker `LoopContext`), so a worker's call is gated exactly like a single-agent one. The approvals registry keys pending entries by `runId:toolCallId`, so two workers in the same run produce distinct keys and never collide. The new test holds three approvals pending for one run, approves the middle one and confirms the other two stay pending, then denies/approves each independently with distinct `decidedBy` — a clean proof of per-call independence.

### Kill switch aborts every worker, not one (7.4)

Each worker links a child `AbortController` to the run's registered signal, so cancellation fans out from the run signal to all workers. The test is a real end-to-end one: three `runWorker` calls share one run's `AbortController` (registered with the kill switch) and hang on their first model call until their child signal fires. A single `engageKillSwitch` (`aborted === 1`, one registered run) ends all three workers `cancelled`. The model mock rejects with `abortSignal.reason` on abort, which the worker loop treats as cancellation — the assertion that all three records are `cancelled` rules out the "only the first worker aborted" failure mode the task calls out.

### Coordinator and per-worker spans, with one unwired link (7.3)

`SpanRef { traceId, spanId }` is added to `lib/tracing.ts`, and `RunTracer` takes an optional `parent`: when set, its root joins the parent's trace id and sets `parentSpanId`; when unset it opens a fresh trace exactly as before. `ref()` exposes the root for nesting. The tracing test confirms a child tracer nests under a parent `SpanRef`, shares its trace id across all its spans, and leaves the parent's own root unparented.

The coordinator opens one span (`harness.orchestration=true`), sets `shared.tracerParent = coordinatorTracer.ref()` so every worker nests under it (coordinator test asserts all workers receive the same `tracerParent`), records a per-worker summary span carrying worker id / step / attempt / status / model / total tokens, and on finish exports the coordinator span plus the worker summary spans best-effort inside a try/catch — matching `executeLoop`'s export discipline so tracing can't disturb the run.

The gap (confirmed): the layer above the coordinator is never connected. `OrchestratorInput.tracerParent` exists and `runOrchestrated` passes it into `new RunTracer(..., input.tracerParent)`, but the sole call site in `runAgent` does not pass `tracerParent`:

```
const orchestrated = await runOrchestrated({
  ...
  ...(ctx.launchGate ? { launchGate: ctx.launchGate } : {}),
  ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
  ...                       // no tracerParent here
});
```

Symmetrically, `executeLoop` reads `ctx.tracerParent` (two `new RunTracer` calls) but `prepareRun` never assigns it and there is no `RunAgentOptions.tracerParent`, so the single-agent path can't supply one either. The net effect is that the coordinator span is always a fresh root; the "full tree is run → coordinator → worker → step" in the coordinator comment and in `ci-task7.md` is aspirational. Because the required 7.3 deliverables — `SpanRef`, the coordinator span, the per-worker summary spans with worker attributes, and worker nesting under the coordinator — are all present and tested, this is unused forward-looking plumbing rather than a behavioral miss.

### Scope

The diff is confined to the four sub-tasks: `lib/tracing.ts` + test (SpanRef/nesting), `lib/llm/coordinator.ts` + test (coordinator/worker spans), `lib/llm/agent-core.ts` and `agent.ts` (gate + tracerParent fields and the gate wiring into `runOrchestrated`), `lib/llm/worker.ts` + test (shared gate on the handoff), `lib/llm/approvals.test.ts` (multi-pending), and `lib/kill-switch.test.ts` (fan-out abort). No fixture or baseline changed, consistent with the checkpoint discipline the spec sets for refactors; no unrelated changes are bundled in.

</details>

<details>
<summary>File map</summary>

- `lib/tracing.ts` — `SpanRef` interface; `RunTracer` accepts an optional parent span and exposes `ref()`; root span sets `parentSpanId` when nested.
- `lib/tracing.test.ts` — child tracer nests under a parent `SpanRef` and shares its trace id.
- `lib/llm/coordinator.ts` — coordinator span, `shared.tracerParent`, per-worker summary spans, best-effort export; `OrchestratorInput.tracerParent` (unused by callers).
- `lib/llm/coordinator.test.ts` — every worker gets the same coordinator `tracerParent`.
- `lib/llm/agent-core.ts` — `LoopContext.launchGate` and `LoopContext.tracerParent` fields.
- `lib/llm/agent.ts` — carry `launchGate` onto the ctx; nest `executeLoop` tracer under `ctx.tracerParent` (never set); pass `launchGate` into `runOrchestrated` (`tracerParent` omitted).
- `lib/llm/worker.ts` — `SharedRunState.tracerParent`; forward it into each worker's `LoopContext`.
- `lib/llm/worker.test.ts` — shared gate still blocks a worker's library handoff.
- `lib/llm/approvals.test.ts` — several pending approvals per run resolve independently.
- `lib/kill-switch.test.ts` — one kill-switch trip cancels all three in-flight workers.
- `.agents/tasks/ci-task7.md` — CI evidence (new).
- `.kiro/specs/orchestrator-workers/tasks.md` — Task 7 sub-tasks checked off.

Full diff: `git show dc39c11`.

</details>

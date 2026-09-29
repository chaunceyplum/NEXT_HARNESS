# Operating the harness

The weekly habits that keep an agent good once real users rely on it
(field guide §5.6, §6.6). Everything below uses pages that already exist.

## Weekly trace review (30 minutes)

1. Open **/metrics** for the last 7 days. Note success rate, p95 latency,
   cost per success and escalation rate against last week's.
2. Work the **Review queue** (runs rated 👎 or failed by the online judge).
   Open each one in `/results/[id]`: read the trace, the audit trail and
   the judge's notes.
3. Also open **five successes and five failures** from `/results`, chosen at
   random, not only the flagged ones. Judge and user misses hide in the
   unflagged runs.
4. Every review produces at least one of:
   - **an eval case**: a new fixture in `evals/fixtures/agent/` reproducing
     the failure, with the expected behaviour.
   - **a tool or prompt fix**: a clearer tool description, a guardrail, or a
     system-prompt rule, with the eval case that proves it.
5. After changing a prompt, tool or model, run `npm run eval:all` (or wait
   for the nightly run) and compare with `evals/baseline.json`.

## Signals and where they come from

| Signal | Source | Where to see it |
| --- | --- | --- |
| Success rate, latency, cost per success, stop reasons | every run (`harness_agent_runs`) | /metrics |
| Online judge grade | `ONLINE_JUDGE_SAMPLE_RATE` of runs (default 10%), graded by the eval rubric judge | /metrics, run page |
| User feedback | 👍/👎 + comment on each run page | /metrics, run page |
| Escalations | tool calls a person (or the approval timeout) denied | /metrics |
| Offline evals | nightly `evals.yml` workflow | Actions tab, /evals |

## Drift

Model updates, data changes and new kinds of request change behaviour
silently. A drop in success rate or judge pass rate with no deploy in
between is the usual sign. Check which model (`By model` table) and which
stop reason moved.

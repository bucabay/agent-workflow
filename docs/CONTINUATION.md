# AWL continuation handoff

Updated: 2026-09-26. Reviewed code baseline: `f824b3e` on `main`.

## Start here

- Active repository: `/Users/gabe/code/agent-workflow`, remote
  `https://github.com/bucabay/agent-workflow.git`.
- `/Users/gabe/code/agents/workflow` is the old location. The workflow package was
  removed from that repository after moving to the standalone repository.
- Goal: a reliable AWL reference client with pluggable backends, deterministic gates,
  and useful telemetry. A completed live sandbox run exists, but the review below
  found important unresolved defects. Do not treat the adapter as finished.
- The review made no code changes. This documentation update records the findings;
  it does not fix them. Check `git status` before starting further work.

## Landed work

| Commit | Change |
| --- | --- |
| `01261d3` | State-machine client, CLI, Claude and mock backends |
| `dff2810` | OpenCode adapter, OTel-shaped JSONL telemetry, model overrides |
| `1f55c9d` | Async prompting/polling, stuck-turn retries, permission responder changes, flat telemetry operation-name fix |
| `885bd1e` | Tool subprocesses prepend working directory to PATH; regression test |
| `f824b3e` | README note about PATH and the shell `test` builtin |

`npm test` runs schema/reference validation, regenerates diagrams, and executes six
tests: mock end-to-end, confidence fallthrough, approval, ledger cost, telemetry,
and local-command PATH resolution. All six passed during review. There are no
committed OpenCode adapter regression tests covering the findings below.

## Review backlog — repair before declaring completion

Queued for continuation as **agentq task #237**, project `agent-workflow`, lane
`runtime`, titled “Resolve AWL runtime review findings before completion”. This
single lane keeps overlapping adapter changes serialized. Scheduled agents must
claim through agentq before starting; the checklist below is not a work lock.

### 1. High: distinguish a finished step from a finished turn

**Location:** `src/awl/backends/opencode.mjs`, `sessionPrompt()` polling loop.

The loop returns on any truthy `newest.info.finish`, including `"tool-calls"`.
Sorting messages by creation time does not prevent returning between steps. The
caller may advance the workflow and delete the session while work remains.

**Reproduced during review:** a local HTTP stub returned an assistant message with
`finish: "tool-calls"` and text `"Still working"`; `ask()` returned that text as its
completed output. The stub was an inline diagnostic, not a committed test.

**Acceptance:** intermediate steps never complete the request; final completion and
assistant errors are distinguished using supported SDK/server semantics. Test a
multi-step turn, a terminal response, an error, and a delayed next step.

### 2. High: enforce read-only and explicit tool policies

**Location:** `src/awl/backends/opencode.mjs`, `toolsFor()`, constructor, responder.

The constructor defaults `enforceTools` to true, but `toolsFor(def, opts)` reads the
original `opts.enforceTools` (undefined by default) and returns an empty map.
Review's HTTP stub confirmed default `readOnly: true` sends no tools field.

Fixing the default alone does not enforce the policy: enabled-only maps do not
remove the attached server's existing tools. Auto-approved operations emit no
permission event for the responder to reject. A read-only system prompt is not a
filesystem permission boundary. The comment claiming omission of bash disables it
contradicts observed behavior and another comment in the same adapter.

**Acceptance:** use supported server-side permissions/agent configuration; test
default and explicit options and attempted writes/bash in read-only roles. Update
comments and README to describe the actual guarantees.

### 3. High: fix both shipped verification commands

**Location:** `default.workflow.json`, main `verify` and `fix_attempt` re-verification;
matching README examples and generated diagrams.

Both commands still read `lint && test && typecheck`. Bare `test` is a shell builtin;
with no arguments it returns 1 without running the repository's test script. PATH
changes do not override builtins. The current end-to-end test substitutes a counter
command and therefore misses this template defect.

**Acceptance:** replace both commands with an explicit, documented project command
contract (script paths or package-manager commands). Exercise that contract with a
failing and passing fixture, then regenerate `visual/` using `npm test`.

### 4. High: retry polling without resubmitting accepted work

**Location:** `src/awl/backends/opencode.mjs`, async/synchronous fallback and retry loop.

The transient-error catch spans submission and polling. A polling network failure
after acceptance falls through to synchronous `session.prompt()` with the same
prompt; the outer loop can also submit again. This can duplicate edits or hit a
busy session.

**Acceptance:** distinguish submission from observation; after acceptance, retry
reads without resubmitting. Test a transient polling error and count submissions.
Explicitly define cancellation before recreating sessions rather than assuming a
best-effort delete stopped all server work.

### 5. Medium: aggregate telemetry over the whole request

**Location:** `src/awl/backends/opencode.mjs` metadata extraction;
`src/awl/engine.mjs` ledger recording; `src/awl/telemetry.mjs` mapping.

Only the returned assistant message supplies tokens, cost, and duration;
`numTurns` is hardcoded to 1. Multi-step turns and retries are underrepresented.
Tool ledger entries supply an outcome but no timing/cost, and decider calls are not
separately recorded. Free-tier $0 costs do not demonstrate accounting correctness.

**Acceptance:** aggregate per-request messages without double counting, measure total
elapsed time, define retry/decision accounting, and assert totals for multiple steps.

## Live evidence and its limits

These are historical local artifacts, not repository fixtures. They may disappear
with temporary-directory cleanup. No live rerun was performed during the review.

| Run | Observed result | Local evidence |
| --- | --- | --- |
| `98d5a5bd` | Minimal one-state big-pickle run completed; output `big-pickle live OK` | `/tmp/awl-live/repo/.awl/runs/98d5a5bd.json`, `/tmp/awl-live/tel8.jsonl` |
| `850c38de` | Verification failed, then apply exhausted stuck-turn retries | `/tmp/awl-live/repo/.awl/runs/850c38de.json`, `/tmp/awl-live/tel7.jsonl` |
| `799da216` | Verification failed with `path is not defined` during an intermediate broken edit; later corrected | `/tmp/awl-live/repo/.awl/runs/799da216.json`, `/tmp/awl-live/tel9.jsonl` |
| `d013f3bf` | Full customized pipeline completed at `report`, verification exit 0, six ledger/telemetry entries | `/tmp/awl-live/repo/.awl/runs/d013f3bf.json`, `/tmp/awl-live/tel10.jsonl`, `/tmp/awl-live/run7.log` |

The successful full run followed
`explore → plan → implement → review → verify → quality_gate → report`.
Its routing confidence was 0.7, below the sidekick's 0.8 threshold, so the writer was
selected. The sandbox ended with `mul(a, b)` returning `a * b`. The workflow used
`./lint && ./runtests && ./typecheck`; lint/typecheck were no-op stubs, and runtests
executed a Python unittest. This proves that customized harness completed, not that
the unmodified default, every backend contract, or substantive lint/typechecking passed.
The report text also contained stale gate claims despite the passing deterministic
result; prefer the journal's tool output to the model's prose.

### Corrections to earlier explanations

- A server-side edit-flush race was hypothesized, not established. Do not add a sleep
  or verification retry to hide the failure without a reproducible timing defect.
- Bare `test` silently returning 1 was directly isolated. Bare `lint` without the
  sandbox PATH resolved to an unrelated Android lint executable in one diagnostic.
  The claim that every failure was `command not found`/exit 127 was incorrect.
- Adding cwd to PATH made non-builtin local scripts resolvable; it did not fix `test`.
  Explicit script paths fixed the sandbox gate.
- The adapter's unchanged-message-ID timeout is a heuristic. A long-running message
  can still be making progress; historical stalls do not prove a free-tier/server bug.

## OpenCode integration notes

- Historical endpoint: `http://127.0.0.1:4096`; model: `opencode/big-pickle`.
  Recheck health on continuation; old process IDs are not reliable.
- SDK responses use `{ data }`; `event.subscribe()` resolves to `{ stream }`.
- Async prompting was introduced to avoid long buffered synchronous responses
  hitting HTTP headers timeouts. Do not reintroduce the incompatible custom undici
  dispatcher tried during debugging.
- In the tested free-tier setup, tool maps with false values produced 403 responses;
  all-true maps were accepted but did not remove bash. Treat this as observed behavior
  of that setup, not a universal permission contract.
- Attached servers retain their existing authentication. Earlier injecting a key via
  `auth.set` disrupted that setup. Do not print credentials or repeat that experiment
  against the user's attached server. See README for current credential precedence.
- Sessions are fresh per ask. Cleanup/retry deletion is best effort; abandoned sessions
  were observed. Do not assume deletion successfully cancelled outstanding tools.

## Continuation procedure

1. Open the standalone repository, inspect status/log, and read this handoff plus the
   relevant functions. Check for newer changes before applying any old patch.
2. Run `npm test` as the baseline. Fix findings 1 and 4 together in the adapter's
   request lifecycle, with deterministic local-server tests before another live run.
3. Fix policy enforcement (2), the template gate (3), and accounting (5). Keep work
   touching `opencode.mjs` serialized; do not launch overlapping edits.
4. Re-run the tests and inspect generated diagram diffs. Update this document and
   README as each defect is actually fixed; remove limitations only after validation.
5. For live verification, first run the sandbox gate directly on known failing and
   passing code. Restore a known failing fixture before the model run. Preserve the
   journal/telemetry and compare deterministic output with the model's summary.

From the standalone repository, if the historical sandbox still exists:

```sh
npm test
node validate.mjs /tmp/awl-live/live.workflow.json
node bin/awl.mjs run /tmp/awl-live/live.workflow.json \
  --backend opencode --cwd /tmp/awl-live/repo -y --auto \
  --telemetry /tmp/awl-live/continuation.jsonl \
  --input /tmp/awl-live/input.json
```

Use a fresh telemetry filename if that one exists. `run` currently chooses its journal
directory from cwd/`AWL_RUN_DIR`; its `--dir` flag is only used by resume/status.
Resume replays tasks from the start with saved decisions/counts/outputs, so it can repeat
side effects. A fresh run is clearer evidence for a repaired lifecycle.

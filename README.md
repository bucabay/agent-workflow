# @agents/workflow — Agent Workflow Language (AWL)

AWL is an *indented, state-machine workflow DSL for agent teams*. It describes multi-agent
software tasks as JSON state machines, borrowing its execution model from the Amazon States
Language and extending it with agent routing, OTel-aligned telemetry, evidence traceability,
and cost-estimation hooks.

This package ships the schema, an evidence-based reference workflow (`agent.default`),
tooling that validates a workflow and renders it to diagrams, and a reference **client**
(`awl`) that executes workflows against a pluggable agent backend.

## Current implementation status

The reference client has six passing tests and a completed OpenCode/big-pickle sandbox
run. The OpenCode adapter still has unresolved completion, permission, retry, and
usage-accounting defects. See [the continuation handoff](docs/CONTINUATION.md) for
review findings, evidence, and the ordered repair backlog (code baseline `f824b3e`).

The default workflow is a template, not a ready-to-run verification setup: replace
both `lint && test && typecheck` commands with your project's actual commands before
running it. Bare `test` is a shell builtin and returns failure with no arguments;
use explicit script paths (such as `./lint && ./test && ./typecheck`) or package-manager
commands. Model placeholders also need overrides. The successful sandbox used a
customized workflow, not the unmodified default.

## Description

A workflow is a JSON document:

- **States** are `task`, `choice`, `parallel`, `map`, `call`, `approval`, `pass`,
  `succeed`, and `fail`. Indentation is purely visual; meaning is structural.
- **Agents** are named roles bound to a model tier (`frontier`, `cheap`, `review`) with a
  tool allowlist (`read`, `grep`, `glob`, `git`), read-only flags, and clean-context flags.
- **Agent routing** is a first-class state decision: a task can `pick-one` or `run-all`
  over named agents, each optionally gated by a `when` condition, marked `optional`
  (best-effort: skip instead of fail), and carrying per-candidate args.
- **Research-grounded decisions** attach to routing or `choice`: a `decision` block feeds
  the specific research and your guidelines to a decider — an LLM agent (`engine: "llm"`)
  or a Jev-style calibrated decision model (`engine: "jev"`) — and branches on typed
  answers (`choice`/`score`/`noul`) with confidence thresholds. The shape is
  **Jev-compatible**: `context` maps to Jev `state`, `questions` are Jev questions verbatim,
  so a Jev backend drops in as one adapter and any LLM can satisfy the same contract.
- **Delegation hierarchy** lives on agents: `sidekicks[]` names the sub-agents an agent
  owns, recursively nestable (a sidekick may have its own sidekicks).
- **Evidence** traces every design decision back to a published source and finding, so the
  workflow is auditable in the same repo that ships it.
- **Telemetry** spells out per-state GenAI metrics (OTel semantic conventions), expected
  tokens, and cost so a run can be rated (1–5) and costed from the ledger.
- **Subflows** are reusable sub-machines invoked by `parallel`/`map`/`call` states.

The default workflow (`default.workflow.json`) encodes a research-backed default pipeline:

```
explore (4 parallel cheap read-only agents)
  -> plan (frontier, writes artifacts/spec.md)
  -> implement (pick-one: sidekick for mechanical / writer for judgment)  # single writer
  -> review (independent family, clean-context diff review)
  -> verify (lint && test && typecheck)
  -> quality_gate (bounded fix loop, max 2 iterations, else replan)
  -> report (cost ledger + telemetry)
```

## Architecture

```
├── schema.json             # JSON Schema (draft 2020-12) for the AWL dialect
├── default.workflow.json   # the reference "agent.default" workflow + subflows
├── validate.mjs            # AJV validation of a workflow against schema.json
├── render.mjs              # renders a workflow -> Mermaid, JSON Canvas, SVG, HTML storyboard
├── bin/awl.mjs             # the awl CLI: validate / cost / run / resume / status
├── src/awl/                # the client: engine, decisions, backends, ledger (see below)
├── visual/                 # generated artifacts (graph.mmd/.canvas/.svg/.html)
└── docs/
    ├── RESEARCH.md         # research overview with links behind the design
    └── CONTINUATION.md     # implementation status, review findings, next steps
```

### The reference workflow, state by state

| State            | Agent / kind        | Purpose                                                      |
| ---------------- | ------------------- | ------------------------------------------------------------ |
| `explore`        | parallel, explorer  | One cheap read-only agent per scope; context-isolated fan-out |
| `plan`           | planner (frontier)  | Spec-quality brief: constraints, edge cases, definition of done |
| `implement`      | pick-one agent selector + decision | LLM/`jev` decider reads research+guidelines, routes mechanical -> sidekick, judgment -> writer, gated on `minConfidence` |
| `review`         | reviewer (independent family) | Fresh-context diff review by a model family that didn't write the code |
| `verify`         | tool                | Deterministic gates: `lint && test && typecheck`             |
| `quality_gate`   | choice + guard      | Bounded fix loop (`maxIterations: 2`) with `replan` escape hatch |
| `replan`         | planner (frontier)  | Fix cycle exhausted -> frontier re-owns design, re-enters `implement` |
| `report`         | planner (frontier)  | Final summary, per-state cost ledger, rating hook            |

Subflows: `explore_repo` (a single isolated exploration pass) and `fix_attempt`
(writer + re-verify bounded corrective pass).

### Intended design rules

These describe the reference design; enforcement depends on the backend and configured
models. In particular, the current OpenCode adapter does not enforce read-only roles.

- **Reads parallelize, writes serialise.** Exploration fans out across isolated cheap
  contexts; exactly one agent ever writes, so implicit decisions never conflict.
- **Frontier intelligence goes to judgment.** Planning, ambiguity, delegability routing,
  and final review. Volume goes to the cheap sidekick.
- **Delegate by judgment, not by policy.** The router asks *"is delegation right here?"*
  rather than always delegating. When the judgment *is* the deliverable, delegation backfires.
- **Review with clean context, different family.** The reviewer sees only the diff, not the
  author's session, and comes from another model family for cross-vendor blind-spot coverage.
- **Verification is structural, never self-eval.** Lint/tests/typecheck are the gate;
  model opinion is not.
- **Loops are bounded.** Every fix iteration is counted; exhaustion routes to a frontier replan.

## Cost estimation

`render.mjs` and `awl cost` print a per-state USD estimate from `expectedTokens` and the
per-model `usdPerMillionInput/usdPerMillionOutput` rates. `meta.estimate` declares the
budget target ($5.00 default) and whether estimates should be refit. Estimates ignore
retries, loopbacks, and cache effects.

## Client (`awl`)

A thin CLI + library that executes AWL workflows. The state machine is ours; the agent
loop is a pluggable backend.

```
bin/awl.mjs              # CLI
src/awl/
├── loader.mjs           # AJV + semantic resolution (shared with validate.mjs)
├── engine.mjs           # state-machine walker: task/choice/parallel/map/call/
│                        #   approval/pass/succeed/fail, guards, retry, selectors
├── decisions.mjs        # research-grounded decisions: llm | jev deciders
├── state.mjs            # $.path conditions + answerWhen/confidence evaluation
├── verify.mjs           # tool tasks (sh -c) + approval TTY prompt
├── telemetry.mjs        # OTel-aligned JSONL emitter (schema $.telemetry.record)
├── runstore.mjs         # run checkpoint journals (.awl/runs/<id>.json), resume
├── cli.mjs              # validate / cost / run / resume / status
└── backends/
    ├── claude.mjs       # Claude Agent SDK adapter (primary)
    ├── opencode.mjs     # @opencode-ai/sdk adapter
    └── mock.mjs         # scripted backend for tests
```

Backend mapping to the Agent SDK: read-only agents → `permissionMode: "dontAsk"` +
a mapped tool allowlist (`read/grep/glob/git` → `Read`/`Grep`/`Glob`/`Bash`); clean
context → fresh session per state; `sidekicks[]` → SDK subagent definitions; tool-call
hooks → telemetry; `total_cost_usd` → the per-state cost ledger.

The **opencode backend** (`--backend opencode`) drives `@opencode-ai/sdk` through a
fresh session per `ask()` and accepts model strings of the form `providerID/modelID`.
It tries to attach to a local server (default `127.0.0.1:4096`) before spawning one.
Attached servers keep their existing credentials; the adapter skips `auth.set` on them.
For a spawned server, it uses the backend's `apiKey` option or `AWL_OPENCODE_API_KEY`;
the CLI currently passes `ANTHROPIC_API_KEY` as that option, which takes precedence.

Turns use `promptAsync` plus message polling, with a synchronous fallback. The adapter
recreates a session after 120 seconds without a new assistant message, with up to two
stuck-turn retries and a no-bash prompt hint. This is a heuristic, not proof a tool hung.
Read-only roles receive a prompt instruction, but write/bash/edit tools are **not
reliably disabled**: the default tool-map option is miswired, enabled-only maps do not
remove the server's existing tools, and auto-approved actions bypass the responder.
The poller also currently accepts intermediate `finish: "tool-calls"` messages as
completion. See the handoff before relying on these contracts.

```sh
npm i
export ANTHROPIC_API_KEY=...

node bin/awl.mjs validate default.workflow.json   # schema + reference check
node bin/awl.mjs cost    default.workflow.json    # per-state estimate
# First customize wf.json: real model IDs and project-specific verification commands.
node bin/awl.mjs run     wf.json --input input.json -y --auto
node bin/awl.mjs status                           # persisted runs
node bin/awl.mjs resume  <runId>                  # re-run reusing decisions/loop counts
AWL_BACKEND=mock node bin/awl.mjs run wf.json       # LLM calls mocked; tool commands still execute
node bin/awl.mjs run wf.json --backend opencode               # opencode backend
```

`--model-override key=model-id` swaps `workflow.models[key].model` before a run, so
placeholder model ids (e.g. `<frontier-model>`) can be filled per invocation.
`--telemetry <file>` (or `$AWL_TELEMETRY`) appends one OTel-shaped JSONL line per ledger
entry, mapped from the workflow's `$.telemetry.record` — `gen_ai.operation.name`,
`gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.{input,output,cache_read.input}_tokens`,
plus `durationMs`, `attempts`, `loops`, `outcome`, `costUsd`.
Only fields available in the ledger entry are emitted. Tool entries currently supply
an outcome but no duration or cost; OpenCode usage/cost/duration cover only the returned
assistant message, not the entire multi-step turn. Decider calls are not separately
recorded in the ledger, so ledger cost is not a complete bill for a run.

- **Verification is real**: `tool` states run the shell command (`lint && test && typecheck`)
  as the deterministic gate; the model never self-evaluates. The command runs via `sh -c` with
  the run's `cwd` on `PATH`, so a repo-local script (`lint`, `typecheck`, …) resolves by name.
  Note `test` is a POSIX shell builtin, so prefer `./test` (or a non-builtin name) for a test script.
- **Decisions are first-class**: an LLM decider answers the Jev-shaped questions from
  `research` + `guidelines` + folded state; `engine: "jev"` posts the same body to
  `$AWL_JEV_URL`. Branches route on answers with confidence floors.
- **Loops are bounded**: guard counters feed the ledger; exhaustion routes to
  `exhaustNext` (and a hard `AWL_MAX_REPLANS=10` cap prevents infinite replan loops).
- **Resume reuses decisions**: persisted runs replay from the start with stored decision
  answers, guard counts, and outputs. Tasks execute again, so this is not an exact replay
  or a mid-flight continuation and can repeat side effects.

Caveats: `parallel`/`map`/`call` subflows write into the shared run ledger; a subflow
state targeting a main-scope state ends the subflow (the caller follows its own `next`);
`resume` replays from the start rather than a mid-flight session.

## Usage

```sh
# validate the default workflow against schema.json
npm test

# render any workflow to visual/ (Mermaid, JSON Canvas, SVG, self-contained HTML)
npm run render
node render.mjs path/to/custom.workflow.json
```

## Research overview

The design is derived from the sources cited inline in `default.workflow.json` — a
Cognition/Anthropic/LangChain study of what actually works in multi-agent systems, plus
Co-Coder (parallelism vs. communication cost) and OpenTelemetry GenAI conventions. The
annotated overview with links lives in [docs/RESEARCH.md](docs/RESEARCH.md).

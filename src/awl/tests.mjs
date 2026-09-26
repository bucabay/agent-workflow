import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadWorkflow } from './loader.mjs';
import { resolveBackend } from './backends/index.mjs';
import { runWorkflow } from './engine.mjs';
import { newRun } from './runstore.mjs';
import { makeTelemetryEmitter, telemetryRecord } from './telemetry.mjs';
import { runToolState } from './verify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'awl-test-'));

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok ${name}`); };

const COUNTER = `node -e "const fs=require('fs'),p='awl-counter';let n=0;try{n=+fs.readFileSync(p)}catch{};fs.writeFileSync(p,String(n+1));process.exit(n<2?1:0)"`;

// ---------- test 1: full default.workflow.json with a scripted backend ----------
async function testDefault() {
  const cwd = tmp();
  const wfPath = join(__dirname, '..', '..', 'default.workflow.json');
  const { workflow } = await loadWorkflow(wfPath, join(__dirname, '..', '..', 'schema.json'));
  workflow.states.verify.run.command = COUNTER;
  for (const st of Object.values(workflow.subflows.fix_attempt.states)) {
    if (st.kind === 'tool') st.run.command = COUNTER;
  }
  const backend = await resolveBackend('mock', {
    mockScript: {
      outputsByAgent: {
        explorer: JSON.stringify({ paths: ['api/routes', 'ui/Components'], snippets: '' }),
        planner: 'spec: { goal: "x", outcomes: ["a"] }. delegation verdict: mechanical.',
        writer: 'implemented: api and ui changes',
        sidekick: 'sidekick applied the spec exactly',
        reviewer: 'review: 0 critical, 2 minor',
      },
      decide: () => ({ delegability: { answer: 'mechanical', confidence: 0.9 } }),
    },
  });
  const run = newRun({ workflow, workflowPath: wfPath, cwd, input: { task: 't' } });
  await runWorkflow({ workflow, backend, input: { task: 't' }, cwd, run });
  assert(run.completed, 'default workflow should complete');
  assert.strictEqual(run.finalState, 'report');
  assert.deepStrictEqual(run.outputs.implement.agents, ['sidekick'], 'mechanical+conf0.9 routes to sidekick');
  assert(run.outputs['explore.branches']?.length === 4, 'parallel fan-out ran 4 branches');
  assert(run.guardCounts.quality_gate <= 1, 'guard reset after replan (final cycle fresh)');
  const kinds = new Set(run.ledger.map((e) => e.kind));
  assert(kinds.has('parallel') && kinds.has('call'), 'ledger covers parallel + call');
  rmSync(cwd, { recursive: true, force: true });
  ok('default.workflow.json end-to-end (mock)');
}

// ---------- test 2: minConfidence gate falls through to the default candidate ----------
function miniWorkflow() {
  return {
    format: 'awl', version: '1.0.0', name: 'mini.route',
    models: {
      frontier: { provider: 'p', model: 'frontier-model', usdPerMillionInput: 5, usdPerMillionOutput: 25 },
      cheap: { provider: 'p', model: 'cheap-model', usdPerMillionInput: 0.25, usdPerMillionOutput: 2 },
    },
    agents: {
      planner: { model: 'frontier' },
      sidekick: { model: 'cheap', optional: true },
      writer: { model: 'frontier' },
    },
    start: 'route',
    states: {
      route: {
        type: 'task', kind: 'llm',
        agents: {
          mode: 'pick-one', pick: 'first',
          decision: {
            decider: { engine: 'llm', agent: 'planner' },
            context: { research: [], guidelines: ['single writer'], input: '$.task' },
            questions: { delegability: { type: 'choice', instructions: 'is it mechanical?', criteria: { mechanical: 'yes', judgment: 'no' } } },
          },
          candidates: [
            { agent: 'sidekick', optional: true, when: { question: 'delegability', equals: 'mechanical', minConfidence: 0.8 } },
            { agent: 'writer' },
          ],
        },
        next: 'done',
      },
      done: { type: 'task', kind: 'llm', agent: 'writer', end: true },
    },
  };
}

async function testConfidenceFallthrough() {
  const cwd = tmp();
  const workflow = miniWorkflow();
  const backend = await resolveBackend('mock', {
    mockScript: { outputsByAgent: { planner: 'plan', writer: 'wrote', sidekick: 'sidekick out' }, decide: () => ({ delegability: { answer: 'judgment', confidence: 0.5 } }) },
  });
  const run = newRun({ workflow, workflowPath: 'mini', cwd, input: { task: 't' } });
  await runWorkflow({ workflow, backend, input: { task: 't' }, cwd, run });
  assert(run.completed);
  assert.deepStrictEqual(run.outputs.route.agents, ['writer'], 'low-confidence answer falls through to writer');
  rmSync(cwd, { recursive: true, force: true });
  ok('minConfidence fallthrough picks writer');
}

// ---------- test 3: approval auto-accept ----------
async function testApproval() {
  const cwd = tmp();
  const workflow = miniWorkflowWithApproval();
  const backend = await resolveBackend('mock', { mockScript: { output: 'done' } });
  const run = newRun({ workflow, workflowPath: 'mini', cwd, input: {} });
  await runWorkflow({ workflow, backend, input: {}, cwd, run, yes: true });
  assert(run.completed);
  assert(run.ledger.some((e) => e.kind === 'approval' && e.outcome === 'approved'));
  rmSync(cwd, { recursive: true, force: true });
  ok('approval auto-accepted with -y');
}

function miniWorkflowWithApproval() {
  return {
    format: 'awl', version: '1.0.0', name: 'mini.approval',
    models: { m: { provider: 'p', model: 'm', usdPerMillionInput: 1, usdPerMillionOutput: 2 } },
    agents: { a: { model: 'm' } },
    start: 'g',
    states: {
      g: { type: 'approval', prompt: 'continue?', nextOnApprove: 'finish', nextOnReject: 'done' },
      finish: { type: 'task', kind: 'llm', agent: 'a', next: 'done' },
      done: { type: 'succeed' },
    },
  };
}

// ---------- test 4: cost estimator over the default workflow ----------
async function testCost() {
  const { workflow } = await loadWorkflow(join(__dirname, '..', '..', 'default.workflow.json'), join(__dirname, '..', '..', 'schema.json'));
  const { totalCost } = await import('./cli.mjs');
  const run = { ledger: [{ costUsd: 0.1 }, { costUsd: 0.2 }] };
  assert(Math.abs(totalCost(run) - 0.3) < 1e-9, 'totalCost sums ledger');
  ok('totalCost sums ledger');
}

// ---------- test 5: telemetry emitter writes OTel-aligned records ----------
async function testTelemetry() {
  const dir = tmp();
  const file = join(dir, 'runs.jsonl');
  const workflow = {
    name: 'mini.telemetry',
    telemetry: {
      operationName: 'chat',
      record: [
        'gen_ai.usage.input_tokens',
        'gen_ai.usage.output_tokens',
        'gen_ai.usage.cache_read.input_tokens',
        'gen_ai.provider.name',
        'gen_ai.request.model',
        'durationMs',
        'outcome',
        'costUsd',
      ],
    },
  };
  const emitter = makeTelemetryEmitter({ path: file, workflow, runId: 'run-01' });
  emitter.emit({
    kind: 'llm', state: 'write', run: 'run-01', workflow: 'mini.telemetry',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
    provider: 'anthropic', model: 'claude-x', durationMs: 5, attempt: 1, loops: 0, outcome: 'ok', costUsd: 0.004,
  });
  emitter.close();
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(emitter.count(), 1, 'one record written');
  assert.strictEqual(lines.length, 1, 'single JSONL line');
  const rec = JSON.parse(lines[0]);
  assert.strictEqual(rec['gen_ai.usage.input_tokens'], 100);
  assert.strictEqual(rec['gen_ai.usage.output_tokens'], 50);
  assert.strictEqual(rec['gen_ai.usage.cache_read.input_tokens'], 20);
  assert.strictEqual(rec['gen_ai.provider.name'], 'anthropic');
  assert.strictEqual(rec['gen_ai.request.model'], 'claude-x');
  assert.strictEqual(rec['gen_ai.operation.name'], 'chat');
  assert.strictEqual(rec.outcome, 'ok');
  assert.strictEqual(rec.state, 'write');
  // fields not in workflow.telemetry.record are absent
  assert.ok(!('numTurns' in rec), 'record is restricted to telemetry.record list');
  // non-llm kinds map to their own operation name and must not crash
  const toolRec = telemetryRecord({
    kind: 'tool', state: 'verify', run: 'run-01', workflow: 'mini.telemetry',
    durationMs: 2, attempts: 1, loops: 1, outcome: 'ok', costUsd: 0,
  }, workflow.telemetry);
  assert.strictEqual(toolRec['gen_ai.operation.name'], 'run_command');
  rmSync(dir, { recursive: true, force: true });
  ok('telemetry emitter writes gen_ai.* JSONL');
}

// ---------- test 6: verify tool puts cwd on PATH ----------
async function testVerifyPath() {
  const dir = tmp();
  writeFileSync(join(dir, 'mycheck'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // bare `mycheck` (not a shell builtin like `test`) must resolve via cwd-on-PATH
  const pass = await runToolState({ run: { command: 'mycheck' } }, null, dir);
  assert.strictEqual(pass.passed, true, 'bare command resolved from cwd on PATH');
  writeFileSync(join(dir, 'mycheck'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const fail = await runToolState({ run: { command: 'mycheck' } }, null, dir);
  assert.strictEqual(fail.passed, false, 'failing command reported as not passed');
  rmSync(dir, { recursive: true, force: true });
  ok('verify tool prepends cwd to PATH for bare commands');
}

console.log('awl engine tests');
await testDefault();
await testConfidenceFallthrough();
await testApproval();
await testCost();
await testTelemetry();
await testVerifyPath();
console.log(`\n${passed} passing`);
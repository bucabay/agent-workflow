import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkflow } from './loader.mjs';
import { resolveBackend } from './backends/index.mjs';
import { runWorkflow } from './engine.mjs';
import { runDir, newRun, saveRun, loadRun, listRuns } from './runstore.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WORKFLOW = resolve(__dirname, '..', '..', 'default.workflow.json');
export const DEFAULT_SCHEMA = resolve(__dirname, '..', '..', 'schema.json');

const USAGE = `usage: awl <command> [workflow.json] [options]

commands:
  validate <wf>            validate a workflow (schema + semantic resolution)
  cost <wf>                estimated cost per state from expectedTokens + model prices
  run <wf> [--input f]     execute the workflow (backend from $AWL_BACKEND or 'claude')
  resume <runId>           re-run a persisted run, reusing decisions/loop counts
  status [--dir d]         list persisted runs

options:
  --backend <claude|mock>  execution backend (env AWL_BACKEND overrides default)
  --cwd <dir>              working directory for the run (default: .)
  --input <file.json>      run input folded into workflow state ($.task, ...)
  -y, --yes                auto-approve approval states
  --auto                   writers run with acceptEdits (unattended edits)
  --dangerous              writers run with bypassPermissions (use with care)
`;

export async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const cmd = args.shift();
  const flag = (names) => {
    for (const n of names) {
      const i = args.indexOf(n);
      if (i >= 0) { args.splice(i, 1); return true; }
    }
    return false;
  };
  const value = (names, fallback) => {
    for (const n of names) {
      const i = args.indexOf(n);
      if (i >= 0 && args[i + 1]) { const v = args[i + 1]; args.splice(i, 2); return v; }
    }
    return fallback;
  };
  const yes = flag(['-y', '--yes']);
  const auto = flag(['--auto']);
  const dangerous = flag(['--dangerous']);
  const backendName = value(['--backend'], process.env.AWL_BACKEND);
  const cwd = value(['--cwd'], process.cwd());
  const inputFile = value(['--input'], null);
  const dirFlag = value(['--dir'], null);

  switch (cmd) {
    case 'validate': {
      const wfPath = resolve(args.shift() || DEFAULT_WORKFLOW);
      const { ok, schemaErrors, refErrors } = await loadWorkflow(wfPath, DEFAULT_SCHEMA, { silent: false });
      process.exitCode = ok ? 0 : 1;
      return { ok, schemaErrors, refErrors };
    }
    case 'cost': {
      const wfPath = resolve(args.shift() || DEFAULT_WORKFLOW);
      const { workflow } = await loadWorkflow(wfPath, DEFAULT_SCHEMA);
      return printCost(workflow);
    }
    case 'run': {
      const wfPath = resolve(args.shift() || DEFAULT_WORKFLOW);
      const input = inputFile ? JSON.parse(readFileSync(inputFile, 'utf8')) : {};
      const { workflow } = await loadWorkflow(wfPath, DEFAULT_SCHEMA, { silent: false });
      const backend = await resolveBackend(backendName, { auto, dangerous });
      const dir = runDir(cwd);
      mkdirSync(dir, { recursive: true });
      let run = newRun({ workflow, workflowPath: wfPath, cwd, input, runDir: dir });
      saveRun(run, dir);
      const live = run;
      process.stdout.write(`run ${live.id} on ${workflow.name} (backend ${backend.name})\n`);
      try {
        await runWorkflow({ workflow, backend, input, cwd, run: live, yes, onEvent: progressEvents(process.stdout) });
        console.log(`\ncompleted -> ${live.finalState}  cost $${totalCost(live).toFixed(4)}  ` +
          `states ${live.ledger.length}  ${live.completed ? 'OK' : 'FAIL'}`);
        saveRun(live, dir);
        return live;
      } catch (err) {
        live.error = String(err.message);
        saveRun(live, dir);
        throw err;
      }
    }
    case 'resume': {
      const id = args.shift();
      if (!id) { console.error('resume needs a run id'); process.exit(1); }
      const dir = dirFlag ? resolve(dirFlag) : runDir(cwd);
      const prev = loadRun(id, dir);
      const { workflow } = await loadWorkflow(prev.workflowPath, DEFAULT_SCHEMA);
      const backend = await resolveBackend(backendName, { auto, dangerous });
      prev.startTime = Date.now();
      prev.error = null;
      prev.currentState = null;
      saveRun(prev, dir);
      process.stdout.write(`resume run ${id} on ${workflow.name} (${prev.ledger.length} states already on the ledger)\n`);
      try {
        await runWorkflow({ workflow, backend, input: prev.input, cwd: prev.cwd, run: prev, yes, onEvent: progressEvents(process.stdout) });
        console.log(`\ncompleted -> ${prev.finalState}  cost $${totalCost(prev).toFixed(4)}`);
        saveRun(prev, dir);
        return prev;
      } catch (err) {
        prev.error = String(err.message);
        saveRun(prev, dir);
        throw err;
      }
    }
    case 'status': {
      const dir = dirFlag ? resolve(dirFlag) : runDir(cwd);
      mkdirSync(dir, { recursive: true });
      const runs = listRuns(dir);
      if (!runs.length) { console.log('runs: none'); return []; }
      for (const r of runs) {
        const t = new Date(r.startTime || r.endTime).toISOString().slice(0, 19);
        console.log(`${r.id}  ${(r.completed ? 'done' : r.error ? 'error' : 'open').padEnd(6)}  ${r.workflowName}  ${t}  $${totalCost(r).toFixed(4)}  final=${r.finalState || '-'}`);
      }
      return runs;
    }
    case 'help':
    case '-h':
    case '--help':
      console.log(USAGE);
      return null;
    default:
      console.error(`unknown command '${cmd || ''}'`);
      console.error(USAGE);
      process.exit(2);
  }
}

function printCost(workflow) {
  const models = workflow.models || {};
  const subflows = workflow.subflows || {};
  const agents = workflow.agents || {};
  const agentNames = (s) => s.agent ? [s.agent] : (s.agents ? s.agents.candidates.map((c) => c.agent) : []);
  const costOfTokens = (s, m) => {
    const t = s.expectedTokens; if (!t || !m || m.usdPerMillionInput == null) return null;
    return (t.input * m.usdPerMillionInput + t.output * m.usdPerMillionOutput) / 1e6;
  };
  const cost = (s) => {
    if (s.type === 'call' && s.flow && subflows[s.flow]) {
      return Object.values(subflows[s.flow].states).reduce((a, st) => a + (costOfTokens(st, models[agents[st.agent]?.model]) ?? 0), 0);
    }
    if (s.type === 'parallel' && s.branches) {
      let sum = 0;
      for (const b of s.branches) {
        const m = subflows[b.flow];
        if (m) for (const st of Object.values(m.states)) sum += costOfTokens(st, models[agents[st.agent]?.model]) ?? 0;
      }
      return sum;
    }
    const keys = [...new Set(agentNames(s))];
    if (!keys.length) return costOfTokens(s, models.frontier);
    const v = keys.map((k) => costOfTokens(s, models[agents[k]?.model])).filter((x) => x != null);
    if (!v.length) return null;
    return s.agents && s.agents.mode === 'run-all' ? v.reduce((a, b) => a + b, 0) : Math.max(...v);
  };
  let total = 0;
  console.log('\nworkflow summary (estimate)');
  for (const [id, s] of Object.entries(workflow.states || {})) {
    const c = cost(s) ?? 0; total += c;
    console.log(`  ${(id + ':').padEnd(22)} ${(s.type + (s.kind ? ':' + s.kind : '')).padEnd(16)} est $${c.toFixed(4)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(22)} est $${total.toFixed(4)}  (ignoring retries/loops/cache)`);
  return total;
}

export function totalCost(run) {
  return (run.ledger || []).reduce((a, e) => a + (e.costUsd || 0), 0);
}

const progressEvents = (stream) => (e) => {
  if (e.kind === 'state') stream.write(`  ${'[' + e.state + ']'}`.padEnd(36) + `${e.type}\n`);
  else if (e.kind === 'decision') stream.write(`  decision ${e.state}: ${JSON.stringify(e.answers).slice(0, 120)}...\n`);
  else if (e.kind === 'guard-exhausted') stream.write(`  guard ${e.state} exhausted -> ${e.to}\n`);
  else if (e.kind === 'retry-exhausted') stream.write(`  retry ${e.state} exhausted -> ${e.to}\n`);
};
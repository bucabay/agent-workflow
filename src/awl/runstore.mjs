import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function runDir(cwd, env = process.env) {
  return env.AWL_RUN_DIR || join(cwd, '.awl', 'runs');
}

export function newRun({ workflow, workflowPath, cwd, input, runDir: dir }) {
  return {
    id: randomUUID().slice(0, 8),
    workflowPath,
    workflowName: workflow.name,
    version: workflow.version,
    cwd,
    input,
    startTime: Date.now(),
    endTime: null,
    outputs: {},
    ledger: [],
    guardCounts: {},
    decisionAnswers: {},
    currentState: null,
    scope: null,
    completed: false,
    finalState: null,
    error: null,
  };
}

export function saveRun(run, dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${run.id}.json`), JSON.stringify(run, null, 2));
  return run.id;
}

export function loadRun(id, dir) {
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) throw new Error(`no such run '${id}' in ${dir}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function listRuns(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try {
      return JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch {
      return null;
    }
  }).filter(Boolean).sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
}
import { openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const FIELD = {
  'gen_ai.usage.input_tokens': (e) => e.usage?.input_tokens,
  'gen_ai.usage.output_tokens': (e) => e.usage?.output_tokens,
  'gen_ai.usage.cache_read.input_tokens': (e) => e.usage?.cache_read_input_tokens,
  'gen_ai.provider.name': (e) => e.provider,
  'gen_ai.request.model': (e) => e.model,
  'gen_ai.operation.name': (e) => e.operationName,
  durationMs: (e) => e.durationMs,
  attempts: (e) => e.attempt,
  loops: (e) => e.loops,
  outcome: (e) => e.outcome,
  costUsd: (e) => e.costUsd,
};

export function telemetryRecord(entry, telemetry) {
  const rec = { run: entry.run, workflow: entry.workflow, state: entry.state };
  switch (entry.kind) {
    case 'llm': rec['gen_ai.operation.name'] = telemetry?.operationName ?? 'chat'; break;
    case 'tool': rec.gen_ai.operation.name = 'run_command'; break;
    case 'approval': rec.gen_ai.operation.name = 'human_approval'; break;
    case 'parallel': rec.gen_ai.operation.name = 'parallel_fanout'; break;
    case 'call': rec.gen_ai.operation.name = 'subflow'; break;
  }
  const want = telemetry?.record || ['durationMs', 'outcome'];
  for (const f of want) {
    const v = FIELD[f]?.(entry);
    if (v !== undefined) rec[f] = v;
  }
  return rec;
}

export function makeTelemetryEmitter({ path, workflow, runId, onLine = () => {} }) {
  let fd = null;
  if (path) {
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(path, 'a');
  }
  let count = 0;
  return {
    path,
    count: () => count,
    emit(entry) {
      if (!['llm', 'tool', 'approval', 'parallel', 'call'].includes(entry.kind)) return;
      const line = JSON.stringify(telemetryRecord(entry, workflow.telemetry));
      onLine(line);
      if (fd != null) {
        writeSync(fd, line + '\n');
        count++;
      }
    },
    close() {
      if (fd != null) { closeSync(fd); fd = null; }
    },
    id: runId,
  };
}
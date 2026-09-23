import { answerDecision } from './decisions.mjs';
import { evalWhen, getPath } from './state.mjs';
import { runToolState, approve } from './verify.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_EXHAUSTED = Symbol('retry-exhausted');

export class WorkflowError extends Error {}

export async function runWorkflow({ workflow, backend, input = {}, cwd, run, yes = false, onEvent = () => {} }) {
  const subflows = workflow.subflows || {};
  const mainStates = workflow.states || {};
  const events = (kind, payload) => onEvent({ kind, ...payload });

  const dataOf = (r) => Object.assign({}, r.outputs, r.input || {});
  const record = (r, e) => { r.ledger.push(e); events('ledger', e); };

  const resolveModelName = (def) => {
    const m = workflow.models?.[def.model];
    return m && typeof m.model === 'string' ? m.model : (typeof def.model === 'string' ? def.model : undefined);
  };
  const sidekickDefs = (def) => {
    if (!def.sidekicks) return undefined;
    const out = {};
    for (const name of def.sidekicks) {
      const sd = workflow.agents?.[name];
      if (sd) out[name] = { ...sd, model: resolveModelName(sd) };
    }
    return out;
  };

  const runAgent = async (r, stateId, s, agentName) => {
    const def = workflow.agents[agentName];
    if (!def) throw new WorkflowError(`state ${stateId}: unknown agent '${agentName}'`);
    const containers = [s.context?.input, s.agents?.decision?.context?.input];
    const imap = {};
    for (const c of containers) {
      if (!c) continue;
      for (const p of Array.isArray(c) ? c : [c]) imap[p] = getPath(dataOf(r), p);
    }
    const prompt = [
      s.prompt || def.prompt || '',
      Object.values(imap).some((v) => v !== undefined) ? 'Context:\n' + JSON.stringify(imap, null, 2) : '',
    ].filter(Boolean).join('\n\n');
    const attempts = s.retry?.maxAttempts ?? 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const t0 = Date.now();
      try {
        const res = await backend.ask({
          prompt,
          def: { ...def, model: resolveModelName(def) },
          model: workflow.models?.[def.model],
          cwd,
          agentName,
          state: dataOf(r),
          sidekickDefs: sidekickDefs(def),
        });
        record(r, {
          state: stateId, kind: 'llm', agent: agentName, attempt,
          costUsd: res.metadata?.costUsd ?? 0,
          durationMs: res.metadata?.durationMs ?? Date.now() - t0,
          numTurns: res.metadata?.numTurns ?? 0,
          outcome: 'ok',
        });
        return res.output;
      } catch (err) {
        record(r, { state: stateId, kind: 'llm', agent: agentName, attempt, outcome: 'error', error: String(err.message) });
        if (attempt < attempts) { await sleep(s.retry?.backoffMs ?? 1000); continue; }
        if (s.retry?.onExhaust) return RETRY_EXHAUSTED;
        throw err;
      }
    }
    throw new WorkflowError(`state ${stateId}: unreachable retry`);
  };

  const decide = async (r, stateId, decision) => {
    if (run.decisionAnswers[stateId] || !decision) return run.decisionAnswers[stateId];
    const ans = await answerDecision({ decision, state: { data: dataOf(r) }, workflow, backend });
    run.decisionAnswers[stateId] = ans;
    events('decision', { state: stateId, answers: ans });
    return ans;
  };

  const runSelector = async (r, stateId, s) => {
    const decisionAnswers = await decide(r, stateId, s.agents?.decision);
    const ctx = { data: dataOf(r), decisionAnswers };
    if (s.agents.mode === 'run-all') {
      const picked = s.agents.candidates.filter((c) => !c.when || evalWhen(c.when, ctx));
      if (!picked.length) return { skipped: !!s.optional, empty: !s.optional };
      const outputs = [];
      for (const c of picked) outputs.push(await runAgent(r, stateId, s, c.agent));
      return { outputs, agents: picked.map((c) => c.agent) };
    }
    const eligible = s.agents.candidates.filter((c) => !c.when || evalWhen(c.when, ctx));
    if (!eligible.length) {
      const skippable = s.optional || s.agents.candidates.some((c) => c.optional);
      return { skipped: skippable, empty: !skippable };
    }
    if (s.agents.pick === 'cheapest') {
      const priced = eligible.map((c) => ({ c, p: priceOf(c.agent) })).sort((a, b) => a.p - b.p);
      const output = await runAgent(r, stateId, s, priced[0].c.agent);
      return { outputs: [output], agents: [priced[0].c.agent] };
    }
    const output = await runAgent(r, stateId, s, eligible[0].agent);
    return { outputs: [output], agents: [eligible[0].agent] };
  };

  const priceOf = (agentName) => {
    const def = workflow.agents?.[agentName];
    const m = def && workflow.models?.[def.model];
    return (m?.usdPerMillionInput ?? 0) + (m?.usdPerMillionOutput ?? 0);
  };

  const runSubflow = async (r, flow, args) => {
    const m = subflows[flow];
    if (!m) throw new WorkflowError(`unknown subflow '${flow}'`);
    if (args) r.input = { ...(r.input || {}), ...args };
    return walk(m, r, { root: false });
  };

  // One walker for main machines and subflows. Subflow scope = machine has no
  // `root`. A next targeting a main state from inside a subflow escapes the
  // subflow (`escape`); the caller drops it and follows the caller's own next.
  async function walk(machine, r, { root }) {
    let id = machine.start;
    let steps = 0;
    while (steps++ < 100000) {
      const s = machine.states[id];
      if (!s) throw new WorkflowError(`state '${id}' not found`);
      events('state', { state: id, type: s.type, root });
      r.currentState = id;

      let exhausted = false;
      if (s.guard) {
        r.guardCounts[id] = (r.guardCounts[id] || 0) + 1;
        if (r.guardCounts[id] > s.guard.maxIterations) {
          exhausted = true;
          r.guardCounts[id] = 0;
          r.loopExhaustions = (r.loopExhaustions || 0) + 1;
          const cap = Number(process.env.AWL_MAX_REPLANS ?? 10);
          if (r.loopExhaustions > cap) throw new WorkflowError(`state ${id}: replan loop exceeded ${cap} cycles (set AWL_MAX_REPLANS) — verify keeps failing`);
          events('guard-exhausted', { state: id, to: s.guard.exhaustNext });
          if (!s.guard.exhaustNext) throw new WorkflowError(`state ${id}: guard exhausted but no exhaustNext`);
        }
      }

      let next;
      let ended = false;
      let success = true;

      switch (s.type) {
        case 'task': {
          if (s.kind === 'tool') {
            const out = await runToolState(s, dataOf(r), cwd);
            r.outputs[id] = out;
            record(r, { state: id, kind: 'tool', outcome: out.passed ? 'pass' : 'fail' });
            if (s.end) { ended = true; break; }
            next = out.passed ? s.next : (s.onFail || s.next);
            break;
          }
          if (s.agent) {
            const output = await runAgent(r, id, s, s.agent);
            if (output === RETRY_EXHAUSTED) { next = s.retry.onExhaust; break; }
            r.outputs[id] = { output };
          } else if (s.agents) {
            const sel = await runSelector(r, id, s);
            if (sel.skipped) { record(r, { state: id, kind: 'llm', outcome: 'skipped' }); if (s.end) { ended = true; break; } next = s.next; break; }
            if (sel.empty) throw new WorkflowError(`state ${id}: agent selector yielded no candidate`);
            r.outputs[id] = { output: sel.outputs.join('\n\n'), agents: sel.agents };
          } else {
            throw new WorkflowError(`state ${id}: llm task needs 'agent' or 'agents'`);
          }
          if (s.end) { ended = true; break; }
          next = s.next;
          break;
        }
        case 'choice': {
          if (exhausted) { next = s.guard.exhaustNext; break; }
          const decisionAnswers = run.decisionAnswers[id] || await decide(r, id, s.decision) || {};
          if (s.decision) run.decisionAnswers[id] = decisionAnswers;
          const ctx = { state: dataOf(r), decisionAnswers };
          const hit = s.branches.find((b) => evalWhen(b.when, ctx));
          next = hit ? hit.next : s.default;
          if (!next) throw new WorkflowError(`state ${id}: no branch matched and no default`);
          break;
        }
        case 'approval': {
          const a = await approve(s, { yes });
          r.outputs[id] = a;
          record(r, { state: id, kind: 'approval', outcome: a.approved ? 'approved' : 'rejected' });
          if (s.end) { ended = true; break; }
          next = a.approved ? s.nextOnApprove : (s.nextOnReject || s.next);
          break;
        }
        case 'pass': {
          if (s.assign) for (const [k, v] of Object.entries(s.assign)) r.outputs[id] = { ...(r.outputs[id] || {}), [k]: v };
          if (s.end) { ended = true; break; }
          next = s.next;
          break;
        }
        case 'succeed':
          ended = true; success = true; break;
        case 'fail':
          if (s.end) { ended = true; success = false; }
          else next = s.next;
          break;
        case 'parallel': {
          const jobs = s.branches.map((b) => runSubflow(r, b.flow, b.args).then((out) => ({ label: b.label, flow: b.flow, finalState: out.finalState })));
          let results;
          if (s.completion === 'any') {
            const first = await Promise.race(jobs.map((p) => p.catch((e) => ({ error: e.message }))));
            results = [first];
          } else {
            results = await Promise.all(jobs.map((p) => p.catch((e) => ({ label: '?', error: e.message }))));
            const bad = results.find((x) => x.error);
            if (bad) throw new WorkflowError(`parallel state ${id}: branch failed: ${bad.error}`);
          }
          r.outputs[`${id}.branches`] = results;
          record(r, { state: id, kind: 'parallel', outcome: 'ok' });
          if (s.end) { ended = true; break; }
          next = s.next;
          break;
        }
        case 'map': {
          const items = getPath(dataOf(r), (s.items && s.items.path) || '');
          if (!Array.isArray(items)) throw new WorkflowError(`map state ${id}: items.path did not resolve to an array`);
          const conc = s.concurrency || items.length || 1;
          const results = [];
          let idx = 0;
          const worker = async () => {
            while (idx < items.length) {
              const i = idx++;
              const res = await runSubflow(r, s.flow, { ...(s.args || {}), item: items[i], index: i });
              results.push({ index: i, item: items[i], finalState: res.finalState });
            }
          };
          await Promise.all(Array.from({ length: Math.min(conc, items.length) }, worker));
          r.outputs[id] = { items: results };
          if (s.end) { ended = true; break; }
          next = s.next;
          break;
        }
        case 'call': {
          const res = await runSubflow(r, s.flow, s.args);
          r.outputs[id] = { flow: s.flow, finalState: res.finalState };
          record(r, { state: id, kind: 'call', outcome: 'ok' });
          if (s.end) { ended = true; break; }
          next = s.next;
          break;
        }
        default:
          throw new WorkflowError(`state ${id}: unsupported type '${s.type}'`);
      }

      if (ended) {
        r.finalState = id;
        return { end: true, success };
      }
      if (!next) throw new WorkflowError(`state ${id}: no transition`);
      if (!root && next in mainStates && !(next in machine.states)) {
        return { end: true, escapesScopeReference: id, success };
      }
      id = next;
    }
    throw new WorkflowError('walk bounded at 100000 steps');
  }

  const main = await walk({ start: workflow.start, states: mainStates }, run, { root: true });
  run.completed = main.success !== false;
  run.endTime = Date.now();
  events('run-end', { completed: run.completed, finalState: run.finalState });
  return run;
}
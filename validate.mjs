import { readFileSync } from 'node:fs';

const schema = JSON.parse(readFileSync('schema.json', 'utf8'));
const wf = JSON.parse(readFileSync('default.workflow.json', 'utf8'));

const { Ajv2020 } = await import('ajv/dist/2020.js');
const addFormats = (await import('ajv-formats')).default;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema, 'awl');
const validate = ajv.compile({ $ref: 'awl' });
const ok = validate(wf);
console.log(ok ? 'VALID' : 'INVALID: ' + validate.errors.length + ' errors');
if (!ok) {
  const seen = new Set();
  for (const e of validate.errors) {
    const key = e.instancePath + '|' + e.message + '|' + (e.params?.unevaluatedProperty ?? e.params?.allowedValue ?? '');
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(` - [${e.schemaPath}] ${e.instancePath || '#'} :: ${e.message} ${e.params?.unevaluatedProperty ?? ''}`);
  }
  process.exitCode = 1;
}

// ---- semantic resolution: every reference must actually exist -----------------
const resolve = (wf) => {
  const errors = [];
  const models = new Set(Object.keys(wf.models || {}));
  const agents = new Set(Object.keys(wf.agents || {}));
  const subflows = new Set(Object.keys(wf.subflows || {}));
  const mainStates = new Set(Object.keys(wf.states || {}));
  const flag = (msg) => errors.push(msg);

  const checkAgentRef = (where, qids) => {
    if (typeof where.agent === 'string' && !agents.has(where.agent)) flag(`unknown agent '${where.agent}' at ${where._at}`);
    checkWhen(where.when, qids, where._at);
    return where.agent;
  };
  const checkWhen = (when, qids, at) => {
    if (!when) return;
    if ('question' in when) {
      if (!qids.has(when.question)) flag(`answerWhen '${when.question}' not a question on the in-scope decision at ${at}`);
      return;
    }
    if (typeof when.path !== 'string') flag(`a 'when' must be a condition (path) or an answerWhen (question) at ${at}`);
  };
  const checkDecision = (dec, at) => {
    if (!dec) return;
    if (dec.decider?.engine === 'llm' && (!dec.decider.agent || !agents.has(dec.decider.agent))) {
      flag(`decision decider uses unknown llm agent '${dec.decider.agent}' at ${at}`);
    }
    if (dec.decider?.engine === 'jev' && typeof dec.decider.model !== 'string') {
      flag(`decision decider 'jev' needs a model identifier at ${at}`);
    }
    if (!dec.questions || typeof dec.questions !== 'object') flag(`decision needs a 'questions' map at ${at}`);
  };
  const decisionQuestionIds = (dec) => new Set(dec && dec.questions ? Object.keys(dec.questions) : []);
  // nested sidekicks: resolve each and detect cycles
  const sidekickVisit = new Set();
  const sidekickStack = [];
  const walkSidekicks = (name) => {
    if (sidekickStack.includes(name)) flag(`sidekick cycle: ${[...sidekickStack, name].join(' -> ')}`);
    if (sidekickVisit.has(name)) return;
    sidekickVisit.add(name);
    sidekickStack.push(name);
    const def = wf.agents?.[name];
    if (def?.sidekicks) for (const s of def.sidekicks) {
      if (!agents.has(s)) { flag(`unknown sidekick '${s}' of agent '${name}'`); continue; }
      walkSidekicks(s);
    }
    sidekickStack.pop();
  };
  for (const name of agents) {
    const def = wf.agents[name];
    if (def && !models.has(def.model)) flag(`agent '${name}' model '${def.model}' not in models`);
    if (def?.sidekicks) for (const s of def.sidekicks) if (agents.has(s)) walkSidekicks(s);
  }

  const checkState = (s, at, targets) => {
    if (!s || typeof s !== 'object') return;
    const where = (k) => `${at}.${k}`;
    if (s.type === 'task') {
      if (s.agent) checkAgentRef({ agent: s.agent, _at: at }, new Set());
      if (s.agents) {
        const dec = s.agents.decision;
        checkDecision(dec, `${at}.agents.decision`);
        const qids = decisionQuestionIds(dec);
        s.agents.candidates.forEach((c, i) => checkAgentRef({ ...c, _at: `${at}.agents.candidates[${i}]` }, qids));
      }
    }
    if (s.type === 'choice') {
      checkDecision(s.decision, `${at}.decision`);
      const qids = decisionQuestionIds(s.decision);
      for (const [i, b] of (s.branches || []).entries()) {
        if (!targets.has(b.next)) flag(`${at}.branches[${i}].next -> '${b.next}' not a state in scope`);
        checkWhen(b.when, qids, `${at}.branches[${i}].when`);
      }
    }
    for (const k of ['next', 'onFail', 'default', 'exhaustNext', 'nextOnApprove', 'nextOnReject']) {
      if (typeof s[k] === 'string' && !targets.has(s[k])) flag(`${where(k)} -> '${s[k]}' not a state in scope`);
    }
    if (s.type === 'parallel') for (const [i, b] of (s.branches || []).entries()) {
      if (!subflows.has(b.flow)) flag(`${at}.branches[${i}].flow -> '${b.flow}' not a subflow`);
    }
    for (const k of ['flow']) if (s.type === 'map' || s.type === 'call') {
      if (typeof s[k] === 'string' && !subflows.has(s[k])) flag(`${at}.${k} -> '${s[k]}' not a subflow`);
    }
  };
  for (const [id, s] of Object.entries(wf.states || {})) checkState(s, `states.${id}`, mainStates);
  for (const [fid, m] of Object.entries(wf.subflows || {})) {
    if (m.states) {
      const inner = new Set(Object.keys(m.states));
      const targets = new Set(mainStates); inner.forEach(t => targets.add(t));
      for (const [id, s] of Object.entries(m.states)) checkState(s, `subflows.${fid}.states.${id}`, targets);
    }
  }
  return errors;
};

const refErrors = resolve(wf);
if (refErrors.length) {
  console.log(`RESOLUTION: ${refErrors.length} unresolved reference(s)`);
  for (const e of refErrors) console.log(` - ${e}`);
  process.exitCode = 1;
} else {
  console.log('RESOLUTION: all references resolve');
}
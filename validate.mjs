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

  const checkAgentRef = (where) => {
    if (typeof where.agent === 'string' && !agents.has(where.agent)) flag(`unknown agent '${where.agent}' at ${where._at}`);
    if (where.when && typeof where.when.path !== 'string') flag(`agentRef 'when' must have a path at ${where._at}`);
    return where.agent;
  };
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
      if (s.agent) checkAgentRef({ agent: s.agent, _at: at });
      if (s.agents) s.agents.candidates.forEach((c, i) => checkAgentRef({ ...c, _at: `${at}.agents.candidates[${i}]` }));
    }
    for (const k of ['next', 'onFail', 'default', 'exhaustNext', 'nextOnApprove', 'nextOnReject']) {
      if (typeof s[k] === 'string' && !targets.has(s[k])) flag(`${where(k)} -> '${s[k]}' not a state in scope`);
    }
    if (s.type === 'choice') for (const [i, b] of (s.branches || []).entries()) {
      if (!targets.has(b.next)) flag(`${at}.branches[${i}].next -> '${b.next}' not a state in scope`);
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
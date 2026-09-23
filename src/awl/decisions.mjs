const fmtItem = (i) => typeof i === 'string' ? i : `(${i.url ? i.url + ' ' : ''}${i.text})`;

export function buildContext(decision, state) {
  const ctx = decision.context || {};
  const inputPaths = Array.isArray(ctx.input) ? ctx.input : (ctx.input ? [ctx.input] : []);
  const parts = [];
  if (ctx.research?.length) parts.push('RESEARCH\n' + ctx.research.map((r) => '  - ' + fmtItem(r)).join('\n'));
  if (ctx.guidelines?.length) parts.push('GUIDELINES\n' + ctx.guidelines.map((g) => '  - ' + g).join('\n'));
  if (inputPaths.length) {
    const folded = {};
    for (const p of inputPaths) folded[p] = getPath(state.data, p);
    parts.push('RELEVANT WORKFLOW STATE\n```json\n' + JSON.stringify(folded, null, 2) + '\n```');
  }
  return parts.join('\n\n');
}

function getPath(state, path) {
  let cur = state;
  for (const seg of String(path).replace(/^\$\.?/, '').split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function buildDecisionPrompt(decision, state, { deciderAgentName } = {}) {
  const qs = Object.entries(decision.questions || {}).map(([name, q]) => {
    let spec = `"${name}": {"answer": `;
    if (q.type === 'choice') spec += `<one of ${Object.keys(q.criteria || {}).map(JSON.stringify).join(', ')}>`;
    else if (q.type === 'score') spec += `<number 0..10>`;
    else spec += `<"true"|"false">`;
    spec += `, "confidence": <0..1>}`;
    const instr = typeof q.instructions === 'string' ? q.instructions : JSON.stringify(q.instructions);
    const extra = q.type === 'choice'
      ? ' CRITERIA: ' + JSON.stringify(q.criteria)
      : q.type === 'score'
        ? ' BANDS: ' + JSON.stringify(q.criteria)
        : '';
    return `${spec}  # ${instr}${extra}`;
  }).join('\n');

  return [
    'You are answering a typed decision for an agent workflow' + (deciderAgentName ? ` (acting as the "${deciderAgentName}" agent)` : '') + '.',
    '',
    buildContext(decision, state),
    '',
    'Decide each question on the evidence above, then reply with ONLY one JSON object, no prose, no markdown fences:',
    '{',
    qs,
    '}',
  ].join('\n');
}

export async function answerDecision({ decision, state, backend, workflow, deciderEngine }) {
  const d = decision.decider || { engine: 'llm' };
  const engine = deciderEngine || d.engine || 'llm';
  const questions = decision.questions || {};
  if (engine === 'jev') {
    return await jevDecide({ decision, state, questions });
  }
  const agentName = d.agent || 'planner';
  const def = workflow.agents?.[agentName];
  const prompt = buildDecisionPrompt(decision, state, { deciderAgentName: agentName });
  if (!def) throw new Error(`decision decider agent '${agentName}' not defined`);
  return await backend.decide({ prompt, def, questions, model: workflow.models?.[def.model] });
}

async function jevDecide({ decision, state, questions }) {
  const endpoint = process.env.AWL_JEV_URL;
  if (!endpoint) throw new Error('jev decider needs AWL_JEV_URL set');
  const body = {
    state: {
      research: (decision.context?.research || []).map(fmtItem),
      guidelines: decision.context?.guidelines || [],
      input: buildContext(decision, state),
    },
    questions,
  };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`jev decider HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const answers = {};
  for (const name of Object.keys(questions)) {
    const a = data.answers?.[name] ?? data[name];
    if (a == null) continue;
    answers[name] = typeof a === 'object' ? a : { answer: a };
  }
  return answers;
}
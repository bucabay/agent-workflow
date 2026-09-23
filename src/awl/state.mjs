const SEG = /\./;

export function getPath(state, path) {
  if (typeof path !== 'string') return undefined;
  let cur = state;
  for (const seg of path.replace(/^\$\.?/, '').split(SEG)) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function evalCondition(state, when) {
  if ('question' in when) throw new Error("answerWhen passed to evalCondition");
  const actual = getPath(state, when.path);
  const { op, value } = when;
  switch (op) {
    case 'equals': return actual === value;
    case 'notEquals': return actual !== value;
    case 'gt': return actual > value;
    case 'gte': return actual >= value;
    case 'lt': return actual < value;
    case 'lte': return actual <= value;
    case 'contains': return Array.isArray(actual) ? actual.includes(value) : String(actual ?? '').includes(String(value));
    case 'exists': return actual !== undefined;
    default: throw new Error(`unknown condition op '${op}'`);
  }
}

export function evalAnswer(when, answers) {
  if (!('question' in when)) throw new Error("condition passed to evalAnswer");
  const answer = answers && answers[when.question];
  if (!answer) return false;
  const value = answer.answer;
  let ok = false;
  if (when.equals !== undefined) ok = value === when.equals;
  else if (when.lt !== undefined) ok = value < when.lt;
  else if (when.lte !== undefined) ok = value <= when.lte;
  else if (when.gt !== undefined) ok = value > when.gt;
  else if (when.gte !== undefined) ok = value >= when.gte;
  if (!ok) return false;
  const conf = answer.confidence;
  const floor = when.minConfidence ?? 0;
  return conf === undefined || conf >= floor;
}

export function evalWhen(when, ctx) {
  return 'question' in when
    ? evalAnswer(when, ctx.decisionAnswers)
    : evalCondition(ctx.state, when);
}
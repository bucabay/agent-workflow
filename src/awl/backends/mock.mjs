export function makeMockBackend(script) {
  return {
    name: 'mock',
    async ask({ prompt, def, model, agentName }) {
      const plan = script || {};
      let output;
      if (plan.outputsByAgent && agentName && plan.outputsByAgent[agentName]) {
        output = plan.outputsByAgent[agentName];
      } else if (plan.prompts && plan.prompts[prompt]) {
        output = plan.prompts[prompt];
      } else if (typeof plan.output === 'function') {
        output = String(plan.output({ prompt, def, model, agentName }));
      } else if (typeof plan.output === 'string') {
        output = plan.output;
      } else if (plan.output && typeof plan.output === 'object') {
        output = JSON.stringify(plan.output);
      } else {
        output = 'mock response';
      }
      return { output, metadata: { costUsd: 0, numTurns: 1, durationMs: 1, usage: {} } };
    },
    async decide({ prompt, questions }) {
      const plan = script || {};
      if (typeof plan.decide === 'function') return plan.decide({ prompt, questions });
      const answers = {};
      for (const name of Object.keys(questions || {})) {
        const a = plan.answers && plan.answers[name];
        answers[name] = a && typeof a === 'object' && 'answer' in a ? a : { answer: a ?? 'yes', confidence: 1 };
      }
      return answers;
    },
  };
}
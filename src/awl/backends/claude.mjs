const TOOL_MAP = {
  read: 'Read', grep: 'Grep', glob: 'Glob', write: 'Write', edit: 'Edit',
  multiedit: 'MultiEdit', notebookedit: 'NotebookEdit', bash: 'Bash',
  web: 'WebFetch', webfetch: 'WebFetch', websearch: 'WebSearch', task: 'Task',
  todowrite: 'TodoWrite', git: 'Bash', ls: 'Bash',
};

function mapTools(def) {
  if (!def.tools) return null;
  const out = [];
  for (const t of def.tools) {
    const name = TOOL_MAP[String(t).toLowerCase()];
    if (name) out.push(name);
    else throw new Error(`cannot map AWL tool '${t}' to a Claude Code tool (known: ${Object.keys(TOOL_MAP).join(', ')})`);
  }
  return [...new Set(out)];
}

export function makeClaudeBackend(opts = {}) {
  const { auto = false, dangerous = false, hooks } = opts;
  let queryFn;
  return {
    name: 'claude',
    async init() {
      if (!queryFn) queryFn = (await import('@anthropic-ai/claude-agent-sdk')).query;
      if (!process.env.ANTHROPIC_API_KEY && !opts.apiKey) {
        throw new Error('claude backend needs ANTHROPIC_API_KEY. Set AWL_BACKEND=mock to run without one.');
      }
    },
    async ask({ prompt, def, model, cwd, agentName, sidekickDefs }) {
      await this.init();
      const tools = mapTools(def);
      const readOnly = !!def.readOnly;
      const permissionMode = readOnly ? 'dontAsk' : auto ? (dangerous ? 'bypassPermissions' : 'acceptEdits') : 'default';
      const systemPrompt = def.prompt
        + '\n\nYou are the "' + (agentName || 'agent') + '" role in an agent workflow.'
        + (readOnly ? '\nREAD-ONLY: you must never modify the filesystem. Only the allowlisted tools are available.' : '')
        + (def.cleanContext ? '\nClean context: treat this session as isolated; re-discover what you need rather than assuming prior turns.' : '');

      const options = {
        prompt,
        cwd,
        permissionMode,
        systemPrompt,
        maxTurns: def.maxTurns || 40,
        hooks: hooks ?? {},
      };
      const resolvedModel = typeof def.model === 'string' ? def.model : undefined;
      if (resolvedModel) options.model = resolvedModel;
      if (dangerous) options.allowDangerouslySkipPermissions = true;
      if (readOnly || tools) options.allowedTools = tools || [];
      if (def.sidekicks && def.sidekicks.length && sidekickDefs) {
        const agents = {};
        const background = [];
        for (const name of def.sidekicks) {
          const sd = sidekickDefs[name];
          if (!sd) continue;
          agents[name] = sidekickDefinition(name, sd);
          if (sd.optional) background.push(name);
        }
        if (Object.keys(agents).length) {
          options.agents = agents;
          if (background.length) options.background = background;
        }
      }

      const messages = [];
      for await (const message of queryFn({ prompt, options })) messages.push(message);
      const result = [...messages].reverse().find((m) => m.type === 'result');
      if (result && result.is_error) throw new Error(`agent run failed: ${result.result}`);
      const text = messages
        .filter((m) => m.type === 'assistant')
        .map((m) => Array.isArray(m.message?.content)
          ? m.message.content.map((c) => c.type === 'text' ? c.text : '').join(' ')
          : '')
        .join('\n');
      return {
        output: text || result?.result || '',
        metadata: {
          costUsd: result?.total_cost_usd ?? 0,
          numTurns: result?.num_turns ?? 0,
          durationMs: result?.duration_ms ?? 0,
          usage: result?.usage ?? {},
        },
      };
    },
    async decide({ prompt, questions }) {
      const res = await this.ask({ prompt, def: { prompt: '', model: 'frontier' }, cwd: opts.cwd, agentName: 'decider' });
      return parseAnswers(res.output, questions);
    },
  };
}

function sidekickDefinition(name, sd) {
  return {
    description: (sd.prompt || name).slice(0, 200),
    prompt: sd.prompt || 'Follow the plan exactly.',
    tools: sd.tools ? mapTools(sd) : undefined,
    model: typeof sd.model === 'string' ? sd.model : undefined,
    background: !!sd.optional,
    maxTurns: sd.maxTurns || 40,
  };
}

function parseAnswers(text, questions) {
  const answers = {};
  const cleaned = (text || '').replace(/```(?:json)?/g, '').trim();
  let json;
  try {
    json = JSON.parse(cleaned);
  } catch {
    const open = cleaned.indexOf('{');
    const close = cleaned.lastIndexOf('}');
    if (open >= 0 && close > open) json = JSON.parse(cleaned.slice(open, close + 1));
    else throw new Error('decider did not return JSON: ' + cleaned.slice(0, 120));
  }
  for (const name of Object.keys(questions || {})) {
    const q = questions[name];
    const raw = json[name] ?? json.questions?.[name];
    if (raw == null) continue;
    if (typeof raw === 'object' && 'answer' in raw) answers[name] = raw;
    else answers[name] = { answer: normalize(q, raw), confidence: typeof raw === 'object' ? raw.confidence : undefined };
  }
  return answers;
}

function normalize(q, raw) {
  if (q.type === 'choice') return String(raw);
  if (q.type === 'score') return typeof raw === 'number' ? raw : Number(raw);
  if (q.type === 'noul') return q.criteria && Object.keys(q.criteria).includes(raw) ? raw : (raw === true || raw === 'true');
  return raw;
}
import { randomUUID } from 'node:crypto';

const READONLY_DENY = new Set(['bash', 'write', 'edit', 'patch', 'apply_patch', 'rename', 'mkdir', 'rm']);
const READONLY_BLOCK = new Set(['bash']);

export function makeOpencodeBackend(opts = {}) {
  const { hostname = '127.0.0.1', port, apiKey, auto = false, dangerous = false } = opts;
  let client;
  let server;
  let provider = opts.provider || process.env.AWL_OPENCODE_PROVIDER || 'anthropic';

  const modelOf = (def, model) => {
    const modelID = typeof def.model === 'string' ? def.model : undefined;
    if (!modelID) return undefined;
    const slash = modelID.indexOf('/');
    if (slash > 0) return { providerID: modelID.slice(0, slash), modelID: modelID.slice(slash + 1) };
    return { providerID: model?.config ? provider : provider, modelID };
  };

  return {
    name: 'opencode',
    async init({ cwd } = {}) {
      const { createOpencode } = await import('@opencode-ai/sdk');
      const created = await createOpencode({
        hostname,
        ...(port ? { port } : {}),
        config: { ...(cwd ? { cwd } : {}) },
      });
      client = created.client;
      server = created.server;
      const key = apiKey || process.env.AWL_OPENCODE_API_KEY;
      if (key) {
        try {
          await client.auth.set({ path: { id: provider }, body: { type: 'api', key } });
        } catch { /* auth may already be configured via `opencode auth login` */ }
      }
    },
    async ask({ prompt, def, model, cwd, agentName }) {
      if (!client) await this.init({ cwd });
      const m = modelOf(def, model);
      const readOnly = !!def.readOnly;
      const system = def.prompt
        + '\n\nYou are the "' + (agentName || 'agent') + '" role in an agent workflow.'
        + (readOnly ? '\nREAD-ONLY: you may inspect and search but never modify the filesystem.' : '')
        + (def.cleanContext ? '\nClean context: treat this session as isolated.' : '');

      let session;
      try {
        session = await client.session.create({
          body: { title: `awl ${agentName || 'agent'}` },
          query: { directory: cwd },
        });
      } catch {
        session = await client.session.create({ body: { title: `awl ${agentName || 'agent'}` } });
      }

      const tools = {};
      if (readOnly) {
        for (const name of READONLY_DENY) tools[name] = false;
      }

      const res = await client.session.prompt({
        path: { id: session.id },
        body: {
          parts: [{ type: 'text', text: prompt }],
          system,
          ...(m ? { model: m } : {}),
          ...(Object.keys(tools).length ? { tools } : {}),
        },
        query: { directory: cwd },
      });
      const text = (res.parts || [])?.filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim();
      const info = res.info || {};
      const tokens = info.tokens || {};
      if (info.error) throw new Error(`opencode message failed (provider ${info.providerID}/${info.modelID}): ${info.error?.message || info.error}`);
      return {
        output: text || '',
        metadata: {
          costUsd: info.cost ?? 0,
          numTurns: 1,
          durationMs: info.time?.completed ? info.time.completed - (info.time.created || 0) : 0,
          provider: info.providerID || provider,
          model: info.modelID || m?.modelID,
          usage: {
            input_tokens: tokens.input,
            output_tokens: tokens.output,
            cache_read_input_tokens: tokens.cache?.read,
          },
        },
      };
    },
    async decide({ prompt, questions }) {
      const res = await this.ask({ prompt, def: { prompt: '', model: 'frontier' }, cwd: opts.cwd, agentName: 'decider' });
      return parseAnswers(res.output, questions);
    },
    async destroy() {
      if (server) await server.close();
    },
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
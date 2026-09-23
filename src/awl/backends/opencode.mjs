const READONLY_TOOLS = ['read', 'grep', 'glob', 'git'];
const ALL_TOOLS = [...READONLY_TOOLS, 'edit', 'write', 'multiEdit'];
// OpenCode's free tier 403s any `tools` map containing a key mapped to `false`,
// so only ever send enabled-only maps. Omitting `bash` from the set stops the
// model from launching slow bash loops in read-only/headless sessions.
const toolsFor = (def, opts) => {
  if (!opts.enforceTools) return {};
  const want = def?.tools?.length ? def.tools : (def?.readOnly ? READONLY_TOOLS : ALL_TOOLS);
  const map = {};
  for (const name of ALL_TOOLS) if (want.includes(name)) map[name] = true;
  return map;
};

class StuckTurnError extends Error {
  constructor() { super('opencode turn stuck'); this.name = 'StuckTurnError'; }
}

export function makeOpencodeBackend(opts = {}) {
  const { hostname = '127.0.0.1', port, apiKey, auto = false, dangerous = false, enforceTools = true } = opts;
  let client;
  let server;
  let attached = false;

  const modelOf = (def) => {
    const modelID = typeof def.model === 'string' ? def.model : undefined;
    if (!modelID) return undefined;
    const slash = modelID.indexOf('/');
    if (slash > 0) return { providerID: modelID.slice(0, slash), modelID: modelID.slice(slash + 1) };
    return { providerID: opts.provider || process.env.AWL_OPENCODE_PROVIDER || 'anthropic', modelID };
  };

  const ensureAuth = async (providerID) => {
    if (attached) return; // the running server already carries `opencode auth login` creds; don't clobber them
    const key = apiKey || process.env.AWL_OPENCODE_API_KEY;
    if (!key) return;
    try {
      await client.auth.set({ path: { id: providerID }, body: { type: 'api', key } });
    } catch { /* auth may already be configured via `opencode auth login` */ }
  };

  const startResponder = (session, permission, spec) => {
    if (!spec.respond) return () => {};
    let stream;
    const run = (async () => {
      try {
        const { stream: s } = (await client.event.subscribe({ query: { directory: spec.cwd } })) || {};
        if (!s) return;
        stream = s;
        for await (const ev of stream) {
          if (ev?.type === 'permission.updated' &&
              session && ev.properties?.sessionID === session.id) {
            const p = ev.properties;
            const isBash = p.type === 'bash' || String(p.pattern || '').startsWith('bash');
            // The opencode server grants its default agent every tool, bash
            // included, no matter what a `tools` map says. Slow bash loops in
            // headless reads are a real failure mode, so reject bash outright
            // unless the run is explicitly dangerous.
            const response = isBash && !spec.dangerous ? 'reject' : spec.response;
            permission.count++;
            permission.decisions.push({ title: p.title, type: p.type, response });
            try {
              await client.postSessionIdPermissionsPermissionId({
                path: { id: session.id, permissionID: p.id },
                body: { response },
                query: { directory: spec.cwd },
              });
            } catch { permission.errors = (permission.errors || 0) + 1; }
          }
        }
      } catch { /* best-effort permission handling */ }
    })();
    return () => { try { stream?.return?.(); } catch {} };
  };

  return {
    name: 'opencode',
    async init({ cwd } = {}) {
      if (client) return;
      const { createOpencodeClient, createOpencode } = await import('@opencode-ai/sdk');
      const makeClient = (base) => createOpencodeClient({ baseUrl: base });
      const base = `http://${hostname}:${port || 4096}`;
      try {
        const probe = makeClient(base);
        await probe.config.get();
        client = probe;
        attached = true;
      } catch {
        const created = await createOpencode({
          hostname,
          ...(port ? { port } : {}),
          config: { ...(cwd ? { cwd } : {}) },
        });
        server = created.server;
        const p = Number(created.server?.port) || port || 4096;
        client = makeClient(`http://${hostname}:${p}`);
      }
    },
    async ask({ prompt, def, model, cwd, agentName }) {
      await this.init({ cwd });
      const m = modelOf(def);
      if (m) await ensureAuth(m.providerID);
      const readOnly = !!def.readOnly;
      const system = def.prompt
        + '\n\nYou are the "' + (agentName || 'agent') + '" role in an agent workflow.'
        + (readOnly ? '\nREAD-ONLY: you may inspect and search but never modify the filesystem or run commands.' : '')
        + (def.cleanContext ? '\nClean context: treat this session as isolated; re-discover what you need.' : '');
      let hint = ''; // appended to prompt when a stuck turn is aborted and retried

      const createSession = async () => {
        let created;
        try {
          created = await client.session.create({ body: { title: `awl ${agentName || 'agent'}` }, query: { directory: cwd } });
        } catch {
          created = await client.session.create({ body: { title: `awl ${agentName || 'agent'}` } });
        }
        const s = created?.data?.id ? created.data : created;
        if (!s?.id) throw new Error('opencode session.create returned no id');
        return s;
      };

      const tools = toolsFor(def, opts);

      const sessionPrompt = async (sid) => {
        const body = {
          parts: [{ type: 'text', text: prompt + hint }],
          system,
          ...(m ? { model: m } : {}),
          ...(Object.keys(tools).length ? { tools } : {}),
        };
        /*
         * POST /session/{id}/prompt_async returns immediately and the model
         * runs in the background. We then poll the session's last assistant
         * message. This matters on rate-limited/free tiers where a full turn
         * (several tool passes) can take minutes: the plain /prompt call
         * buffers its JSON until the turn finishes, which trips undici's
         * default 300s headers timeout.
         */
        try {
          const accepted = await client.session.promptAsync({
            path: { id: sid },
            body,
            query: { directory: cwd },
          });
          if (accepted?.data === undefined || accepted?.data === null) {
            // fall through to synchronous prompt below
          } else {
            const deadline = Date.now() + 30 * 60 * 1000;
            const begin = Date.now();
            const seen = { id: null, since: begin };
            for (;;) {
              await new Promise((r) => setTimeout(r, 1500));
              if (Date.now() > deadline) throw new Error('opencode prompt timed out after 30m');
              const msgs = (await client.session.messages({ path: { id: sid }, query: { directory: cwd } }))?.data ?? [];
              const assistants = msgs.filter((x) => x?.info?.role === 'assistant');
              // sessions accumulate several assistant messages per turn (one per
              // step); take the NEWEST by creation time, so we never latch onto a
              // finished-but-stale step while later edits are still in flight.
              assistants.sort((a, b) => (b.info.time?.created || 0) - (a.info.time?.created || 0));
              const newest = assistants[0];
              if (newest?.info?.finish) {
                const detail = (await client.session.message({
                  path: { id: sid, messageID: newest.info.id },
                  query: { directory: cwd },
                }))?.data;
                return detail ?? newest;
              }
              // A turn that makes no progress (no new message) for a while is a
              // server-side tool call that will never return (the server
              // auto-approves bash and never surfaces a permission we could
              // reject). Abort so the caller can retry with a no-bash nudge.
              const id = newest?.info?.id ?? null;
              if (id === seen.id && Date.now() - seen.since > 120_000) throw new StuckTurnError();
              if (id !== seen.id) { seen.id = id; seen.since = Date.now(); }
            }
          }
        } catch (e) {
          if (!isTransient(e)) throw e; // async path unavailable; try sync below
        }
        const res = await client.session.prompt({
          path: { id: sid },
          body,
          query: { directory: cwd },
        });
        return res?.data ?? res;
      };
      const isTransient = (e) => /fetch failed|ECONNRESET|socket hang up|UND_ERR|network error|headers timeout|body timeout/i.test(String(e?.cause?.message || e?.message || e));

      const permission = { count: 0, decisions: [], errors: 0 };
      let stop = () => {};
      let session; // Node's finally does not share the try block's lexical scope

      try {
        let msg;
        let attempt = 0;
        let abortedTurns = 0;
        session = await createSession();
        stop = startResponder(session, permission, {
          cwd,
          dangerous,
          respond: dangerous ? 'always' : auto ? 'once' : false,
          response: dangerous ? 'always' : 'once',
        });
        for (;;) {
          try {
            msg = await sessionPrompt(session.id);
            break;
          } catch (e) {
            if (e instanceof StuckTurnError) {
              if (attempt >= 2) throw e;
              attempt++;
              abortedTurns = attempt;
              hint += '\n\nIMPORTANT: do not use the bash tool or shell commands. Use only file read/search/edit/write tools and answer directly.';
              try { stop(); } catch {}
              try { await client.session.delete({ path: { id: session.id } }); } catch { /* busy or gone; abandon */ }
              session = await createSession();
              stop = startResponder(session, permission, {
                cwd,
                dangerous,
                respond: dangerous ? 'always' : auto ? 'once' : false,
                response: dangerous ? 'always' : 'once',
              });
              continue;
            }
            attempt++;
            const why = String(e?.cause?.message || e?.message || e);
            if (process.env.AWL_OC_TRACE) {
              const fs = await import('node:fs');
              fs.appendFileSync(process.env.AWL_OC_TRACE, JSON.stringify({ phase: 'prompt-fail', attempt, agent: agentName, cause: why.slice(0, 200) }) + '\n');
            }
            if (!isTransient(e) || attempt >= 2) throw e;
            if (permission.count) throw e; // real permission gating; don't mask it with a retry
          }
        }
        const text = (msg.parts || [])?.filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim();
        const info = msg.info || {};
        const tokens = info.tokens || {};
        if (info.error) throw new Error(fmtError(info.error, info));
        return {
          output: text || '',
          metadata: {
            costUsd: info.cost ?? 0,
            numTurns: 1,
            durationMs: info.time?.completed ? info.time.completed - (info.time.created || 0) : 0,
            provider: info.providerID || m?.providerID,
            model: info.modelID || m?.modelID,
            usage: {
              input_tokens: tokens.input,
              output_tokens: tokens.output,
              cache_read_input_tokens: tokens.cache?.read,
            },
            permissionCount: permission.count,
            abortedTurns,
          },
        };
      } finally {
        stop();
        try { await client.session.delete({ path: { id: session.id } }); } catch { /* already gone */ }
      }
    },
    async decide({ prompt, questions, model }) {
      const modelStr = model?.model;
      const res = await this.ask({ prompt, def: { prompt: '', model: modelStr }, cwd: opts.cwd, agentName: 'decider' });
      return parseAnswers(res.output, questions);
    },
    async destroy() {
      if (server) await server.close();
    },
  };
}

function fmtError(e, info) {
  const status = e?.data?.statusCode ?? e?.statusCode ?? e?.status;
  const message = e?.data?.message ?? e?.message ?? (typeof e === 'string' ? e : null);
  const tag = info ? `${info.providerID}/${info.modelID}` : '';
  return `opencode message failed${tag ? ` (${tag})` : ''}${status ? ` HTTP ${status}` : ''}: ${message || JSON.stringify(e).slice(0, 500)}`;
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
export async function resolveBackend(name, opts = {}) {
  const which = name || process.env.AWL_BACKEND || 'claude';
  if (which === 'claude') {
    const { makeClaudeBackend } = await import('./claude.mjs');
    return makeClaudeBackend(opts);
  }
  if (which === 'mock') {
    const { makeMockBackend } = await import('./mock.mjs');
    return makeMockBackend(opts.mockScript);
  }
  if (which === 'opencode') {
    const { makeOpencodeBackend } = await import('./opencode.mjs');
    const { apiKey, provider, ...rest } = opts;
    return makeOpencodeBackend({ ...rest, apiKey: apiKey || process.env.AWL_OPENCODE_API_KEY, provider });
  }
  throw new Error(`unknown backend '${which}' (want claude|opencode|mock)`);
}
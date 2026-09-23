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
  throw new Error(`unknown backend '${which}' (want claude|mock)`);
}
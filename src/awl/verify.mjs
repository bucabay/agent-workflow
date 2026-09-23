import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';

const pexec = promisify(execFile);

export async function runToolState(s, state, cwd) {
  const command = s.run?.command;
  if (!command) throw new Error('tool task missing run.command');
  const timeoutMs = s.run?.timeoutMs ?? 0;
  try {
    const { stdout, stderr } = await pexec('sh', ['-c', command], {
      cwd,
      timeout: timeoutMs || undefined,
      maxBuffer: 32 * 1024 * 1024,
    });
    return {
      passed: true,
      exitCode: 0,
      stdout: tail(stdout),
      stderr: tail(stderr),
    };
  } catch (err) {
    return {
      passed: false,
      exitCode: err.code ?? 1,
      stdout: tail(err.stdout || ''),
      stderr: tail(err.stderr || String(err.message)),
    };
  }
}

function tail(s, n = 4000) {
  return String(s || '').slice(-n);
}

export async function approve(s, opts = {}) {
  const yes = opts.yes;
  if (yes) return { approved: true, reason: 'auto-approve' };
  if (process.stdin.isTTY) {
    let answer;
    try {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      answer = await new Promise((resolve) => rl.question(`${s.prompt} [y/N] `, resolve));
      rl.close();
    } catch {
      answer = 'n';
    }
    return { approved: /^y/i.test(answer), reason: 'tty' };
  }
  throw new Error(`approval needed for "${s.prompt}" but stdin is not a TTY. Pass -y/--yes to auto-approve.`);
}
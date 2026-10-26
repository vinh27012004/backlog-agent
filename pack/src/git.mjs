// Git trong helper (05 §8): spawn với mảng tham số, không shell, không prompt, không force.
import { childEnv, run } from './jobs.mjs';
import { fail } from './util.mjs';

const ALLOWED = new Set(['ls-remote', 'clone', 'fetch', 'rev-parse', 'status', 'diff', 'add', 'commit',
  'push', 'show', 'cat-file', 'config', 'log', 'rebase', 'ls-files', 'remote', 'reset', 'checkout', 'stash',
  'worktree', 'cherry-pick', 'rev-list', 'branch']);

export async function git(args, { cwd, timeoutMs = 60_000, allowFail = false } = {}) {
  const sub = args.find(a => !a.startsWith('-') && a !== '-C');
  if (!ALLOWED.has(sub)) fail('GIT_COMMAND_NOT_ALLOWED', sub);
  if (args.some(a => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || a.startsWith('+'))) {
    if (sub === 'push') fail('GIT_COMMAND_NOT_ALLOWED', 'force push');
  }
  const res = await run('git', ['-c', 'core.quotepath=false', '-c', 'credential.interactive=never', ...args],
    { cwd, timeoutMs, env: childEnv({ GIT_ASKPASS: '', SSH_ASKPASS: '' }), tailBytes: 256 * 1024 });
  if (res.code !== 0 && !allowFail) {
    const auth = /authentication|could not read username|403|denied|terminal prompts disabled/i.test(res.tail);
    fail(auth ? 'GIT_AUTH_FAILED' : 'GIT_FAILED', `${sub}: ${res.tail.trim().split(/\r?\n/).slice(-3).join(' | ')}`);
  }
  return { ...res, out: res.stdout.trim() };
}

export async function revParse(cwd, ref = 'HEAD') {
  const res = await git(['rev-parse', ref], { cwd });
  const sha = res.out.split(/\r?\n/).pop().trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha)) fail('GIT_FAILED', 'rev-parse');
  return sha;
}

// URL so sánh được: bỏ .git và / cuối, chữ thường.
export const normalizeRepoUrl = url => String(url).trim().replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();

// Git trong helper (05 §8): spawn với mảng tham số, không shell, không prompt, không force.
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv, run } from './jobs.mjs';
import { fail } from './util.mjs';

const ALLOWED = new Set(['ls-remote', 'clone', 'fetch', 'rev-parse', 'status', 'diff', 'add', 'commit',
  'push', 'show', 'cat-file', 'config', 'log', 'rebase', 'ls-files', 'remote', 'reset', 'checkout', 'stash',
  'worktree', 'cherry-pick', 'rev-list', 'branch', 'write-tree', 'clean', 'merge', 'apply', 'grep', 'hash-object', 'ls-tree']);

export async function git(args, { cwd, timeoutMs = 60_000, allowFail = false, env = {} } = {}) {
  const sub = args.find(a => !a.startsWith('-') && a !== '-C');
  if (!ALLOWED.has(sub)) fail('GIT_COMMAND_NOT_ALLOWED', sub);
  if (args.some(a => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || a.startsWith('+'))) {
    if (sub === 'push') fail('GIT_COMMAND_NOT_ALLOWED', 'force push');
  }
  const res = await run('git', ['-c', 'core.quotepath=false', '-c', 'credential.interactive=never', ...args],
    { cwd, timeoutMs, env: childEnv({ GIT_ASKPASS: '', SSH_ASKPASS: '', ...env }), tailBytes: 256 * 1024 });
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

// SHA tree của nội dung đang có trong <folder>/ (file đã track, file mới chưa track; trừ file bị ignore và `exclude`).
// Dựng trên index tạm (GIT_INDEX_FILE) nên không đụng index thật. Cùng nội dung thì cùng SHA, dù ở worktree hay
// checkout chính, dù đã commit hay chưa: gate lưu SHA này, integrate/commit_and_push so lại.
export async function contentTree(cwd, folder, exclude = []) {
  const index = join(tmpdir(), `team-tree-${process.pid}-${randomUUID()}.idx`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(['add', '-A', '--', folder, ...exclude.map(p => `:(exclude)${p}`)], { cwd, env, timeoutMs: 120_000 });
    return (await git(['write-tree'], { cwd, env })).out.split(/\r?\n/).pop().trim();
  } finally {
    rmSync(index, { force: true });
  }
}

// Đường dẫn khác nhau giữa hai tree (để báo cho root biết cái gì đổi sau gate).
export async function treeChanges(cwd, a, b) {
  const res = await git(['diff', '--name-only', a, b], { cwd, allowFail: true });
  return res.code === 0 ? res.out.split(/\r?\n/).filter(Boolean) : [];
}

// URL so sánh được: bỏ .git và / cuối, chữ thường.
export const normalizeRepoUrl = url => String(url).trim().replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();

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

// File đã track khác HEAD về nội dung (sau bộ lọc EOL), đường dẫn tính từ gốc repo. Câu hỏi "main có sạch không" phải
// dùng hàm này, không dùng `status --porcelain`: với core.autocrlf=true, file text=auto bị công cụ ghi lại bằng LF
// (vitest ghi lại *.snap khi chạy baseline tests) bị status báo M dù nội dung y hệt và git diff rỗng. Practice 85WTXFLQ:
// sáu file .snap như vậy làm mọi publish dừng ở WORKTREE_CONFLICT, không item nào được nộp.
export async function trackedChanges(cwd) {
  return (await git(['diff', '--name-only', '--no-renames', 'HEAD'], { cwd })).out.split(/\r?\n/).filter(Boolean);
}

// File đã track mà `git status` coi là đã sửa (kể cả chỉ khác stat/EOL), đường dẫn tính từ gốc repo; null khi cwd
// không nằm trong repo git.
export async function statusChanged(cwd) {
  const res = await git(['status', '--porcelain', '-z', '--no-renames', '--untracked-files=no'], { cwd, allowFail: true });
  return res.code === 0 ? res.stdout.split('\0').filter(Boolean).map(e => e.slice(3)) : null;
}

// Trả các file đã track (đường dẫn tính từ gốc repo) về bản trong index. Chia lô để không vượt giới hạn dòng lệnh Windows.
export async function restoreTracked(cwd, files) {
  if (!files.length) return [];
  const top = (await git(['rev-parse', '--show-toplevel'], { cwd })).out.split(/\r?\n/).pop().trim();
  for (let i = 0; i < files.length; i += 100) await git(['checkout', '--', ...files.slice(i, i + 100)], { cwd: top });
  return files;
}

// SHA tree của nội dung đang có trong <folder>/ (file đã track, file mới chưa track; trừ file bị ignore và `exclude`).
// Dựng trên index tạm (GIT_INDEX_FILE) nên không đụng index thật. Cùng nội dung thì cùng SHA, dù ở worktree hay
// checkout chính, dù đã commit hay chưa: gate lưu SHA này, integrate/commit_and_push so lại.
// `git add` hỏng khi một tiến trình đang ghi đúng file đó (LXRMBRA2 BUG-09: capture_evidence chụp snapshot lúc bộ test
// nền của run_checks ghi lại transfer.test.ts.snap, "failed to insert into database", lần chụp hỏng GIT_FAILED rồi mất
// khoảng 2 phút). Thử lại với index tạm mới, chờ 0,4–1,2 s giữa các lần; lỗi khác GIT_FAILED thì ném luôn.
export async function contentTree(cwd, folder, exclude = [], { attempts = 4, delayMs = 400, runGit = git } = {}) {
  for (let attempt = 1; ; attempt++) {
    const index = join(tmpdir(), `team-tree-${process.pid}-${randomUUID()}.idx`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await runGit(['add', '-A', '--', folder, ...exclude.map(p => `:(exclude)${p}`)], { cwd, env, timeoutMs: 120_000 });
      return (await runGit(['write-tree'], { cwd, env })).out.split(/\r?\n/).pop().trim();
    } catch (error) {
      if (error.code !== 'GIT_FAILED' || attempt >= attempts) throw error;
    } finally {
      rmSync(index, { force: true });
      rmSync(`${index}.lock`, { force: true });
    }
    await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
  }
}

// Đường dẫn khác nhau giữa hai tree (để báo cho root biết cái gì đổi sau gate).
export async function treeChanges(cwd, a, b) {
  const res = await git(['diff', '--name-only', a, b], { cwd, allowFail: true });
  return res.code === 0 ? res.out.split(/\r?\n/).filter(Boolean) : [];
}

// URL so sánh được: bỏ .git và / cuối, chữ thường.
export const normalizeRepoUrl = url => String(url).trim().replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();

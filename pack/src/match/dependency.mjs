// Item phụ thuộc item khác. LXRMBRA2: CR-07 (hạn 20 phút) chỉ đúng số liệu chính thức khi source nộp có bản sửa của
// BUG-11; BUG-11 xong code và test trọng tâm ở phút 7,5 nhưng tới phút 25 mới bàn giao (evidence, check, publish hỏng),
// CR-07 nộp thiếu bản sửa và mất 41 điểm. Helper chép phần sửa product code của item được chờ sang worktree của item
// chờ ngay khi nó gọi ready_for_evidence (và lại ở candidate nếu product đổi): không chép test, cấu hình test, answers/.
// Item chờ chạy lại replay và tự kiểm; hai item cùng sửa một file thì không chép gì.
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { changedFiles } from './answers.mjs';
import { git } from '../core/git.mjs';

// File product item tự sửa so với base (đường dẫn tương đối checkout, posix).
export async function productChanges(root, base, folder, isProduct) {
  const files = await changedFiles(root, base);
  return files.filter(f => f.path.startsWith(`${folder}/`) && !f.path.startsWith(`${folder}/answers/`)
    && !/(^|\/)\.codegraph\//.test(f.path) && isProduct(f.path));
}

// Nội dung từng file (blob id sau bộ lọc của git, như blob trong commit; null: không có file).
export async function fingerprint(root, paths) {
  const out = {};
  for (const p of paths) {
    out[p] = existsSync(join(root, p)) ? (await git(['hash-object', '--', p], { cwd: root })).out.trim() : null;
  }
  return out;
}
export async function fingerprintAt(root, rev, paths) {
  const out = {};
  for (const p of paths) {
    const res = await git(['rev-parse', '--verify', '--quiet', `${rev}:${p}`], { cwd: root, allowFail: true });
    out[p] = res.code === 0 ? res.out.trim() : null;
  }
  return out;
}
export const sameContent = (a, b) => Boolean(a && b) && Object.keys(a).length === Object.keys(b).length
  && Object.keys(a).every(p => a[p] === b[p]);

// Trả file của lần chép trước về như HEAD của worktree nhận.
export async function revert(root, paths) {
  for (const p of paths) {
    const atHead = (await git(['cat-file', '-e', `HEAD:${p}`], { cwd: root, allowFail: true })).code === 0;
    if (atHead) await git(['checkout', 'HEAD', '--', p], { cwd: root });
    else rmSync(join(root, p), { force: true });
  }
}

// Áp thay đổi product của worktree `from` (so với fromBase) vào worktree `to`. `previous` là lần chép trước
// ({files, fingerprint} trong worktree nhận): nội dung giống thì không làm gì, worker nhận đã sửa các file đó thì thôi.
// Trả {files, fingerprint} (fingerprint của các file đó trong worktree nhận), {unchanged: true} hay {skipped: lý do}.
export async function shareFix({ fromRoot, fromBase, toRoot, toBase, folder, isProduct, patchFile, previous = null }) {
  const mine = await productChanges(fromRoot, fromBase, folder, isProduct);
  if (!mine.length) return { skipped: 'no product change to share' };
  const paths = mine.map(f => f.path);
  const source = await fingerprint(fromRoot, paths);
  const prevFiles = previous?.files ?? [];
  if (previous) {
    if (!sameContent(await fingerprint(toRoot, prevFiles), previous.fingerprint)) return { skipped: 'the receiving worker changed the copied files' };
    if (sameContent(source, previous.fingerprint) && paths.length === prevFiles.length) return { unchanged: true };
  }
  const theirs = new Set((await changedFiles(toRoot, toBase)).map(f => f.path).filter(p => !prevFiles.includes(p)));
  const both = paths.filter(p => theirs.has(p));
  if (both.length) return { skipped: `both items change ${both.slice(0, 5).join(', ')}` };
  const untracked = new Set((await git(['ls-files', '--others', '--exclude-standard'], { cwd: fromRoot })).out.split(/\r?\n/).filter(Boolean));
  const tracked = paths.filter(p => !untracked.has(p)), fresh = paths.filter(p => untracked.has(p));
  if (previous) await revert(toRoot, prevFiles);
  const undo = async why => { await revert(toRoot, paths); return { skipped: why }; };
  if (tracked.length) {
    mkdirSync(dirname(patchFile), { recursive: true });
    await git(['diff', '--binary', `--output=${patchFile}`, fromBase, '--', ...tracked], { cwd: fromRoot });
    const check = await git(['apply', '--check', '--whitespace=nowarn', patchFile], { cwd: toRoot, allowFail: true });
    if (check.code !== 0) return undo(`the patch does not apply cleanly: ${String(check.tail ?? '').trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 300)}`);
  }
  for (const p of fresh) if (existsSync(join(toRoot, p))) return undo(`${p} already exists in the receiving worktree`);
  if (tracked.length) {
    const applied = await git(['apply', '--whitespace=nowarn', patchFile], { cwd: toRoot, allowFail: true });
    if (applied.code !== 0) return undo('git apply failed');
  }
  for (const p of fresh) {
    mkdirSync(dirname(join(toRoot, p)), { recursive: true });
    copyFileSync(join(fromRoot, p), join(toRoot, p));
  }
  return { files: paths, fingerprint: await fingerprint(toRoot, paths) };
}

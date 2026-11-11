// node_modules của worktree dựng bằng junction tới bản đã cài ở checkout chính, thay cho cài lại từng worktree.
// QDYZMY1K (10/11): sau khi lệnh setup được sửa (7fd07aa), mỗi worktree chạy prepare-source của BTC: yarn install
// build lại gói native (esbuild, argon2, bcrypt) 2m58s rồi build cả app 1m23s; 6–7 worktree cùng lúc làm setup kéo
// 5–13 phút, typecheck 229 s, full suite timeout 600 s ở 5/6 item, PI-03 hết giờ trước khi sửa source. Ở OMZJW0S0 lệnh
// setup hỏng ngay ("yarn" không có) nên không tốn gì, fixer tự cài khi cần.
//
// Cách liên kết: mỗi thư mục node_modules của app ở checkout chính (gốc và packages/*/node_modules) có bản tương ứng
// trong worktree là thư mục thật, mỗi mục bên trong là junction:
// - gói bên thứ ba → đúng thư mục đó ở checkout chính (đã cài, đã build native);
// - gói workspace (junction của yarn trỏ vào packages/ của checkout chính) → packages/ tương ứng của worktree, để
//   test, typecheck và build của worktree dùng source của chính nó;
// - thư mục ẩn (.vite, .vite-temp, .vitest-cache, .cache…) tạo rỗng riêng cho worktree, trừ .bin (junction); file ẩn
//   (.yarn-state.yml, .package-map.json) chép sang.
// .yarn/install-state.gz của app cũng được chép, để `yarn run` coi project là đã cài.
//
// CẢNH BÁO: `git worktree remove --force` (và `git clean -x`) đi xuyên junction và xoá file ở thư mục đích (kiểm trên
// git for Windows 10/11: xoá worktree làm mất file của thư mục được junction tới). Luôn gọi unlinkNodeModules trước khi
// xoá worktree; fs.rmSync của Node không đi xuyên junction.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MARKER = '.team-linked.json';
const SKIP = new Set(['.git', 'node_modules', '.team-work', '.codegraph', '.yarn', 'build', 'dist', '.next', 'out', 'coverage']);
const link = (target, path) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };

// Các thư mục node_modules của app (tương đối với gốc app), không đi vào trong node_modules hay thư mục output.
export function moduleDirs(root, rel = '', out = [], depth = 0) {
  let entries;
  try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink?.()) continue;
    const name = rel ? `${rel}/${e.name}` : e.name;
    if (e.name === 'node_modules') out.push(name);
    else if (!SKIP.has(e.name) && !e.name.startsWith('.') && depth < 4) moduleDirs(root, name, out, depth + 1);
  }
  return out;
}

function linkEntry(src, dst, mainRoot, wtRoot) {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) {
    const target = realpathSync(src);
    // Gói workspace: junction của checkout chính trỏ vào source của nó (ngoài node_modules) → source của worktree.
    const mapped = inside(mainRoot, target) && !target.split(sep).includes('node_modules') ? join(wtRoot, relative(mainRoot, target)) : target;
    link(mapped, dst);
    return mapped === target ? 'shared' : 'workspace';
  }
  if (st.isDirectory()) { link(src, dst); return 'shared'; }
  copyFileSync(src, dst);
  return 'copied';
}

// Dựng node_modules liên kết cho worktree. Trả {linked, dirs, entries, workspace} hoặc {linked:false, reason}.
export function linkNodeModules(mainRoot, wtRoot) {
  mainRoot = resolve(mainRoot); wtRoot = resolve(wtRoot);
  const dirs = moduleDirs(mainRoot);
  if (!dirs.includes('node_modules')) return { linked: false, reason: 'main checkout has no node_modules' };
  const counts = { shared: 0, workspace: 0, copied: 0, local: 0 };
  for (const rel of dirs) {
    const from = join(mainRoot, rel), to = join(wtRoot, rel);
    if (existsSync(to)) {
      if (existsSync(join(to, MARKER))) unlinkDir(to);
      else return { linked: false, reason: `${rel} already exists in the worktree (a real install)` };
    }
    // Thư mục package không có trong worktree (bị xoá ở nhánh này): bỏ qua node_modules của nó.
    if (!existsSync(dirname(to))) continue;
    mkdirSync(to);
    for (const e of readdirSync(from, { withFileTypes: true })) {
      const src = join(from, e.name), dst = join(to, e.name);
      if (e.name.startsWith('.') && e.name !== '.bin') {
        if (e.isDirectory() && !e.isSymbolicLink()) { mkdirSync(dst); counts.local++; } else if (e.isFile()) { copyFileSync(src, dst); counts.copied++; }
        continue;
      }
      if (e.name.startsWith('@') && e.isDirectory() && !e.isSymbolicLink()) {
        mkdirSync(dst);
        for (const child of readdirSync(src)) counts[linkEntry(join(src, child), join(dst, child), mainRoot, wtRoot)]++;
        continue;
      }
      counts[linkEntry(src, dst, mainRoot, wtRoot)]++;
    }
    writeFileSync(join(to, MARKER), `${JSON.stringify({ from, at: new Date().toISOString() })}\n`);
  }
  const state = join(mainRoot, '.yarn', 'install-state.gz');
  if (existsSync(state)) { mkdirSync(join(wtRoot, '.yarn'), { recursive: true }); copyFileSync(state, join(wtRoot, '.yarn', 'install-state.gz')); }
  return { linked: true, dirs: dirs.length, entries: counts.shared + counts.workspace, workspace: counts.workspace, local: counts.local };
}

// Gỡ một thư mục node_modules liên kết: gỡ từng junction (không đi vào), xoá phần còn lại của chính worktree.
function unlinkDir(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isSymbolicLink() || lstatSync(path).isSymbolicLink()) { try { unlinkSync(path); } catch { rmSync(path, { force: true }); } continue; }
    if (e.isDirectory()) { unlinkDir(path); continue; }
    rmSync(path, { force: true });
  }
  rmSync(dir, { recursive: true, force: true });
}

// Gỡ mọi node_modules liên kết của worktree (có MARKER). Trả số thư mục đã gỡ.
export function unlinkNodeModules(wtRoot) {
  let n = 0;
  for (const rel of moduleDirs(resolve(wtRoot))) {
    const dir = join(wtRoot, rel);
    if (existsSync(join(dir, MARKER))) { unlinkDir(dir); n++; }
  }
  return n;
}

export const isLinked = wtRoot => existsSync(join(wtRoot, 'node_modules', MARKER));
export const linkedFrom = wtRoot => { try { return JSON.parse(readFileSync(join(wtRoot, 'node_modules', MARKER), 'utf8')).from; } catch { return null; } };

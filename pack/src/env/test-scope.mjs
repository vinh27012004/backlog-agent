// Phạm vi bộ test của run_checks. RATH0OHJ: `yarn test` (lage) chạy mọi workspace của Actual; riêng `web`
// (desktop-client) mất 6m08s dù đề BUG/CR nói "The grader runs the loot-core tests" và item chỉ sửa loot-core, nên
// TASK-08 chờ bộ test cuối 6m43s. Chỉ thu hẹp khi đề nêu tên gói grader chạy và gói đó là một workspace có script
// test; workspace nào có file item sửa cũng được thêm vào. File sửa nằm trong app mà ngoài mọi workspace (config gốc,
// lockfile…) thì chạy cả bộ. Mọi trường hợp khác ("the whole test suite", đề không nêu gì) vẫn chạy cả bộ.
// Từ hai gói trở lên cũng chạy cả bộ: runner của repo (lage) chạy các gói song song, còn lệnh theo gói chạy lần lượt
// (LXRMBRA2 CR-07: core rồi web, 5 + 6 phút, hết 600 s).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const posix = p => p.replaceAll('\\', '/');
const GENERIC = new Set(['whole', 'full', 'unit', 'integration', 'e2e', 'existing', 'original', 'hidden', 'same', 'other', 'own', 'new', 'project']);

// Tên gói trong câu "the grader runs the <name> tests" (không phân biệt hoa thường).
export function namedTestPackages(text) {
  const names = [];
  for (const m of String(text ?? '').matchAll(/\bgrader runs the ([@A-Za-z0-9][\w@/.-]*) tests\b/gi)) {
    const name = m[1].replace(/[.]+$/, '');
    if (!GENERIC.has(name.toLowerCase()) && !names.includes(name)) names.push(name);
  }
  return names;
}

// Workspace của project node theo package.json `workspaces` (mảng hay {packages}) hoặc pnpm-workspace.yaml; chỉ hiểu
// đường dẫn thẳng và `dir/*`. Trả [{dir, name, test}] với dir tương đối root (posix).
export function listWorkspaces(root) {
  const pkg = readJson(join(root, 'package.json'));
  let patterns = Array.isArray(pkg?.workspaces) ? pkg.workspaces : Array.isArray(pkg?.workspaces?.packages) ? pkg.workspaces.packages : null;
  if (!patterns && existsSync(join(root, 'pnpm-workspace.yaml'))) {
    const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
    const block = yaml.match(/^packages:\s*\r?\n((?:[ \t]+-.*\r?\n?)+)/m)?.[1] ?? '';
    patterns = [...block.matchAll(/-\s*['"]?([^'"\r\n#]+?)['"]?\s*(?:#.*)?$/gm)].map(m => m[1].trim());
  }
  const dirs = [];
  for (const raw of patterns ?? []) {
    const p = posix(String(raw)).replace(/^\.\//, '').replace(/\/$/, '');
    if (!p || p.startsWith('!') || p.includes('..')) continue;
    if (p.endsWith('/*') && !p.slice(0, -2).includes('*')) {
      const base = p.slice(0, -2);
      try {
        for (const d of readdirSync(join(root, base), { withFileTypes: true })) if (d.isDirectory()) dirs.push(`${base}/${d.name}`);
      } catch { /* thư mục không có */ }
    } else if (!p.includes('*')) dirs.push(p);
  }
  const out = [];
  for (const dir of [...new Set(dirs)]) {
    const wp = readJson(join(root, dir, 'package.json'));
    if (wp?.name) out.push({ dir, name: wp.name, test: Boolean(wp.scripts?.test) });
  }
  return out;
}

const matches = (ws, token) => {
  const t = token.toLowerCase(), name = ws.name.toLowerCase();
  return name === t || name.endsWith(`/${t}`) || ws.dir.split('/').pop().toLowerCase() === t;
};

function scopedCommand(profile, name) {
  const m = profile.packageManagerCommand ?? profile.packageManager;
  return profile.packageManager === 'yarn' ? `${m} workspace ${quote(name)} test`
    : profile.packageManager === 'pnpm' ? `${m} --filter ${quote(name)} test` : `npm test --workspace=${quote(name)}`;
}

// {packages, command, reason} khi thu hẹp được; null (kèm lý do ở `why`) khi phải chạy cả bộ.
// `changed`: đường dẫn file item sửa, tương đối checkout git (posix); `appPrefix`: đường dẫn app root trong checkout.
export function testScope({ profile, text, changed, appPrefix }) {
  if (profile?.stack !== 'node' || !profile.commands?.test_all || !profile.root) return { scope: null, why: 'not a node workspace project' };
  const named = namedTestPackages(text);
  if (!named.length) return { scope: null, why: 'the item does not name the package the grader tests' };
  const workspaces = listWorkspaces(profile.root);
  const picked = workspaces.filter(ws => ws.test && named.some(t => matches(ws, t)));
  if (!picked.length) return { scope: null, why: `no workspace with a test script matches ${named.join(', ')}` };
  if (!Array.isArray(changed)) return { scope: null, why: 'changed files unknown' };
  const prefix = appPrefix && appPrefix !== '.' ? `${posix(appPrefix).replace(/\/$/, '')}/` : '';
  const added = [];
  for (const file of changed.map(posix)) {
    if (prefix && !file.startsWith(prefix)) continue; // ngoài app (answers/, README của trận…): không đụng tới test
    const rel = file.slice(prefix.length);
    if (/(^|\/)\.codegraph\//.test(rel) || /^[^/]+\.md$/i.test(rel)) continue;
    const ws = workspaces.find(w => rel.startsWith(`${w.dir}/`));
    if (!ws) return { scope: null, why: `${rel} is outside every workspace` };
    if (ws.test && !picked.includes(ws) && !added.includes(ws)) added.push(ws);
  }
  const packages = [...picked, ...added].map(ws => ws.name);
  if (packages.length > 1) return { scope: null, why: `${packages.join(', ')} are in scope: the whole suite runs them in parallel` };
  return { scope: { packages, command: scopedCommand(profile, packages[0]), reason: `the item says the grader runs the ${named.join(', ')} tests` } };
}

export const appPrefixOf = (checkout, profile) => posix(relative(checkout, profile.root)) || '.';

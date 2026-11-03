// Candidate bất biến ở mỗi lần bàn giao; schema và dấu vân tay không phụ thuộc số lần spawn worker.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { validateSchema } from './jsonschema.mjs';
import { contentTree } from './git.mjs';
import { fail } from './util.mjs';
import { unscopedDbText } from '../env/environment.mjs';

export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const schemas = Object.fromEntries(['fix-result'].map(name =>
  [name, JSON.parse(readFileSync(new URL(`../../contracts/${name}.schema.json`, import.meta.url), 'utf8'))]));

export function resultArtifact(dir, file, kind) {
  if (!isAbsolute(file ?? '')) fail('INVALID_ARGUMENT', 'result file must be absolute');
  const rel = relative(resolve(dir), resolve(file));
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || dirname(rel) !== '.') fail('PATH_NOT_ALLOWED', 'result file must be directly inside .team-work/results/');
  let raw;
  try {
    if (relative(realpathSync(dir), realpathSync(file)) !== basename(file)) fail('PATH_NOT_ALLOWED', 'result symlink leaves results directory');
    raw = readFileSync(file, 'utf8');
  } catch (e) { if (e.code === 'PATH_NOT_ALLOWED') throw e; fail('RESULT_INVALID', 'result file is missing or unreadable'); }
  let value;
  try { value = JSON.parse(raw); } catch { fail('RESULT_INVALID', '$: invalid JSON (write to a temporary file, then rename)'); }
  if (!schemas[kind]) fail('INVALID_ARGUMENT', `unknown result contract ${kind}`);
  const errors = validateSchema(value, schemas[kind]);
  if (errors.length) fail('RESULT_INVALID', errors.join('; '));
  return { file: resolve(file), hash: digest(raw), value };
}

// pnpm ghi lại node_modules/.modules.yaml ở mỗi lệnh `pnpm run/test/exec` (đổi prunedAt, thêm/bỏ ignoredBuilds) dù
// dependency y nguyên. Hash cả file thì app vừa start đã "stale" (4D895OVI: EVIDENCE_STALE_APP 4 lần, TASK-03
// GATE_STALE "main environment changed"). Bỏ các khoá đó trước khi hash; pnpm cũ ghi YAML, pnpm mới ghi JSON.
// virtualStoreDir là đường dẫn tuyệt đối của từng checkout (khác nhau ở mọi worktree), không phải trạng thái dependency.
const VOLATILE_PNPM = ['prunedAt', 'ignoredBuilds', 'pendingBuilds', 'virtualStoreDir'];
export function pnpmModulesText(text) {
  try {
    const value = JSON.parse(text);
    for (const k of VOLATILE_PNPM) delete value[k];
    return JSON.stringify(value);
  } catch { /* YAML */ }
  const out = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    if (new RegExp(`^["']?(${VOLATILE_PNPM.join('|')})["']?\\s*:`).test(line)) { skipping = true; continue; }
    if (skipping && /^(\s+|-\s)/.test(line)) continue;
    skipping = false;
    out.push(line);
  }
  return out.join('\n');
}

// Bao gồm cả .env bị gitignore, marker dependency và phiên bản runtime; chỉ hash rời khỏi helper. Phần riêng của từng
// checkout (hậu tố database theo trận/item, virtualStoreDir) không tính: cùng source ở checkout chính và ở worktree cho
// cùng dấu vân tay, nên bản build của app (env/app.mjs) dùng lại được giữa các checkout.
export function environmentFingerprint(matchRoot, profile, epoch = 0) {
  const roots = [...new Set([matchRoot, profile.root].filter(Boolean))];
  const inputs = [];
  for (const root of roots) {
    const names = existsSync(root) ? readdirSync(root).filter(n => /^\.env($|\.)/.test(n)) : [];
    for (const name of [...names, 'node_modules/.package-lock.json', 'node_modules/.modules.yaml']) {
      const file = join(root, name);
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      const raw = readFileSync(file);
      const text = name.endsWith('.modules.yaml') ? pnpmModulesText(raw.toString('utf8'))
        : name.startsWith('.env') ? unscopedDbText(raw.toString('utf8'), basename(matchRoot)) : raw;
      inputs.push([relative(matchRoot, file), digest(text)]);
    }
  }
  return digest({ inputs, node: process.version, platform: process.platform, arch: process.arch,
    commands: profile.commands, epoch, runtimeEnv: Object.fromEntries(['NODE_OPTIONS', 'NODE_ENV', 'CI', 'TZ', 'LANG', 'LC_ALL',
      'JAVA_HOME', 'MAVEN_OPTS', 'DOTNET_ROOT', 'GOFLAGS', 'DATABASE_URL', 'TEST_DATABASE_URL'].map(k => [k, process.env[k] ?? null])) });
}

// challenge/ là file BTC phát (MVS, seed, script kiểm), không chạy trong app: worker chép chúng vào worktree sau khi
// start app không làm app cũ đi (J56ZZWSS CR-01: EVIDENCE_STALE_APP chỉ vì challenge/CR-01-*.md, phải start lại app).
export async function sourceSnapshot(checkoutRoot, folder, profile, epoch = 0) {
  return { source: await contentTree(checkoutRoot, folder, [`${folder}/answers`, `${folder}/challenge`]),
    environment: environmentFingerprint(join(checkoutRoot, folder), profile, epoch) };
}

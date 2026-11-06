// Cache tải package dùng chung; proof setup chỉ thuộc một bản sao, không chia sẻ node_modules.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { childEnv, runPwsh } from '../core/jobs.mjs';
import { git } from '../core/git.mjs';
import { writeFileAtomic } from '../core/util.mjs';

const hash = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const json = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const OUTPUTS = new Set(['.next', 'build', 'dist', 'out']);
const SKIP = new Set(['.git', 'node_modules', '.team-work', '.codegraph', '.cache', 'coverage']);

export function packageCache(profile, cacheDir) {
  if (profile.stack !== 'node' || !cacheDir) return { env: childEnv(), directory: null };
  const pkg = json(join(profile.root, 'package.json'));
  const major = Number(profile.packageManagerCommand?.match(/yarn-(\d+)\./)?.[1]
    ?? pkg?.packageManager?.match(/@(\d+)/)?.[1] ?? 1);
  const directory = resolve(cacheDir, `${profile.packageManager}-${major}`);
  mkdirSync(directory, { recursive: true });
  const extra = profile.packageManager === 'yarn'
    ? major >= 2 ? { YARN_GLOBAL_FOLDER: directory, YARN_ENABLE_MIRROR: 'true' } : { YARN_CACHE_FOLDER: directory }
    : profile.packageManager === 'pnpm'
      ? { [major >= 11 ? 'pnpm_config_store_dir' : 'npm_config_store_dir']: directory }
      : { npm_config_cache: directory };
  return { env: childEnv(extra), directory };
}

function walk(root, { outputs = false } = {}, rel = '', files = []) {
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name) || name === '.yarn/cache' || outputs && entry.name === 'cache') continue;
      if (!outputs && OUTPUTS.has(entry.name)) continue;
      walk(root, { outputs }, name, files);
    } else if (entry.isFile()) files.push(name);
  }
  return files;
}

async function sourceFiles(root) {
  const res = await git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], { cwd: root, allowFail: true });
  return res.code === 0 && res.stdout.length < 1_000_000
    ? [...new Set(res.out.split('\0').filter(Boolean))].sort() : walk(root).sort();
}

function fileHashes(root, names) {
  return names.map(name => [name, existsSync(join(root, name)) ? hash(readFileSync(join(root, name))) : null]);
}

// Manifest workspace, lock/config, package manager đóng gói và patch đều ảnh hưởng install.
export const setupInputFile = name => /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|\.npmrc|\.yarnrc(?:\.yml)?|\.?pnpmfile\.(?:cjs|mjs)|yarn\.config\.cjs|\.pnp\.cjs)$/.test(name)
  || /(^|\/)(?:\.yarn\/(?:releases|plugins|patches)|patches|prisma)\//.test(name)
  || /(^|\/)env-require\//.test(name);

async function input(profile, matchRoot, name, command, cacheDirectory) {
  try {
    const files = await sourceFiles(profile.root);
    const manifests = files.filter(f => basename(f) === 'package.json').map(f => json(join(profile.root, f)));
    // Hook install và file dependency có thể đọc source tùy ý: không đoán rằng chỉ manifest là đủ.
    const sourceSensitive = name !== 'install' || files.some(f => /(^|\/)(?:\.?pnpmfile\.(?:cjs|mjs)|yarn\.config\.cjs)$|(^|\/)\.yarn\/plugins\//.test(f)) || manifests.some(p =>
      ['preinstall', 'install', 'postinstall', 'prepare'].some(k => p?.scripts?.[k])
      || Object.values({ ...p?.dependencies, ...p?.devDependencies, ...p?.optionalDependencies, ...p?.peerDependencies })
        .some(v => /^(?:file|link):/.test(v)));
    const chosen = sourceSensitive ? files : files.filter(setupInputFile);
    const envFiles = [...new Set([profile.root, matchRoot])].flatMap(root => readdirSync(root)
      .filter(n => /^\.env($|\.)/.test(n) && statSync(join(root, n)).isFile())
      .map(n => [relative(matchRoot, join(root, n)), hash(readFileSync(join(root, n)))]));
    // Script BTC nằm ngoài src, luôn phải tham gia proof (kể cả khi không nằm trong git).
    const materials = join(matchRoot, 'env-require');
    const scripts = existsSync(materials) ? fileHashes(materials, walk(materials).sort()) : [];
    return hash({ files: fileHashes(profile.root, chosen), scripts,
      envFiles, command, cacheDirectory, node: process.version, platform: process.platform, arch: process.arch,
      runtime: Object.fromEntries(['NODE_ENV', 'NODE_OPTIONS', 'CI', 'TZ'].map(k => [k, process.env[k] ?? null])) });
  } catch { return null; } // Không đủ dữ liệu để chứng minh: chạy thật.
}

function dependencies(profile) {
  try {
    const pkg = json(join(profile.root, 'package.json'));
    const names = Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies }).sort();
    if (existsSync(join(profile.root, '.pnp.cjs'))) return null; // PnP cần kiểm tra archive khác node_modules.
    const files = names.map(n => `node_modules/${n}/package.json`);
    if (files.some(f => !existsSync(join(profile.root, f)))) return null;
    const modules = [];
    function scan(rel = '') {
      for (const entry of readdirSync(join(profile.root, rel), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const name = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.name === 'node_modules') {
          modules.push([name, 'directory']);
          for (const pkg of readdirSync(join(profile.root, name))) {
            if (pkg.startsWith('.')) continue;
            const packages = pkg.startsWith('@') ? readdirSync(join(profile.root, name, pkg)).map(p => `${pkg}/${p}`) : [pkg];
            for (const p of packages) {
              const manifest = `${name}/${p}/package.json`;
              modules.push(...fileHashes(profile.root, [manifest]));
            }
          }
        } else if (!SKIP.has(entry.name) && !OUTPUTS.has(entry.name) && entry.name !== '.yarn') scan(name);
      }
    }
    scan();
    return hash({ required: fileHashes(profile.root, files), modules: modules.sort((a, b) => a[0].localeCompare(b[0])) });
  } catch { return null; }
}

function artifacts(root) {
  try {
    const files = [];
    function scan(rel = '') {
      for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
        if (!entry.isDirectory() || SKIP.has(entry.name) || entry.name === '.yarn') continue;
        const name = rel ? `${rel}/${entry.name}` : entry.name;
        if (OUTPUTS.has(entry.name)) files.push(...walk(root, { outputs: true }, name));
        else scan(name);
      }
    }
    scan();
    return files.length ? hash(fileHashes(root, files.sort())) : null;
  } catch { return null; }
}

const pending = new Map();
export function preparedStep(job, name, command, opts, { profile, matchRoot, logDir, cacheDirectory }) {
  const key = `${resolve(profile.root)}:${name}:${hash({ command, cacheDirectory })}`;
  if (pending.has(key)) return pending.get(key);
  const promise = runStep(job, name, command, opts, { profile, matchRoot, logDir, cacheDirectory })
    .finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

async function runStep(job, name, command, opts, { profile, matchRoot, logDir, cacheDirectory }) {
  const cacheable = profile.stack === 'node' && ['install', 'prepare-source', 'prepare_source', 'build'].includes(name);
  const file = join(logDir, 'setup-cache', `${hash(resolve(profile.root))}.json`);
  const saved = json(file);
  const state = saved?.version === 1 && saved.steps && typeof saved.steps === 'object' && !Array.isArray(saved.steps)
    ? saved : { version: 1, steps: {} };
  const before = cacheable ? await input(profile, matchRoot, name, command, cacheDirectory) : null;
  const installed = before ? dependencies(profile) : null;
  const built = before && name !== 'install' ? artifacts(profile.root) : null;
  const old = state.steps[name];
  if (before && installed && (name === 'install' || built) && old?.input === before
    && old.dependencies === installed && old.artifacts === built) {
    job.progress.push(`${name}: reused (inputs, dependencies${built ? ', build artifacts' : ''} unchanged)`);
    return { code: 0, ms: 0, cached: true, timedOut: false, tail: 'Reused successful setup of this worktree.' };
  }
  // Xóa proof trước khi chạy: lỗi/timeout không được giữ PASS của lần trước.
  if (cacheable) { delete state.steps[name]; writeFileAtomic(file, JSON.stringify(state)); }
  job.progress.push(`${name}: running`);
  const res = await runPwsh(command, opts);
  job.progress.push(`${name}: ${res.code === 0 ? 'ok' : `exit ${res.code}`} (${Math.round(res.ms / 1000)}s)`);
  if (cacheable && res.code === 0 && !res.timedOut && before) {
    const after = await input(profile, matchRoot, name, command, cacheDirectory);
    const dep = dependencies(profile), output = name === 'install' ? null : artifacts(profile.root);
    if (after === before && dep && (name === 'install' || output)) {
      state.steps[name] = { input: after, dependencies: dep, artifacts: output, at: new Date().toISOString() };
      writeFileAtomic(file, JSON.stringify(state));
    }
  }
  return res;
}

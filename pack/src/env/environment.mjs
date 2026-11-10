// Nhận diện stack (port rút gọn của orchestrator/profile.py) và chuẩn bị môi trường (05 §5.3).
// Repo của BTC có thể kèm env-require/ (README, doctor.ps1...): khi có thì doctor.ps1 là thước đo READY.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { git, restoreTracked, statusChanged } from '../core/git.mjs';
import { run } from '../core/jobs.mjs';
import { baselineOf, runTests } from './testreport.mjs';
import { randomSecret } from '../core/util.mjs';
import { packageCache, preparedStep, setupInputFile } from './setup-cache.mjs';
import { isLinked, linkNodeModules, unlinkNodeModules } from './linked-modules.mjs';

export { failingTests, parseTestCounts } from './testreport.mjs';

const MANIFESTS = ['package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'pyproject.toml',
  'requirements.txt', 'go.mod', 'composer.json'];

function hasManifest(dir) {
  if (!existsSync(dir)) return false;
  if (MANIFESTS.some(m => existsSync(join(dir, m)))) return true;
  try { return readdirSync(dir).some(f => /\.(sln|csproj)$/i.test(f)); } catch { return false; }
}

export function findAppRoot(matchRoot) {
  for (const sub of ['', 'src', 'app', 'backend', 'server', 'web']) {
    const dir = sub ? join(matchRoot, sub) : matchRoot;
    if (hasManifest(dir)) return dir;
  }
  return null;
}

const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

// Yarn của repo không cần Corepack/global shim. Giữ tên manager riêng để chọn cờ reporter của npm.
function yarnCommand(root, packageManager) {
  let yarnPath;
  try {
    const scalar = readFileSync(join(root, '.yarnrc.yml'), 'utf8').match(/^yarnPath:[ \t]*(.*)$/m)?.[1]?.trim();
    if (scalar?.startsWith('"')) yarnPath = JSON.parse(scalar.match(/^"(?:[^"\\]|\\.)*"/)?.[0] ?? 'null');
    else if (scalar?.startsWith("'")) yarnPath = scalar.match(/^'((?:[^']|'')*)'/)?.[1]?.replaceAll("''", "'");
    else if (scalar && !/^(?:false|null|~)(?:\s|$)/.test(scalar)) yarnPath = scalar.replace(/\s+#.*$/, '').trim();
  } catch { /* Không có yarnrc hoặc scalar không hợp lệ: tìm release được đóng gói. */ }
  if (!yarnPath) {
    try {
      const releases = readdirSync(join(root, '.yarn', 'releases')).filter(f => /^yarn-.*\.(?:cjs|js)$/.test(f));
      const pinned = packageManager?.match(/^yarn@([^+]+)/)?.[1];
      const file = releases.find(f => f === `yarn-${pinned}.cjs` || f === `yarn-${pinned}.js`)
        ?? releases.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))[0];
      if (file) yarnPath = `.yarn/releases/${file}`;
    } catch { /* Repo dùng Yarn trên PATH. */ }
  }
  const major = Number(yarnPath?.match(/yarn-(\d+)\./)?.[1] ?? packageManager?.match(/^yarn@(\d+)/)?.[1] ?? 1);
  return { command: yarnPath ? `node ${quote(yarnPath.replaceAll('\\', '/'))}` : 'yarn', major };
}

export function detectProfile(matchRoot) {
  const root = findAppRoot(matchRoot);
  if (!root) return { root: null, stack: 'unknown', commands: {} };
  const rel = relative(matchRoot, root).replaceAll('\\', '/') || '.';
  const pkg = readJson(join(root, 'package.json'));
  if (pkg) {
    const pm = pkg.packageManager?.split('@')[0] ??
      (existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm'
        : ['yarn.lock', '.yarnrc.yml', '.yarn/releases'].some(p => existsSync(join(root, p))) ? 'yarn' : 'npm');
    const scripts = pkg.scripts ?? {};
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const yarn = pm === 'yarn' ? yarnCommand(root, pkg.packageManager) : null;
    const manager = yarn?.command ?? pm;
    const install = pm === 'pnpm' ? `${manager} install --frozen-lockfile`
      : pm === 'yarn' ? `${manager} install ${yarn.major >= 2 ? '--immutable' : '--frozen-lockfile'}` : 'npm ci';
    const prepareSource = join(matchRoot, 'env-require', 'prepare-source.ps1');
    const runner = deps.vitest ? 'vitest' : deps.jest ? 'jest' : null;
    return {
      root, relRoot: rel, stack: 'node', packageManager: pm, packageManagerCommand: manager, testRunner: runner, testScript: scripts.test ?? null,
      prisma: Boolean(deps.prisma || deps['@prisma/client']),
      // Gate chạy build song song với test, trừ khi script test tự build (pretest, "build && jest") hay đọc thứ build ra.
      parallelBuild: Boolean(scripts.build) && !scripts.pretest && !/\bbuild\b|\bdist\b/.test(scripts.test ?? ''),
      commands: {
        install,
        prepare_source: existsSync(prepareSource) ? `& ${quote(`./${relative(root, prepareSource).replaceAll('\\', '/')}`)}` : null,
        build: scripts.build ? `${manager} run build` : null,
        typecheck: scripts.typecheck ? `${manager} run typecheck` : null,
        test_all: scripts.test ? `${manager} test` : null,
        test_one: runner === 'vitest' ? `${manager} exec vitest run {target}` : runner === 'jest' ? `${manager} exec jest {target}` : null,
        run_app: scripts.start ? `${manager} run start` : scripts.dev ? `${manager} run dev` : null,
        // postinstall của @prisma/client có thể chạy trước khi CLI được link (pnpm), nên generate riêng.
        generate: deps.prisma ? `${manager} exec prisma generate` : null,
        migrate: deps.prisma ? `${manager} exec prisma migrate deploy` : null,
        seed: scripts['db:seed'] ? `${manager} run db:seed` : null
      },
      forbiddenSkip: ['.skip(', '.only(', 'xit(', 'xdescribe(', 'test.todo(']
    };
  }
  if (existsSync(join(root, 'pom.xml'))) {
    const mvn = existsSync(join(root, 'mvnw.cmd')) ? '.\\mvnw.cmd' : 'mvn';
    return { root, relRoot: rel, stack: 'java-maven', commands: { install: `${mvn} -q -DskipTests dependency:go-offline`,
      build: `${mvn} -q -DskipTests package`, test_all: `${mvn} -q test`, test_one: `${mvn} -q test -Dtest={target}` },
    forbiddenSkip: ['@Disabled', '@Ignore'] };
  }
  if (existsSync(join(root, 'build.gradle')) || existsSync(join(root, 'build.gradle.kts'))) {
    const g = existsSync(join(root, 'gradlew.bat')) ? '.\\gradlew.bat' : 'gradle';
    return { root, relRoot: rel, stack: 'java-gradle', commands: { install: `${g} -q dependencies`,
      build: `${g} -q assemble`, test_all: `${g} -q test`, test_one: `${g} -q test --tests {target}` },
    forbiddenSkip: ['@Disabled', '@Ignore'] };
  }
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'requirements.txt'))) {
    return { root, relRoot: rel, stack: 'python', commands: {
      install: existsSync(join(root, 'requirements.txt')) ? 'python -m pip install -r requirements.txt' : 'python -m pip install -e .',
      build: 'python -m compileall -q .', test_all: 'python -m pytest -q', test_one: 'python -m pytest -q {target}' },
    forbiddenSkip: ['@pytest.mark.skip', '@unittest.skip'] };
  }
  if (existsSync(join(root, 'go.mod'))) {
    return { root, relRoot: rel, stack: 'go', commands: { install: 'go mod download', build: 'go build ./...',
      test_all: 'go test ./...', test_one: 'go test ./... -run {target}' }, forbiddenSkip: ['t.Skip('] };
  }
  if (existsSync(join(root, 'composer.json'))) {
    return { root, relRoot: rel, stack: 'php', commands: { install: 'composer install --no-interaction',
      build: null, test_all: 'vendor/bin/phpunit', test_one: 'vendor/bin/phpunit --filter {target}' }, forbiddenSkip: ['markTestSkipped'] };
  }
  return { root, relRoot: rel, stack: 'dotnet', commands: { install: 'dotnet restore', build: 'dotnet build --no-restore',
    test_all: 'dotnet test --no-build', test_one: 'dotnet test --no-build --filter {target}' }, forbiddenSkip: ['[Ignore', 'Skip ='] };
}

// Điền .env từ .env.example: placeholder CHANGE_ME trong URL lấy mật khẩu DB của máy,
// biến kiểu SECRET/KEY/TOKEN sinh ngẫu nhiên. Không bao giờ ghi đè .env đã có.
const PLACEHOLDER = /CHANGE_ME|changeme|<[^>]+>/;

// Thêm hậu tố vào tên DB của TEST_DATABASE_URL (không thêm lần hai). Test DB phải mới theo trận: DB cùng tên còn lại
// từ trận trước giữ schema cũ mà `migrate deploy` báo "No pending migrations" (Practice #5 BC3JL6ZC: test DB của
// BUG-01/TASK-01 còn FK CASCADE, gate báo regression sai hai lần).
const dbUrlLine = name => new RegExp(`^(\\s*${name}\\s*=\\s*["']?[^"'\\s?]*?\\/)([A-Za-z0-9_]+)(?=["'?\\s]|$)`, 'm');

export const scopedDb = (text, name, suffix) => text.replace(dbUrlLine(name),
  (m, pre, db) => `${pre}${db.endsWith(suffix) ? db : db + suffix}`);

export const scopedTestDb = (text, suffix) => scopedDb(text, 'TEST_DATABASE_URL', suffix);

// Tên database trong dòng `<name>=...` của .env, null khi không có hoặc không phải URL có tên DB.
export const dbNameOf = (text, name = 'DATABASE_URL') => text.match(dbUrlLine(name))?.[2] ?? null;

export const dbSuffix = name => `_${String(name).toLowerCase().replace(/[^a-z0-9]/g, '')}`;

// Bỏ hậu tố trận/item mà helper gắn vào tên database (`_<trận>`, `_<trận>_<item>`) ở DATABASE_URL và TEST_DATABASE_URL,
// cho dấu vân tay môi trường: checkout chính và mỗi worktree chỉ khác nhau ở phần này (NBDB5U0O: PI-01, TASK-03, TASK-04
// cùng source tree mà mỗi item vẫn chạy một gate đầy đủ 52–69 s vì không khớp proof nào). Tên database gốc vẫn được tính.
export function unscopedDbText(text, matchName) {
  const match = dbSuffix(matchName);
  return ['DATABASE_URL', 'TEST_DATABASE_URL'].reduce((out, name) => out.replace(dbUrlLine(name), (line, pre, db) => {
    const at = db.lastIndexOf(match);
    return at > 0 && /^(_[a-z0-9]+)?$/.test(db.slice(at + match.length)) ? `${pre}${db.slice(0, at)}` : line;
  }), text);
}

// .env của worktree chép từ checkout chính: TEST_DATABASE_URL luôn có hậu tố trận + item; DATABASE_URL cũng vậy khi
// `appDatabase` (stack tự migrate được, xem prepareWorktreeEnv). Không còn chung database dev: seed của BTC xoá rồi tạo
// lại dữ liệu (CR-01 "deletes every invoice"), nên trước đây mọi item phải xếp hàng sau khoá app_data (Practice
// NBDB5U0O: chờ khoá tổng ~11 phút, BUG-01 riêng 5 phút).
export function worktreeEnvText(mainText, { matchName, key, appDatabase }) {
  const match = dbSuffix(matchName), item = dbSuffix(key);
  const scope = (text, name) => dbNameOf(text, name)?.endsWith(match + item) ? text : scopedDb(scopedDb(text, name, match), name, item);
  const text = scope(mainText, 'TEST_DATABASE_URL');
  return appDatabase ? scope(text, 'DATABASE_URL') : text;
}

export function fillEnvFile(appRoot, machine, { testDbSuffix = null } = {}) {
  const example = join(appRoot, '.env.example');
  const target = join(appRoot, '.env');
  if (!existsSync(example)) return { created: false, reason: 'no .env.example' };
  if (existsSync(target)) return { created: false, reason: '.env exists' };
  const unresolved = [];
  const lines = readFileSync(example, 'utf8').split(/\r?\n/).map(line => {
    const m = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!m) return line;
    const [, pre, key, eq, rawValue] = m;
    if (machine?.env && Object.hasOwn(machine.env, key)) return `${pre}${key}${eq}"${machine.env[key]}"`;
    if (!PLACEHOLDER.test(rawValue)) return line;
    if (/SECRET|_KEY$|TOKEN|SALT/i.test(key)) return `${pre}${key}${eq}"${randomSecret(33)}"`;
    if (/URL$/i.test(key) && machine?.databasePassword) {
      return `${pre}${key}${eq}${rawValue.replace(PLACEHOLDER, encodeURIComponent(machine.databasePassword))}`;
    }
    unresolved.push(key);
    return line;
  });
  const text = lines.join('\n');
  writeFileSync(target, testDbSuffix ? scopedTestDb(text, testDbSuffix) : text, 'utf8');
  return { created: true, unresolved };
}

export function readMachineConfig(localDir) {
  return readJson(join(localDir, 'machine.json')) ?? {};
}

const lastLines = (text, n = 8) => String(text).trim().split(/\r?\n/).slice(-n).join('\n');

// Môi trường cho worktree của một item: .env chép từ checkout chính (gitignored nên worktree không có) với test DB
// và (khi stack có lệnh migrate) database dev riêng theo trận và item, rồi cài dependency + generate, rồi migrate +
// seed database riêng đó (`prisma migrate deploy` tự tạo database chưa có). Probe chỉ chạy test: `appDatabase: false`.
// Worktree dùng được node_modules liên kết tới checkout chính (linked-modules.mjs) khi: stack node, không có bước
// generate (Prisma sinh client vào node_modules, dùng chung thì generate của worktree đè lên checkout chính), checkout
// chính đã cài, và các file quyết định dependency (package.json, lock, .yarnrc…) của worktree như bản BTC phát (bản
// checkout chính đã cài). Trả null khi được, hoặc lý do không được.
export async function linkBlocker(profile, main, issuedRevision) {
  if (profile.stack !== 'node') return `stack ${profile.stack}`;
  if (profile.commands.generate) return 'the stack generates into node_modules';
  if (!main.root || !existsSync(join(main.root, 'node_modules'))) return 'main checkout is not installed';
  if (!issuedRevision) return 'no issued revision to compare dependency files with';
  const diff = await git(['diff', '--name-only', issuedRevision, '--', '.'], { cwd: profile.root, allowFail: true });
  if (diff.code !== 0) return 'git diff failed';
  const changed = diff.out.split(/\r?\n/).filter(Boolean).filter(setupInputFile);
  return changed.length ? `dependency files changed: ${changed.slice(0, 3).join(', ')}` : null;
}

export async function prepareWorktreeEnv(job, { wtMatchRoot, mainMatchRoot, key, logDir, appDatabase = true, cacheDir = join(logDir, 'package-cache'),
  linked = false, issuedRevision = null }) {
  const profile = detectProfile(wtMatchRoot);
  const main = detectProfile(mainMatchRoot);
  const out = { profile: { stack: profile.stack, root: profile.relRoot }, steps: [] };
  if (!profile.root) return { ...out, ok: false, failure: 'no application manifest in worktree' };
  // QDYZMY1K: prepare-source (install + build cả app) cho từng worktree mất 5–13 phút khi 6–7 worktree chạy cùng lúc.
  // Liên kết node_modules của checkout chính mất dưới 1 s; build để run_checks và app start làm khi cần.
  let linkedModules = null;
  if (linked) {
    const blocker = await linkBlocker(profile, main, issuedRevision).catch(e => String(e?.message ?? e));
    if (!blocker) {
      const t0 = Date.now();
      const res = (() => { try { return linkNodeModules(main.root, profile.root); } catch (e) { unlinkNodeModules(profile.root); return { linked: false, reason: String(e?.message ?? e) }; } })();
      out.steps.push({ name: 'link-modules', ...res, seconds: Math.round((Date.now() - t0) / 1000) });
      if (res.linked) linkedModules = res;
    } else out.steps.push({ name: 'link-modules', linked: false, reason: blocker });
  }
  // Cài thật vào worktree từng liên kết: gỡ junction trước, kẻo install ghi xuyên sang checkout chính.
  if (!linkedModules && isLinked(profile.root)) unlinkNodeModules(profile.root);
  const cache = packageCache(profile, cacheDir);
  out.packageCache = cache.directory;
  const context = { profile, matchRoot: wtMatchRoot, logDir, cacheDirectory: cache.directory };
  const c = profile.commands;
  const mainEnv = main.root ? join(main.root, '.env') : null;
  const wtEnv = join(profile.root, '.env');
  let fresh = false;
  if (mainEnv && existsSync(mainEnv) && !existsSync(wtEnv)) {
    // Thư mục trận mang tên matchId; .env chính tạo trước bản sửa này chưa có hậu tố trận thì thêm ở đây.
    const text = worktreeEnvText(readFileSync(mainEnv, 'utf8'), { matchName: basename(mainMatchRoot), key,
      appDatabase: appDatabase && Boolean(c.migrate) });
    writeFileSync(wtEnv, text, 'utf8');
    fresh = true;
    out.steps.push({ name: 'env-file', copied: true, testDatabaseSuffix: dbSuffix(key) });
  }
  const own = dedicatedAppDatabase(wtMatchRoot, mainMatchRoot);
  out.database = own ? { name: own, dedicated: true } : { dedicated: false };
  const names = [...(linkedModules ? [] : [c.prepare_source ? 'prepare_source' : 'install']), 'generate', ...(own ? ['migrate', 'seed'] : [])];
  if (linkedModules) out.linkedModules = true;
  for (const name of names) {
    // Seed khi .env vừa tạo hoặc migrate vừa tạo database (đã bị dropWorktreeDatabases xoá sau push rồi dùng lại).
    if (!c[name] || name === 'seed' && !fresh && !out.steps.some(s => s.name === 'migrate' && s.created)) continue;
    const res = await preparedStep(job, name, c[name], { cwd: profile.root, env: cache.env,
      timeoutMs: name === 'prepare_source' ? 600_000 : 300_000, logFile: join(logDir, `${key}-worktree-${name}.log`) }, context);
    out.steps.push({ name, code: res.code, seconds: Math.round(res.ms / 1000), ...(res.cached ? { cached: true } : {}), ...(res.code && name === 'seed' ? { tail: lastLines(res.tail, 4) } : {}),
      ...(name === 'migrate' && /database\b.*\bcreated\b/i.test(res.tail) ? { created: true } : {}) });
    // Seed lỗi không chặn worktree (như setupEnvironment): MVS thường có seed riêng của BTC.
    if (res.code !== 0 && name !== 'seed') return { ...out, ok: false, failure: lastLines(res.tail) };
  }
  return { ...out, ok: true };
}

// URL của dòng `<name>=...` trong .env (null khi không có).
const dbUrlOf = (text, name) => text.match(new RegExp(`^\\s*${name}\\s*=\\s*["']?([^"'\\s]+)`, 'm'))?.[1] ?? null;

// Xoá database dev riêng và test DB của worktree item sau khi item đã push (evidence đã chụp, gate đã chạy, không ai
// dùng nữa). Chỉ xoá tên khác database của checkout chính, chỉ PostgreSQL. Chạy Prisma CLI đã cài ở checkout chính
// trên database quản trị `postgres`; WITH (FORCE) ngắt kết nối còn sót (app, Prisma Studio).
export async function dropWorktreeDatabases({ wtMatchRoot, mainMatchRoot, logFile = null }) {
  const own = findAppRoot(wtMatchRoot), main = findAppRoot(mainMatchRoot);
  const cli = main ? join(main, 'node_modules', 'prisma', 'build', 'index.js') : null;
  if (!own || !cli || !existsSync(cli) || !existsSync(join(own, '.env')) || !existsSync(join(main, '.env'))) {
    return { dropped: [], skipped: 'no worktree .env or Prisma CLI' };
  }
  const wtText = readFileSync(join(own, '.env'), 'utf8'), mainText = readFileSync(join(main, '.env'), 'utf8');
  const dropped = [], failed = [];
  for (const name of ['DATABASE_URL', 'TEST_DATABASE_URL']) {
    const db = dbNameOf(wtText, name);
    if (!db || db === dbNameOf(mainText, name)) continue;
    let admin;
    try { admin = new URL(dbUrlOf(wtText, name)); } catch { continue; }
    if (!/^postgres(ql)?:$/.test(admin.protocol)) continue;
    admin.pathname = '/postgres';
    const res = await run(process.execPath, [cli, 'db', 'execute', '--url', admin.toString(), '--stdin'],
      { cwd: main, input: `DROP DATABASE IF EXISTS "${db}" WITH (FORCE);`, timeoutMs: 60_000, logFile });
    (res.code === 0 ? dropped : failed).push(res.code === 0 ? db : { db, tail: lastLines(res.tail, 3) });
  }
  return { dropped, ...(failed.length ? { failed } : {}) };
}

// Database dev của app trong worktree item có riêng không (khác database của checkout chính).
export function dedicatedAppDatabase(wtMatchRoot, mainMatchRoot) {
  const own = findAppRoot(wtMatchRoot), main = findAppRoot(mainMatchRoot);
  if (!own || !main || !existsSync(join(own, '.env')) || !existsSync(join(main, '.env'))) return null;
  const name = dbNameOf(readFileSync(join(own, '.env'), 'utf8'));
  return name && name !== dbNameOf(readFileSync(join(main, '.env'), 'utf8')) ? name : null;
}

// Job setup_environment. `report(stage, status, summary)` ghi PREPARATION_STATUS.
export async function setupEnvironment(job, { matchRoot, localDir, logDir, report, deadlineAt, baselineMs = 240_000, cacheDir = join(localDir, 'package-cache') }) {
  const profile = detectProfile(matchRoot);
  const out = { profile: { stack: profile.stack, root: profile.relRoot, packageManager: profile.packageManager ?? null,
    testRunner: profile.testRunner ?? null, commands: profile.commands }, steps: [], build: 'FAIL', baseline: null, doctor: null };
  const log = name => join(logDir, `prepare-${name}.log`);
  const remaining = () => Math.max(30_000, deadlineAt - Date.now());

  report('ENVIRONMENT', 'IN_PROGRESS', `Preparing ${profile.stack} environment.`);
  if (!profile.root) {
    report('ENVIRONMENT', 'FAILED', 'No application manifest found in the match folder.');
    return out;
  }
  const cwd = profile.root;
  const cache = packageCache(profile, cacheDir);
  out.packageCache = cache.directory;
  const step = (name, command, opts) => preparedStep(job, name, command, { ...opts, env: cache.env },
    { profile, matchRoot, logDir, cacheDirectory: cache.directory });
  const machine = readMachineConfig(localDir);
  const env = fillEnvFile(cwd, machine, { testDbSuffix: dbSuffix(basename(matchRoot)) });
  out.steps.push({ name: 'env-file', ...env });

  const c = profile.commands;
  const installStep = c.prepare_source ? 'prepare-source' : 'install';
  const install = await step(installStep, c.prepare_source ?? c.install,
    { cwd, timeoutMs: Math.min(remaining(), c.prepare_source ? 600_000 : 300_000), logFile: log(installStep) });
  out.steps.push({ name: installStep, code: install.code, seconds: Math.round(install.ms / 1000), ...(install.cached ? { cached: true } : {}) });
  if (install.code !== 0) {
    out.failure = lastLines(install.tail);
    report('ENVIRONMENT', 'FAILED', c.prepare_source ? 'env-require prepare-source failed.' : 'Dependency installation failed.');
    return out;
  }
  for (const name of ['generate', 'migrate', 'seed']) {
    if (!c[name]) continue;
    const res = await step(name, c[name], { cwd, timeoutMs: 120_000, logFile: log(name) });
    out.steps.push({ name, code: res.code, seconds: Math.round(res.ms / 1000), ...(res.code ? { tail: lastLines(res.tail, 4) } : {}) });
    if (res.code !== 0 && name !== 'seed') {
      out.failure = lastLines(res.tail);
      report('ENVIRONMENT', 'FAILED', `${name} failed.`);
      return out;
    }
  }
  // Doctor có thể kiểm tra cả artifact build: script BTC (hoặc build suy ra) phải chạy trước.
  report('BUILD', 'IN_PROGRESS', c.prepare_source ? 'Application built by env-require prepare-source.' : 'Building the application.');
  if (!c.prepare_source && c.build) {
    const build = await step('build', c.build, { cwd, timeoutMs: Math.min(remaining(), 300_000), logFile: log('build') });
    out.steps.push({ name: 'build', code: build.code, seconds: Math.round(build.ms / 1000), ...(build.cached ? { cached: true } : {}) });
    if (build.code !== 0) {
      out.failure = lastLines(build.tail);
      report('BUILD', 'FAILED', 'Build failed.');
      return out;
    }
  }
  const doctor = join(matchRoot, 'env-require', 'doctor.ps1');
  if (existsSync(doctor)) {
    // -Output ra ngoài repo: mặc định doctor ghi env-require/environment-report.json, gate coi là thay đổi cấm.
    const reportFile = join(logDir, 'environment-report.json').replaceAll("'", "''");
    const res = await step('doctor', `& '${doctor.replaceAll("'", "''")}' -SourceDir '${cwd.replaceAll("'", "''")}' -Output '${reportFile}'`,
      { cwd: join(matchRoot, 'env-require'), timeoutMs: 120_000, logFile: log('doctor') });
    out.doctor = res.code === 0 && /Environment status:\s*READY/.test(res.tail) ? 'READY' : 'NOT_READY';
    out.steps.push({ name: 'doctor', code: res.code, status: out.doctor, ...(out.doctor !== 'READY' ? { tail: lastLines(res.tail, 10) } : {}) });
    if (out.doctor !== 'READY') {
      report('ENVIRONMENT', 'FAILED', 'env-require doctor reports NOT_READY.');
      return out;
    }
  }
  report('ENVIRONMENT', 'COMPLETED', `${profile.stack} toolchain and dependencies ready${out.doctor ? '; doctor READY' : ''}.`);

  out.build = 'PASS';
  if (c.test_all) {
    const budget = Math.min(baselineMs, Math.max(30_000, deadlineAt - Date.now() - 60_000));
    // Có reporter máy đọc thì baseline giữ trạng thái từng test (gate so test fail mới / test biến mất theo id).
    job.progress.push('baseline-tests: running');
    const before = await statusChanged(matchRoot);
    const run = await runTests(profile, 'test_all', { logFile: log('baseline-tests'), timeoutMs: budget });
    job.progress.push(`baseline-tests: ${run.res.code === 0 ? 'ok' : `exit ${run.res.code}`} (${Math.round(run.res.ms / 1000)}s, ${run.source})`);
    out.baseline = baselineOf(run);
    // Baseline tests chạy trên checkout chính, nơi publish cherry-pick vào: file đã track mà test ghi lại (vitest ghi
    // lại *.snap bằng LF khi checkout là CRLF, practice 85WTXFLQ) phải về như bản phát, nếu không main bẩn cả trận.
    if (before) {
      const touched = ((await statusChanged(matchRoot)) ?? []).filter(f => !before.includes(f));
      if (touched.length) {
        await restoreTracked(matchRoot, touched);
        out.restoredAfterTests = touched;
        job.progress.push(`baseline-tests: restored ${touched.length} tracked file(s) the tests rewrote`);
      }
    }
  }
  const b = out.baseline;
  const note = !b ? 'no test command' : b.status === 'TIMEOUT' ? 'baseline tests timed out' :
    b.counts ? `baseline ${b.counts.total} tests, ${b.counts.failed} failing` : `baseline tests ${b.status}`;
  report('BUILD', 'COMPLETED', `Build passed; ${note}.`);
  return out;
}

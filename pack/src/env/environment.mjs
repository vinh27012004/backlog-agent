// Nhận diện stack (port rút gọn của orchestrator/profile.py) và chuẩn bị môi trường (05 §5.3).
// Repo của BTC có thể kèm env-require/ (README, doctor.ps1...): khi có thì doctor.ps1 là thước đo READY.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { run, runPwsh } from '../core/jobs.mjs';
import { baselineOf, runTests } from './testreport.mjs';
import { randomSecret } from '../core/util.mjs';

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

export function detectProfile(matchRoot) {
  const root = findAppRoot(matchRoot);
  if (!root) return { root: null, stack: 'unknown', commands: {} };
  const rel = relative(matchRoot, root).replaceAll('\\', '/') || '.';
  const pkg = readJson(join(root, 'package.json'));
  if (pkg) {
    const pm = pkg.packageManager?.split('@')[0] ??
      (existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : 'npm');
    const scripts = pkg.scripts ?? {};
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const install = pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : pm === 'yarn' ? 'yarn install --frozen-lockfile' : 'npm ci';
    const runner = deps.vitest ? 'vitest' : deps.jest ? 'jest' : null;
    return {
      root, relRoot: rel, stack: 'node', packageManager: pm, testRunner: runner, testScript: scripts.test ?? null,
      prisma: Boolean(deps.prisma || deps['@prisma/client']),
      // Gate chạy build song song với test, trừ khi script test tự build (pretest, "build && jest") hay đọc thứ build ra.
      parallelBuild: Boolean(scripts.build) && !scripts.pretest && !/\bbuild\b|\bdist\b/.test(scripts.test ?? ''),
      commands: {
        install,
        build: scripts.build ? `${pm} run build` : null,
        typecheck: scripts.typecheck ? `${pm} run typecheck` : null,
        test_all: scripts.test ? `${pm} test` : null,
        test_one: runner === 'vitest' ? `${pm} exec vitest run {target}` : runner === 'jest' ? `${pm} exec jest {target}` : null,
        run_app: scripts.start ? `${pm} run start` : scripts.dev ? `${pm} run dev` : null,
        // postinstall của @prisma/client có thể chạy trước khi CLI được link (pnpm), nên generate riêng.
        generate: deps.prisma ? `${pm} exec prisma generate` : null,
        migrate: deps.prisma ? `${pm} exec prisma migrate deploy` : null,
        seed: scripts['db:seed'] ? `${pm} run db:seed` : null
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

const step = async (job, name, command, opts) => {
  job.progress.push(`${name}: running`);
  const res = await runPwsh(command, opts);
  job.progress.push(`${name}: ${res.code === 0 ? 'ok' : `exit ${res.code}`} (${Math.round(res.ms / 1000)}s)`);
  return res;
};

const lastLines = (text, n = 8) => String(text).trim().split(/\r?\n/).slice(-n).join('\n');

// Môi trường cho worktree của một item: .env chép từ checkout chính (gitignored nên worktree không có) với test DB
// và (khi stack có lệnh migrate) database dev riêng theo trận và item, rồi cài dependency + generate, rồi migrate +
// seed database riêng đó (`prisma migrate deploy` tự tạo database chưa có). Probe chỉ chạy test: `appDatabase: false`.
export async function prepareWorktreeEnv(job, { wtMatchRoot, mainMatchRoot, key, logDir, appDatabase = true }) {
  const profile = detectProfile(wtMatchRoot);
  const main = detectProfile(mainMatchRoot);
  const out = { profile: { stack: profile.stack, root: profile.relRoot }, steps: [] };
  if (!profile.root) return { ...out, ok: false, failure: 'no application manifest in worktree' };
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
  const names = ['install', 'generate', ...(own ? ['migrate', 'seed'] : [])];
  for (const name of names) {
    // Seed khi .env vừa tạo hoặc migrate vừa tạo database (đã bị dropWorktreeDatabases xoá sau push rồi dùng lại).
    if (!c[name] || name === 'seed' && !fresh && !out.steps.some(s => s.name === 'migrate' && s.created)) continue;
    const res = await step(job, name, c[name], { cwd: profile.root, timeoutMs: 300_000, logFile: join(logDir, `${key}-worktree-${name}.log`) });
    out.steps.push({ name, code: res.code, seconds: Math.round(res.ms / 1000), ...(res.code && name === 'seed' ? { tail: lastLines(res.tail, 4) } : {}),
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
export async function setupEnvironment(job, { matchRoot, localDir, logDir, report, deadlineAt, baselineMs = 240_000 }) {
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
  const machine = readMachineConfig(localDir);
  const env = fillEnvFile(cwd, machine, { testDbSuffix: dbSuffix(basename(matchRoot)) });
  out.steps.push({ name: 'env-file', ...env });

  const c = profile.commands;
  const install = await step(job, 'install', c.install, { cwd, timeoutMs: Math.min(remaining(), 300_000), logFile: log('install') });
  out.steps.push({ name: 'install', code: install.code, seconds: Math.round(install.ms / 1000) });
  if (install.code !== 0) {
    out.failure = lastLines(install.tail);
    report('ENVIRONMENT', 'FAILED', 'Dependency installation failed.');
    return out;
  }
  for (const name of ['generate', 'migrate', 'seed']) {
    if (!c[name]) continue;
    const res = await step(job, name, c[name], { cwd, timeoutMs: 120_000, logFile: log(name) });
    out.steps.push({ name, code: res.code, seconds: Math.round(res.ms / 1000), ...(res.code ? { tail: lastLines(res.tail, 4) } : {}) });
    if (res.code !== 0 && name !== 'seed') {
      out.failure = lastLines(res.tail);
      report('ENVIRONMENT', 'FAILED', `${name} failed.`);
      return out;
    }
  }
  const doctor = join(matchRoot, 'env-require', 'doctor.ps1');
  if (existsSync(doctor)) {
    // -Output ra ngoài repo: mặc định doctor ghi env-require/environment-report.json, gate coi là thay đổi cấm.
    const reportFile = join(logDir, 'environment-report.json').replaceAll("'", "''");
    const res = await step(job, 'doctor', `& '${doctor.replaceAll("'", "''")}' -SourceDir '${cwd.replaceAll("'", "''")}' -Output '${reportFile}'`,
      { cwd: join(matchRoot, 'env-require'), timeoutMs: 120_000, logFile: log('doctor') });
    out.doctor = /Environment status:\s*READY/.test(res.tail) ? 'READY' : 'NOT_READY';
    out.steps.push({ name: 'doctor', code: res.code, status: out.doctor, ...(out.doctor !== 'READY' ? { tail: lastLines(res.tail, 10) } : {}) });
    if (out.doctor !== 'READY') {
      report('ENVIRONMENT', 'FAILED', 'env-require doctor reports NOT_READY.');
      return out;
    }
  }
  report('ENVIRONMENT', 'COMPLETED', `${profile.stack} toolchain and dependencies ready${out.doctor ? '; doctor READY' : ''}.`);

  report('BUILD', 'IN_PROGRESS', 'Building the application.');
  if (c.build) {
    const build = await step(job, 'build', c.build, { cwd, timeoutMs: Math.min(remaining(), 300_000), logFile: log('build') });
    out.steps.push({ name: 'build', code: build.code, seconds: Math.round(build.ms / 1000) });
    if (build.code !== 0) {
      out.failure = lastLines(build.tail);
      report('BUILD', 'FAILED', 'Build failed.');
      return out;
    }
  }
  out.build = 'PASS';
  if (c.test_all) {
    const budget = Math.min(baselineMs, Math.max(30_000, deadlineAt - Date.now() - 60_000));
    // Có reporter máy đọc thì baseline giữ trạng thái từng test (gate so test fail mới / test biến mất theo id).
    job.progress.push('baseline-tests: running');
    const run = await runTests(profile, 'test_all', { logFile: log('baseline-tests'), timeoutMs: budget });
    job.progress.push(`baseline-tests: ${run.res.code === 0 ? 'ok' : `exit ${run.res.code}`} (${Math.round(run.res.ms / 1000)}s, ${run.source})`);
    out.baseline = baselineOf(run);
  }
  const b = out.baseline;
  const note = !b ? 'no test command' : b.status === 'TIMEOUT' ? 'baseline tests timed out' :
    b.counts ? `baseline ${b.counts.total} tests, ${b.counts.failed} failing` : `baseline tests ${b.status}`;
  report('BUILD', 'COMPLETED', `Build passed; ${note}.`);
  return out;
}

// Nhận diện stack (port rút gọn của orchestrator/profile.py) và chuẩn bị môi trường (05 §5.3).
// Repo của BTC có thể kèm env-require/ (README, doctor.ps1...): khi có thì doctor.ps1 là thước đo READY.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runPwsh } from './jobs.mjs';
import { randomSecret } from './util.mjs';

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
      root, relRoot: rel, stack: 'node', packageManager: pm, testRunner: runner,
      prisma: Boolean(deps.prisma || deps['@prisma/client']),
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

export function fillEnvFile(appRoot, machine) {
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
  writeFileSync(target, lines.join('\n'), 'utf8');
  return { created: true, unresolved };
}

export function readMachineConfig(localDir) {
  return readJson(join(localDir, 'machine.json')) ?? {};
}

// Đếm test từ output của các runner phổ biến. Không đọc được thì trả null (không bịa số).
export function parseTestCounts(text) {
  const t = String(text);
  let m = t.match(/Tests\s+(.+?)\(\s*(\d+)\s*\)/);          // vitest: "Tests  10 passed | 2 failed (12)"
  if (m) {
    const part = m[1];
    const n = re => Number((part.match(re) ?? [])[1] ?? 0);
    const passed = n(/(\d+)\s+passed/), failed = n(/(\d+)\s+failed/), skipped = n(/(\d+)\s+skipped/) + n(/(\d+)\s+todo/);
    return { total: Number(m[2]), passed, failed, skipped };
  }
  m = t.match(/Tests:\s+(?:(\d+)\s+failed,\s+)?(?:(\d+)\s+skipped,\s+)?(?:(\d+)\s+passed,\s+)?(\d+)\s+total/);   // jest
  if (m) return { total: Number(m[4]), failed: Number(m[1] ?? 0), skipped: Number(m[2] ?? 0), passed: Number(m[3] ?? 0) };
  m = t.match(/=+\s+(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+passed,?\s*)?(?:(\d+)\s+skipped)?.*?in\s+[\d.]+s/);    // pytest
  if (m && (m[1] || m[2])) {
    const failed = Number(m[1] ?? 0), passed = Number(m[2] ?? 0), skipped = Number(m[3] ?? 0);
    return { total: failed + passed + skipped, passed, failed, skipped };
  }
  m = t.match(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/g);             // maven
  if (m) {
    const last = m[m.length - 1].match(/(\d+)\D+(\d+)\D+(\d+)\D+(\d+)/);
    const total = Number(last[1]), failed = Number(last[2]) + Number(last[3]), skipped = Number(last[4]);
    return { total, failed, skipped, passed: total - failed - skipped };
  }
  return null;
}

// Tên test fail (vitest/jest: dòng "FAIL  path > suite > name" hoặc "× name").
export function failingTests(text) {
  const out = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:FAIL|×|✕)\s+(.+?)(?:\s+\d+ms)?\s*$/);
    if (m && !/Tests?\s+\d/.test(m[1])) out.add(m[1].trim().slice(0, 200));
  }
  return [...out].slice(0, 100);
}

const step = async (job, name, command, opts) => {
  job.progress.push(`${name}: running`);
  const res = await runPwsh(command, opts);
  job.progress.push(`${name}: ${res.code === 0 ? 'ok' : `exit ${res.code}`} (${Math.round(res.ms / 1000)}s)`);
  return res;
};

const lastLines = (text, n = 8) => String(text).trim().split(/\r?\n/).slice(-n).join('\n');

// Môi trường cho worktree của một item: .env chép từ checkout chính (gitignored nên worktree không có),
// TEST_DATABASE_URL riêng theo item (test làm rỗng test DB trước mỗi case), rồi cài dependency + generate.
export async function prepareWorktreeEnv(job, { wtMatchRoot, mainMatchRoot, key, logDir }) {
  const profile = detectProfile(wtMatchRoot);
  const main = detectProfile(mainMatchRoot);
  const out = { profile: { stack: profile.stack, root: profile.relRoot }, steps: [] };
  if (!profile.root) return { ...out, ok: false, failure: 'no application manifest in worktree' };
  const mainEnv = main.root ? join(main.root, '.env') : null;
  if (mainEnv && existsSync(mainEnv) && !existsSync(join(profile.root, '.env'))) {
    const suffix = `_${key.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const text = readFileSync(mainEnv, 'utf8').replace(/^(\s*TEST_DATABASE_URL\s*=\s*["']?[^"'\s?]*?\/)([A-Za-z0-9_]+)(?=["'?\s]|$)/m,
      (m, pre, db) => `${pre}${db.endsWith(suffix) ? db : db + suffix}`);
    writeFileSync(join(profile.root, '.env'), text, 'utf8');
    out.steps.push({ name: 'env-file', copied: true, testDatabaseSuffix: suffix });
  }
  const c = profile.commands;
  for (const name of ['install', 'generate']) {
    if (!c[name]) continue;
    const res = await step(job, name, c[name], { cwd: profile.root, timeoutMs: 300_000, logFile: join(logDir, `${key}-worktree-${name}.log`) });
    out.steps.push({ name, code: res.code, seconds: Math.round(res.ms / 1000) });
    if (res.code !== 0) return { ...out, ok: false, failure: lastLines(res.tail) };
  }
  return { ...out, ok: true };
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
  const env = fillEnvFile(cwd, machine);
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
    const test = await step(job, 'baseline-tests', c.test_all, { cwd, timeoutMs: budget, logFile: log('baseline-tests'), tailBytes: 64 * 1024 });
    const counts = parseTestCounts(test.tail);
    out.baseline = test.timedOut ? { status: 'TIMEOUT' } :
      { status: test.code === 0 ? 'PASS' : 'FAIL', counts, failing: test.code === 0 ? [] : failingTests(test.tail) };
  }
  const b = out.baseline;
  const note = !b ? 'no test command' : b.status === 'TIMEOUT' ? 'baseline tests timed out' :
    b.counts ? `baseline ${b.counts.total} tests, ${b.counts.failed} failing` : `baseline tests ${b.status}`;
  report('BUILD', 'COMPLETED', `Build passed; ${note}.`);
  return out;
}

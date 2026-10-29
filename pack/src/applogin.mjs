// Tài khoản seed của app cho bước `login` của capture_evidence (Practice 9KNXREJ5): fixer CR-01 đọc ADMIN_* từ .env
// (không có, form điền rỗng, login hỏng) rồi regex mật khẩu mặc định trong prisma/seed.ts; auto_review của Player coi
// chuỗi "login hỏng → moi mật khẩu admin" là dò mật khẩu và chặn, root lan lệnh cấm sang TASK-02. Helper tự tìm tài
// khoản mà seed tạo ra: biến môi trường seed đọc (`process.env.X ?? "mặc định"`), giá trị lấy từ .env nếu có, không thì
// mặc định trong seed. Agent không bao giờ thấy mật khẩu, kết quả chỉ nêu tên biến và nguồn.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { detectProfile } from './environment.mjs';
import { fail } from './util.mjs';

const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.git', 'coverage', '.turbo', '.codegraph']);
const SEED_FILE = /seed[^/\\]*\.(m?[jt]s|cjs)$/i;
const USER_KEY = /^(.*?)_?(EMAIL|USERNAME|USER|LOGIN)$/;
// Cặp user/password của dịch vụ khác (SMTP_USER/SMTP_PASSWORD, DATABASE_USER...) không phải tài khoản đăng nhập app.
const NOT_APP = /SMTP|MAIL_SERVER|EMAIL_SERVER|DATABASE|POSTGRES|MYSQL|MONGO|REDIS|^DB_|S3|AWS|GITHUB|GOOGLE|OAUTH|SENTRY/;
const RANK = ['ADMIN', 'SEED', 'DEMO', 'TEST', 'DEFAULT'];

export function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    const q = value[0];
    if ((q === '"' || q === "'" || q === '`') && value.lastIndexOf(q) > 0) value = value.slice(1, value.lastIndexOf(q));
    else value = value.replace(/\s+#.*$/, '');
    env[m[1]] = value;
  }
  return env;
}

function seedFiles(dir, depth = 0, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) { if (depth < 3 && !SKIP_DIRS.has(e.name)) seedFiles(join(dir, e.name), depth + 1, out); }
    else if (SEED_FILE.test(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

// Biến môi trường mà file seed đọc, kèm giá trị mặc định nếu có: process.env.X ?? "v", process.env.X || 'v', process.env["X"].
export function seedRefs(text) {
  const refs = new Map();
  const re = /process\.env(?:\.([A-Z0-9_]+)|\[\s*['"]([A-Z0-9_]+)['"]\s*\])(?:\s*(?:\?\?|\|\|)\s*(['"`])((?:(?!\3)[^\\\n])*)\3)?/g;
  for (const m of text.matchAll(re)) {
    const key = m[1] ?? m[2];
    if (!refs.has(key) || (refs.get(key) === undefined && m[4] !== undefined)) refs.set(key, m[4]);
  }
  return refs;
}

const rank = prefix => { const i = RANK.findIndex(r => prefix.includes(r)); return i < 0 ? RANK.length : i; };

export function seededAccount(matchRoot) {
  const root = detectProfile(matchRoot).root ?? matchRoot;
  const env = {};
  for (const dir of [...new Set([root, matchRoot])]) {
    for (const name of ENV_FILES) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      for (const [k, v] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) if (!(k in env)) env[k] = { value: v, from: relative(matchRoot, file) };
    }
  }
  const refs = new Map();
  for (const file of seedFiles(root)) {
    for (const [k, v] of seedRefs(readFileSync(file, 'utf8'))) {
      if (!refs.has(k) || (refs.get(k).value === undefined && v !== undefined)) refs.set(k, { value: v, from: relative(matchRoot, file).replaceAll('\\', '/') });
    }
  }
  const resolveKey = key => env[key]?.value ? { value: env[key].value, source: `${key} from ${env[key].from.replaceAll('\\', '/')}` }
    : refs.get(key)?.value ? { value: refs.get(key).value, source: `${key} default in ${refs.get(key).from}` } : null;

  const pairs = [];
  for (const key of new Set([...refs.keys(), ...Object.keys(env)])) {
    const m = key.match(USER_KEY);
    if (!m || NOT_APP.test(key)) continue;
    // Chỉ biến seed đọc, hoặc biến .env có tên rõ là tài khoản (ADMIN_/SEED_/DEMO_/TEST_/DEFAULT_).
    if (!refs.has(key) && rank(m[1]) === RANK.length) continue;
    const passKey = ['PASSWORD', 'PASS'].map(s => (m[1] ? `${m[1]}_${s}` : s)).find(k => refs.has(k) || k in env);
    if (!passKey) continue;
    const user = resolveKey(key);
    const pass = resolveKey(passKey);
    if (user && pass) pairs.push({ prefix: m[1], seeded: refs.has(key), user, pass });
  }
  pairs.sort((a, b) => Number(b.seeded) - Number(a.seeded) || rank(a.prefix) - rank(b.prefix));
  if (!pairs.length) {
    fail('LOGIN_ACCOUNT_NOT_FOUND', 'no seeded login account found: no seed script reads a user/email + password env pair ' +
      '(e.g. process.env.ADMIN_EMAIL ?? "...") and .env has none. Use the account the item or its test data names.');
  }
  const [best] = pairs;
  return { username: best.user.value, password: best.pass.value, sources: [best.user.source, best.pass.source] };
}

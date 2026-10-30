// Đặc trưng khách quan của item cho triage: Jev chỉ đọc chữ của đề nên hay đoán độ khó dưới ngưỡng (practice-log L39:
// difficulty 0/5 lần đủ ngưỡng). Helper đếm từ đề, MVS và `git grep` trên checkout chính, đọc topology (số file bị ảnh
// hưởng, độ sâu lời gọi, gọi chéo module) từ index codegraph và đối chiếu đề với stack-notes/bug-patterns, gửi kèm state
// cho Jev, và dùng làm luật dự phòng cho difficulty. Không dependency, chỉ đọc matchRoot và skills/ của pack; lỗi thì bỏ
// phần đó, không chặn start_work.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findAppRoot } from '../env/environment.mjs';
import { git } from '../core/git.mjs';

const MAX_TERMS = 12;
// Từ khoá khớp quá nhiều file là từ chung chung (Dashboard, invoice…), không cho biết vùng code cần sửa.
const GENERIC_FILES = 40;
// env-require/: bộ dựng môi trường của BTC (README, doctor.ps1, db-setup.sql), không phải code của ứng dụng.
const SKIP_PATHS = [':(exclude)answers/**', ':(exclude)challenge/**', ':(exclude).team-work/**', ':(exclude).codegraph/**', ':(exclude)env-require/**'];

const FLAGS = {
  externalSpec: /\bstandards?\b|internal systems?|\bauthoritative\b|company polic/i,
  dependencies: /package\.json|lock(?:file|\.ya?ml|\.json)|pom\.xml|requirements\.txt|\baudit\b|vulnerab|dependenc|\bupgrade/i,
  data: /migration|\bschema\b|database|persist|stored data|backfill|\bconstraint\b/i,
  tricky: /concurren|race condition|time ?zone|deadlock|\bcach(?:e|ing)\b|rounding|locale/i,
  security: /authenticat|signed[- ]out|unauthori[sz]ed|permission|access control|\bcsrf\b|\bxss\b/i,
  ui: /\b(?:screen|button|viewport|click|sidebar|dialog|modal|layout|wireframe|desktop|mobile)\b|→/i
};

// Phần nộp bài (mẫu submit.json, mã TC, PASS/FAIL, đường dẫn evidence) và Out of scope không nói gì về độ khó của code.
export function workText(text) {
  const out = [];
  let skip = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const h = line.match(/^\s*(#{1,6})\s+(.*)/);
    if (h && skip && h[1].length <= skip) skip = 0;
    if (h && !skip && /^(?:submission|out of scope)\b/i.test(h[2].trim())) skip = h[1].length;
    if (!skip) out.push(line);
  }
  return out.join('\n');
}

// Item chỉ cần nộp câu trả lời, không sửa code: không có tiêu chí nghiệm thu và có heading "Answer format" (TASK-01
// HIET12OA) hoặc "Question(s)" (TASK-03/04 FMC0ZXFC), hoặc Out of scope cấm sửa source (PI-01 FMC0ZXFC: báo cáo từ log).
// Đọc mô tả gốc vì workText bỏ mục Out of scope.
export function answerOnlyText(description) {
  const text = String(description ?? '');
  if (countCriteria(text)) return false;
  if (/^\s*#{1,6}\s+(?:answer format|questions?)\b/im.test(workText(text))) return true;
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex(l => /^\s*#{1,6}\s+out of scope\b/i.test(l));
  if (at < 0) return false;
  const level = lines[at].match(/^\s*(#+)/)[1].length;
  const end = lines.findIndex((l, i) => i > at && (l.match(/^\s*(#{1,6})\s/)?.[1].length ?? 99) <= level);
  return /\bchang\w*\s+(?:the\s+)?(?:application\s+)?source\b/i.test(lines.slice(at + 1, end < 0 ? undefined : end).join('\n'));
}

// Đếm mục đánh số / gạch đầu dòng dưới heading "Acceptance criteria" (không có thì "Requirements").
export function countCriteria(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (const name of [/acceptance criteria/i, /requirements/i]) {
    const at = lines.findIndex(l => /^\s*#{1,6}\s/.test(l) && name.test(l));
    if (at < 0) continue;
    let n = 0;
    for (const l of lines.slice(at + 1)) {
      if (/^\s*#{1,6}\s/.test(l)) break;
      if (/^\s*(?:\d+[.)]|[-*])\s+\S/.test(l)) n++;
    }
    if (n) return n;
  }
  return 0;
}

const CODE_LIKE = /[a-z][A-Z]|[a-z]_[a-z]|\/[\w.-]|\.(?:tsx?|jsx?|mjs|py|java|kt|cs|go|php|rb|sql|vue|svelte|ya?ml|toml|prisma)$/;

// Từ khoá có dáng code: **nhãn UI**, rồi `backtick`/camelCase/PascalCase/snake_case/đường dẫn/tên file mã nguồn. Bỏ mã TC,
// chữ hoa toàn phần (PASS, DONE), từ đơn (`result`) và đường dẫn nộp bài/evidence.
export function codeTerms(text) {
  const s = String(text ?? '');
  const found = [
    ...[...s.matchAll(/\*\*([^*\n]{3,40})\*\*/g)].map(m => m[1].trim()),
    ...[...s.matchAll(/`([^`\s]{3,60})`/g)].map(m => m[1]).filter(t => CODE_LIKE.test(t.replace(/[.,:;]+$/, ''))),
    ...(s.match(/\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z]+[A-Z][A-Za-z0-9]*\b/g) ?? []),
    ...(s.match(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g) ?? []),
    ...(s.match(/\b[\w-]+\.(?:tsx?|jsx?|mjs|py|java|kt|cs|go|php|rb|sql|vue|svelte)\b/g) ?? [])
  ];
  const out = [];
  for (const t of found) {
    const term = t.replace(/[.,:;]+$/, '');
    if (term.length < 3 || /^[A-Z0-9_-]+$/.test(term) || /^(?:answers|challenge|evidence)\b|submit(?:\.schema)?\.json|^https?:|\/$/i.test(term)) continue;
    if (!out.some(x => x.toLowerCase() === term.toLowerCase())) out.push(term);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

const TEST_PATH = /(?:^|[/._-])(?:tests?|spec|__tests__)(?:[/._-]|$)/i;

async function grepFiles(root, term) {
  const res = await git(['grep', '-l', '-I', '-F', '-e', term, '--', '.', ...SKIP_PATHS], { cwd: root, timeoutMs: 5000, allowFail: true });
  return res.code === 0 ? res.out.split(/\r?\n/).filter(Boolean) : [];
}

// Từ khoá dùng được (khớp 1–GENERIC_FILES file) và danh sách file khớp; topology lấy file này làm điểm xuất phát.
async function matchedFiles(root, terms) {
  if (!root || !terms.length) return null;
  const hits = await Promise.all(terms.map(t => grepFiles(root, t).catch(() => [])));
  const used = [];
  const files = new Set();
  hits.forEach((list, i) => {
    if (!list.length || list.length > GENERIC_FILES) return;
    used.push(terms[i]);
    for (const f of list) files.add(f.replaceAll('\\', '/'));
  });
  return { used, files: [...files] };
}

const codeSummary = ({ used, files }) => ({ terms: used, files: files.length,
  modules: new Set(files.map(f => f.split('/').slice(0, 2).join('/'))).size, test_files: files.filter(f => TEST_PATH.test(f)).length,
  sample: files.slice(0, 5) });

export async function codeMatches(root, terms) {
  const hits = await matchedFiles(root, terms);
  return hits && codeSummary(hits);
}

// ---- Topology từ index codegraph (.codegraph/codegraph.db, SQLite) ----
// Bảng nodes(id, kind, name, file_path) và edges(source, target, kind): source phụ thuộc target (gọi, tham chiếu,
// import). Đọc thẳng bằng node:sqlite (có sẵn từ Node 22.13/23.4, không cờ), chỉ đọc. Thiếu index, index chưa xong,
// Node không có node:sqlite hay DB đang khoá thì trả null: luật dùng lại phần git grep.
const TOPO_BUDGET_MS = 300;
const IMPACT_DEPTH = 3;          // như codegraph getImpactRadius (mặc định 3)
const CALL_DEPTH_CAP = 6;
const MAX_VISITS = 3000;
const MAX_SEEDS = 300;
// Tên khớp quá nhiều node (get, id, data…) không chỉ ra chỗ sửa, như GENERIC_FILES của git grep.
const GENERIC_SYMBOLS = 20;
const NOT_APP = /^(?:answers|challenge|env-require|\.team-work|\.codegraph)\//;

let sqlite;      // undefined: chưa nạp; null: Node này không có node:sqlite
async function loadSqlite() {
  if (sqlite !== undefined) return sqlite;
  // node:sqlite in ExperimentalWarning ra stderr của helper lúc nạp; cảnh báo đó không có ích cho ai.
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (/sqlite/i.test(String(w?.message ?? w)) ? undefined : emit.call(process, w, ...rest));
  try { sqlite = await import('node:sqlite'); } catch { sqlite = null; } finally { process.emitWarning = emit; }
  return sqlite;
}

// Gốc module: đi xuống thư mục con khi nó chứa ≥ 75% file mã nguồn (src/src/ của Next, src/main/java/org/…/petclinic/
// của Spring). Module của file = 2 cấp thư mục dưới gốc, bỏ route group "(app)" của Next.
export function moduleRoot(paths) {
  let root = '';
  let files = paths.filter(p => !TEST_PATH.test(p));
  for (;;) {
    const counts = new Map();
    for (const p of files) {
      const i = p.indexOf('/', root.length);
      if (i > root.length) counts.set(p.slice(root.length, i), (counts.get(p.slice(root.length, i)) ?? 0) + 1);
    }
    const [top, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (!top || n < files.length * 0.75) return root;
    root += `${top}/`;
    files = files.filter(p => p.startsWith(root));
  }
}

export const moduleOf = (path, root) => (path.startsWith(root) ? path.slice(root.length) : path).split('/').slice(0, -1)
  .filter(s => !/^\(.*\)$/.test(s)).slice(0, 2).join('/') || '.';

// BFS ngược (ai phụ thuộc vào start) theo stmt(target) → [{id, file, kind}]; dừng ở maxDepth, MAX_VISITS hoặc hết giờ.
// Node file (bên import) được đếm nhưng không đi tiếp: đi qua file hub (root router, index.ts) thì cả app đều "bị
// ảnh hưởng" (TASK-04 FMC0ZXFC: 41 file từ một router).
function dependents(stmt, start, maxDepth, deadline) {
  const seen = new Map(start.map(id => [id, 0]));
  const files = new Map();
  let frontier = start;
  let depth = 0;
  let truncated = false;
  while (frontier.length && depth < maxDepth && !truncated) {
    const next = [];
    for (const id of frontier) {
      if (seen.size >= MAX_VISITS || Date.now() > deadline) { truncated = true; break; }
      for (const r of stmt.all(id)) {
        if (seen.has(r.id)) continue;
        seen.set(r.id, depth + 1);
        files.set(r.id, r.file);
        if (r.kind !== 'file') next.push(r.id);
      }
    }
    if (next.length) depth++;
    frontier = next;
  }
  return { seen, files, depth, truncated };
}

// Điểm xuất phát: symbol có tên trùng từ khoá dáng code (buildInvoiceCsv), tên file trong đề, không có thì mọi symbol
// trong các file git grep tìm thấy (nhãn UI). Bỏ file test và ngoài app: startInstruction hay nêu `tests/helpers.ts`.
function seedNodes(db, terms, grepFiles) {
  const appFile = f => !TEST_PATH.test(f) && !NOT_APP.test(f);
  const byName = db.prepare("SELECT id, name, file_path AS file FROM nodes WHERE lower(name) = lower(?) AND kind NOT IN ('file', 'import') LIMIT ?");
  const byPath = db.prepare("SELECT path FROM files WHERE path = ? OR path LIKE ? LIMIT 3");
  const inFile = db.prepare("SELECT id, name, file_path AS file FROM nodes WHERE file_path = ? AND kind NOT IN ('file', 'import') LIMIT 60");
  const seeds = new Map();
  const symbols = [];
  const files = [];
  for (const t of terms) {
    if (/^[A-Za-z_$][\w$]*$/.test(t)) {
      const rows = byName.all(t, GENERIC_SYMBOLS + 1);
      const app = rows.filter(r => appFile(r.file));
      if (!app.length || rows.length > GENERIC_SYMBOLS) continue;
      symbols.push(t);
      for (const r of app) seeds.set(r.id, r);
    } else if (/\.\w+$/.test(t)) {
      files.push(...byPath.all(t, `%/${t}`).map(r => r.path));
    }
  }
  const from = seeds.size ? 'symbols' : 'files';
  for (const f of new Set([...files, ...(seeds.size ? [] : grepFiles)].filter(appFile))) {
    for (const r of inFile.all(f)) if (seeds.size < MAX_SEEDS) seeds.set(r.id, r);
  }
  return { seeds, symbols, from };
}

// root: checkout chính; terms: codeTerms của đề; grepFiles: file git grep thấy. Không bao giờ ném lỗi.
export async function codeTopology(root, { terms = [], grepFiles = [], budgetMs = TOPO_BUDGET_MS } = {}) {
  const t0 = Date.now();
  const path = root ? join(root, '.codegraph', 'codegraph.db') : null;
  if (!path || !existsSync(path)) return null;
  const mod = await loadSqlite();
  if (!mod) return null;
  let db;
  try {
    db = new mod.DatabaseSync(path, { readOnly: true });
    const state = db.prepare("SELECT value FROM project_metadata WHERE key = 'index_state'").get()?.value;
    if (state && state !== 'complete') return null;            // đang index dở: số liệu thiếu còn tệ hơn không có
    const { seeds, symbols, from } = seedNodes(db, terms, grepFiles);
    if (!seeds.size) return null;
    const deadline = t0 + budgetMs;
    const ids = [...seeds.keys()];
    const anyDep = db.prepare("SELECT e.source AS id, n.file_path AS file, n.kind FROM edges e JOIN nodes n ON n.id = e.source WHERE e.target = ? AND e.kind IN ('calls', 'references', 'imports')");
    const callers = db.prepare("SELECT e.source AS id, n.file_path AS file, n.kind FROM edges e JOIN nodes n ON n.id = e.source WHERE e.target = ? AND e.kind = 'calls'");
    const callees = db.prepare("SELECT DISTINCT target AS id FROM edges WHERE source = ? AND kind = 'calls'");
    const impact = dependents(anyDep, ids, IMPACT_DEPTH, deadline);
    const calls = dependents(callers, ids, CALL_DEPTH_CAP, deadline);
    const out = new Set();
    for (const id of ids) for (const r of callees.all(id)) if (!seeds.has(r.id)) out.add(r.id);

    const files = new Set([...[...seeds.values()].map(s => s.file), ...impact.files.values()].filter(f => f && !NOT_APP.test(f)));
    const app = [...files].filter(f => !TEST_PATH.test(f));
    const base = moduleRoot(db.prepare('SELECT path FROM files').all().map(r => r.path).filter(p => !NOT_APP.test(p)));
    const modules = new Set(app.map(f => moduleOf(f, base)));
    return {
      seeds: seeds.size, seed_from: from, symbols: symbols.slice(0, 5),
      impact_radius_files: app.length, impacted_test_files: files.size - app.length,
      call_depth: calls.depth,
      callers_count: [...calls.seen.values()].filter(d => d === 1).length,
      callees_count: out.size,
      cross_module: modules.size > 1, modules: modules.size, module_sample: [...modules].slice(0, 4),
      ...(impact.truncated || calls.truncated ? { truncated: true } : {}),
      ms: Date.now() - t0
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* đã đóng */ }
  }
}

// ---- Tri thức từ KB của pack (skills/stack-notes, skills/backlog-references/bug-patterns.md) ----
const SKILLS = new URL('../../skills/', import.meta.url);

// npm: so tên dependency (một tên mỗi dòng); manifest khác (pom.xml, build.gradle, requirements.txt, pyproject.toml,
// composer.json, go.mod, *.csproj): tìm chữ.
const FRAMEWORKS = [
  ['Next.js', /^next$/m], ['React', /^react$/m], ['Vue', /^vue$/m], ['NestJS', /^@nestjs\/core$/m], ['Express', /^express$/m],
  ['tRPC', /^@trpc\/server$/m], ['Prisma', /^(?:prisma|@prisma\/client)$/m], ['TypeORM', /^typeorm$/m],
  ['Sequelize', /^sequelize$/m], ['Mongoose', /^mongoose$/m], ['Drizzle', /^drizzle-orm$/m],
  ['Spring Petclinic', /spring-petclinic/i], ['Spring Boot', /spring-boot/], ['JPA', /spring-boot-starter-data-jpa|hibernate-core|jakarta\.persistence/],
  ['Django', /\bdjango\b/i], ['Flask', /\bflask\b/i], ['FastAPI', /\bfastapi\b/i], ['SQLAlchemy', /\bsqlalchemy\b/i], ['Pydantic', /\bpydantic\b/i],
  ['Laravel', /laravel\/framework/], ['ASP.NET Core', /Microsoft\.AspNetCore/], ['Entity Framework', /EntityFrameworkCore/],
  ['Gin', /gin-gonic\/gin/], ['GORM', /gorm\.io\/gorm/]
];
const ORM = /Prisma|TypeORM|Sequelize|Mongoose|Drizzle|JPA|Django|SQLAlchemy|Entity Framework|GORM|Laravel/;

// [yếu tố rủi ro, regex trên đề, regex trên dòng KB để chọn known_pitfalls, cần framework (tuỳ chọn)]
const RISKS = [
  ['schema_migration', /migrat|\bschema\b|backfill|alter table|new (?:column|field|table)|add(?:ing)? an? (?:column|field)/i, /migration|schema/i],
  ['db_transaction', /transaction|\batomic|roll ?back|all[- ]or[- ]nothing|partial(?:ly)? (?:saved|written|applied)|half[- ]written/i, /transaction|@Transactional/i],
  ['concurrency', /concurren|race condition|simultaneous|at the same time|in parallel|deadlock|double[- ](?:click|submit|charge|book)|duplicate (?:request|submission|order)|lost update/i,
    /race|concurren|parallel|lock|double submit/i],
  ['ssr_hydration', /hydrat|server[- ]side render|\bssr\b|server components?|['"]use client['"]|getServerSideProps/i, /hydrat|server|stale closures|React state/i],
  ['timezone', /time ?zone|\butc\b|daylight|\bdst\b|midnight|local time|end of (?:the )?(?:day|month)/i, /zone|UTC|clock|midnight/i],
  // Không lấy currency/tax/invoice: app kế toán nào cũng có, không phải dấu hiệu bẫy làm tròn.
  ['money_precision', /\b(?:rounding|rounded|rounds)\b|\bcents?\b|decimal (?:places?|digits?)|floating[- ]point|precision|off by (?:a |one )?cent/i, /money|decimal|precision|rounding|cents/i],
  ['caching', /\bcach(?:e|ed|ing)\b|stale|revalidat|invalidat/i, /\bcach/i],
  ['auth_access', /authenticat|authori[sz]|permission|access control|signed[- ](?:in|out)|\bcsrf\b|other users?'s? data/i, /security|csrf|ownership|role/i],
  ['orm_query', /n\+1|eager|lazy[- ]load|\bjoin(?:ed|s)?\b|relation|\bquer(?:y|ies)\b|filter(?:ed|ing)? by|sort(?:ed|ing)? by|pagination|paging/i,
    /ORM|N\+1|JPA|relations|select_related|lazy|WHERE|ORDER BY/i, ORM],
  ['dependency_upgrade', /upgrade|vulnerab|\baudit\b|lock ?file|dependenc/i, /lockfile|pom\.xml|build\.gradle/i]
];

const MANIFEST_STACK = [['package.json', 'node'], ['pom.xml', 'java'], ['build.gradle', 'java'], ['build.gradle.kts', 'java'],
  ['pyproject.toml', 'python'], ['requirements.txt', 'python'], ['go.mod', 'go'], ['composer.json', 'php']];

const readText = path => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };

const domains = new Map();
// Stack (tên file stack-notes) và framework của checkout; root null hay không thấy manifest thì 'unknown'.
export function detectDomain(root) {
  if (!root) return { stack: 'unknown', frameworks: [] };
  if (domains.has(root)) return domains.get(root);
  let out = { stack: 'unknown', frameworks: [] };
  try {
    const app = findAppRoot(root);
    if (app) {
      const texts = [];
      let stack = null;
      for (const [file, s] of MANIFEST_STACK) {
        const raw = readText(join(app, file));
        if (!raw) continue;
        stack ??= s;
        if (file !== 'package.json') { texts.push(raw); continue; }
        try {
          const pkg = JSON.parse(raw);
          texts.push(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join('\n'));
        } catch { /* package.json hỏng: chỉ biết stack */ }
      }
      const csproj = readdirSync(app).filter(f => /\.csproj$/i.test(f)).slice(0, 3);
      if (csproj.length) { stack ??= 'dotnet'; texts.push(...csproj.map(f => readText(join(app, f)))); }
      const all = texts.join('\n').slice(0, 400_000);
      out = { stack: stack ?? 'unknown', frameworks: FRAMEWORKS.filter(([, re]) => re.test(all)).map(([name]) => name) };
    }
  } catch { /* đọc manifest lỗi: unknown */ }
  domains.set(root, out);
  return out;
}

const kbFiles = new Map();
const kbText = rel => {
  if (!kbFiles.has(rel)) kbFiles.set(rel, readText(new URL(rel, SKILLS)));
  return kbFiles.get(rel);
};

// Dòng "Pitfalls to check" của stack-notes/<stack>.md và các hàng của bảng bug-patterns.md (Pattern: Look first at).
export function kbPitfalls(stack) {
  const out = [];
  let inPitfalls = false;
  for (const line of kbText(`stack-notes/${stack}.md`).split(/\r?\n/)) {
    if (/^\*\*/.test(line)) inPitfalls = /^\*\*Pitfalls/i.test(line);
    else if (inPitfalls && /^- /.test(line)) out.push({ text: line.slice(2).trim(), stack: true });
  }
  for (const line of kbText('backlog-references/bug-patterns.md').split(/\r?\n/)) {
    const cells = line.split('|').map(c => c.trim());
    if (cells.length < 6 || !cells[1] || /^-+$|^Pattern$/.test(cells[1])) continue;
    out.push({ text: `${cells[1]}: ${cells[3]}`, signs: cells[2], stack: false });
  }
  return out;
}

// Một dòng KB khớp nhất với các yếu tố rủi ro (mỗi yếu tố 2 điểm, framework của repo có tên trong dòng 1 điểm, dòng
// của stack-notes 1 điểm). Không có yếu tố rủi ro nào thì không đoán.
function pickPitfall(stack, frameworks, risks) {
  if (!risks.length) return null;
  const hints = RISKS.filter(([k]) => risks.includes(k)).map(r => r[2]);
  const names = frameworks.map(f => f.split(/[ .]/)[0]);
  let best = null;
  for (const p of kbPitfalls(stack)) {
    const hay = `${p.text} ${p.signs ?? ''}`;
    const hit = hints.filter(re => re.test(hay)).length;
    if (!hit) continue;
    const score = hit * 2 + names.filter(n => hay.includes(n)).length + (p.stack ? 1 : 0);
    if (!best || score > best.score) best = { score, text: p.text };
  }
  if (!best) return null;
  const line = best.text.replace(/\*\*/g, '');
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

// text: phần làm việc của đề (workText); root: checkout chính.
export function kbInsights(text, { root = null } = {}) {
  const { stack, frameworks } = detectDomain(root);
  const risk_factors = RISKS.filter(([, re, , needs]) => re.test(text) && (!needs || frameworks.some(f => needs.test(f)))).map(([k]) => k);
  return { domain: frameworks.length ? `${frameworks.join(' + ')} (${stack})` : stack, risk_factors,
    known_pitfalls: pickPitfall(stack, frameworks, risk_factors) };
}

// item: {title, description, startInstruction, points, deadlineMinutes}; root: checkout chính (null thì bỏ phần code).
export async function itemSignals(item, { root = null, scenarios = 0 } = {}) {
  const text = workText([item?.title, item?.description, item?.startInstruction].filter(Boolean).join('\n'));
  const terms = codeTerms(text);
  let hits = null;
  try { hits = await matchedFiles(root, terms); } catch { hits = null; }
  const topology = await codeTopology(root, { terms, grepFiles: hits?.files ?? [] });
  let kb = null;
  try { kb = kbInsights(text, { root }); } catch { kb = null; }
  const criteria = countCriteria(item?.description);
  const flags = Object.entries(FLAGS).filter(([, re]) => re.test(text)).map(([k]) => k);
  // Chỉ cần nộp một câu trả lời; TASK-02 cũng có "Answer format" nhưng có tiêu chí phải sửa code.
  if (answerOnlyText(item?.description)) flags.push('answerOnly');
  return {
    acceptance_criteria: criteria,
    verification_scenarios: scenarios,
    words: text.split(/\s+/).filter(Boolean).length,
    flags,
    points: item?.points ?? null,
    deadline_minutes: item?.deadlineMinutes ?? null,
    code: hits && codeSummary(hits),
    topology,
    kb
  };
}

// Luật dự phòng khi Jev dưới ngưỡng (trước đây luôn "medium"). easy chỉ khi chắc: câu trả lời thuần, hoặc vùng code
// nhỏ (có topology thì ≤ 3 file bị ảnh hưởng trong một module, không thì grep thấy ≤ 3 file). Chỉnh lại sau mỗi trận
// tập theo decisions.ndjson (rule vs jev).
export function difficultyFromSignals(type, s) {
  if (!s) return 'medium';
  const flags = new Set(s.flags ?? []);
  const topo = s.topology;
  let score = type === 'CR' || type === 'PI' ? 1 : 0;
  if (s.acceptance_criteria >= 5) score++;
  if (s.verification_scenarios >= 6) score++;                  // HIET12OA: BUG 4–8, CR 10

  for (const f of ['externalSpec', 'dependencies', 'data', 'tricky']) if (flags.has(f)) score++;
  // Rủi ro KB mà regex cờ của đề chưa tính (vd "double submit", "all-or-nothing").
  const risks = new Set(s.kb?.risk_factors ?? []);
  if (!flags.has('data') && !flags.has('tricky') && ['concurrency', 'db_transaction', 'schema_migration'].some(r => risks.has(r))) score++;
  if ((s.code && (s.code.files > 8 || s.code.modules > 3)) || (topo && (topo.impact_radius_files > 10 || topo.modules > 3))) score++;
  if (flags.has('answerOnly')) score--;
  if (score >= 3) return 'hard';
  const small = topo ? topo.impact_radius_files <= 3 && !topo.cross_module : s.code && s.code.files > 0 && s.code.files <= 3;
  if (score <= 0 && (flags.has('answerOnly') || small)) return 'easy';
  return 'medium';
}

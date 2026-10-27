// Tool code_graph: tra code nhanh cho agent (khai báo, outline, ai gọi, gọi ai, tham chiếu, vùng ảnh hưởng).
// TS/JS dùng chính compiler `typescript` trong node_modules của app (pack không kèm dependency nào); stack khác,
// hoặc app không có typescript/tsconfig, thì dò theo tên (lexical). Kết quả ghi rõ engine để agent biết độ chính xác.
// Không trạng thái theo trận: subagent gọi helper ở tiến trình riêng chưa configure_session (Practice #5:
// read_item của fixer trả NOT_CONFIGURED), nên agent đưa `path` và helper chỉ kiểm nó nằm trong TeamWorkspace/matches.
import { fork } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAppRoot } from './environment.mjs';
import { childEnv } from './jobs.mjs';
import { assertNoLinks, inside } from './paths.mjs';
import { HelperError, fail } from './util.mjs';

export const ACTIONS = ['find', 'outline', 'callers', 'callees', 'references', 'impact'];
const OUT_DIRS = /[\\/](node_modules|\.next|\.nuxt|dist|build|out|coverage|target|bin|obj|vendor|\.venv|venv|__pycache__|\.gradle|\.git|\.team-work)[\\/]/;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|Tests?\.(java|cs|kt)$/;
const clip = (text, n = 160) => { const t = String(text ?? '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const slash = p => p.replaceAll('\\', '/');
const relOf = (base, file) => slash(relative(base, file)) || '.';
const isTest = rel => TEST_FILE.test(rel);
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (name, flags = '') => new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`, flags);
const clamp = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : d);

// `path` của agent → {base, appRoot}. base là gốc của path trong kết quả; app root là nơi có manifest
// (findAppRoot từ path, rồi lùi dần lên thư mục cha, không ra ngoài matches/).
export function codeGraphTarget(teamWorkspace, path) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('INVALID_ARGUMENT', 'path must be an absolute folder (your worktree match folder)');
  const abs = resolve(path);
  const matches = join(teamWorkspace, 'matches');
  if (!inside(matches, abs) || abs === resolve(matches)) fail('PATH_NOT_ALLOWED', 'path must be inside TeamWorkspace/matches');
  assertNoLinks(teamWorkspace, abs);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) fail('INVALID_ARGUMENT', `not a folder: ${path}`);
  let appRoot = null;
  for (let dir = abs; inside(matches, dir) && dir !== resolve(matches); dir = dirname(dir)) {
    appRoot = findAppRoot(dir);
    if (appRoot) break;
  }
  if (!appRoot) fail('NO_APP', `no package.json/pom.xml/pyproject.toml/go.mod/composer.json/.csproj under ${path}`);
  return { base: inside(abs, appRoot) ? abs : appRoot, appRoot };
}

export function checkArgs(a) {
  if (!ACTIONS.includes(a.action)) fail('INVALID_ARGUMENT', `action must be one of ${ACTIONS.join(', ')}`);
  if (a.action === 'find' && !(a.query || a.symbol)) fail('INVALID_ARGUMENT', 'find needs query');
  if (a.action === 'outline' && !a.file) fail('INVALID_ARGUMENT', 'outline needs file');
  if (!['find', 'outline'].includes(a.action) && !a.symbol && !(a.file && a.line)) fail('INVALID_ARGUMENT', `${a.action} needs symbol (or file + line)`);
  for (const k of ['query', 'symbol', 'file']) if (a[k] !== undefined && (typeof a[k] !== 'string' || a[k].length > 300)) fail('INVALID_ARGUMENT', k);
}

export function openEngine(appRoot) {
  let ts = null;
  try { ts = createRequire(join(appRoot, 'package.json'))('typescript'); } catch { /* không có typescript: lexical */ }
  const config = ['tsconfig.json', 'jsconfig.json'].map(f => join(appRoot, f)).find(f => existsSync(f));
  return ts && config ? new TsEngine(ts, appRoot, config) : new LexicalEngine(appRoot);
}

// Dùng chung cho hai engine: chọn hành động, cắt theo limit.
export function runQuery(engine, base, a) {
  const limit = clamp(a.limit, 1, 100, 40);
  const out = { engine: engine.name, base: slash(base), app: relOf(base, engine.root), action: a.action };
  const cut = rows => {
    if (rows.length > limit) out.truncated = rows.length - limit;
    return rows.slice(0, limit);
  };
  if (a.action === 'find') return { ...out, results: cut(engine.find(a.query ?? a.symbol, base)) };
  if (a.action === 'outline') return { ...out, file: a.file, results: cut(engine.outline(engine.file(base, a.file))) };
  const t = engine.target(base, a);
  if (t.candidates) {
    return { ...out, ambiguous: true, candidates: t.candidates.slice(0, 12),
      hint: 'several declarations match: call again with file (and line), or Container.name' };
  }
  if (t.notFound) return { ...out, notFound: a.symbol ?? `${a.file}:${a.line}`, suggestions: t.suggestions };
  const res = engine[a.action](t, base, { depth: clamp(a.depth, 1, 4, 2) });
  return { ...out, target: t.row, ...res, results: cut(res.results), ...(engine.note ? { note: engine.note } : {}) };
}

// ------------------------------------------------------------------ TypeScript
class TsEngine {
  constructor(ts, root, configPath) {
    this.name = 'typescript';
    this.ts = ts;
    this.root = root;
    this.configPath = configPath;
    this.loadConfig();
    const sys = ts.sys;
    this.ls = ts.createLanguageService({
      getScriptFileNames: () => this.fileNames,
      getScriptVersion: f => { try { const s = statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return '0'; } },
      getScriptSnapshot: f => { const t = sys.readFile(f); return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t); },
      getCurrentDirectory: () => root,
      getCompilationSettings: () => this.options,
      getDefaultLibFileName: o => ts.getDefaultLibFilePath(o),
      fileExists: sys.fileExists, readFile: sys.readFile, readDirectory: sys.readDirectory,
      directoryExists: sys.directoryExists, getDirectories: sys.getDirectories, realpath: sys.realpath,
      useCaseSensitiveFileNames: () => sys.useCaseSensitiveFileNames
    }, ts.createDocumentRegistry());
  }

  // Đọc lại tsconfig tối đa 5 s một lần để thấy file agent mới tạo. tsconfig kiểu solution (files: [] + references)
  // thì gộp file của các project được tham chiếu.
  loadConfig() {
    const ts = this.ts;
    const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} };
    const parse = p => ts.getParsedCommandLineOfConfigFile(p, {}, host);
    const main = parse(this.configPath);
    if (!main) fail('CODEGRAPH_FAILED', `cannot read ${this.configPath}`);
    let fileNames = main.fileNames;
    let options = main.options;
    if (!fileNames.length && main.projectReferences?.length) {
      const refs = main.projectReferences.map(r => parse(ts.resolveProjectReferencePath(r))).filter(Boolean);
      fileNames = [...new Set(refs.flatMap(r => r.fileNames))];
      options = refs[0]?.options ?? options;
    }
    this.fileNames = fileNames;
    this.options = { ...options, noEmit: true };
    this.configAt = Date.now();
  }

  sync() {
    if (Date.now() - this.configAt > 5000) this.loadConfig();
    this.program = this.ls.getProgram();
    this.navs = new Map();
  }

  isProject(f) { return inside(this.root, f) && !OUT_DIRS.test(f.slice(this.root.length)); }
  sf(f) { return this.program.getSourceFile(f); }
  line(f, pos) { return this.sf(f).getLineAndCharacterOfPosition(pos).line + 1; }

  lineText(f, line) {
    const sf = this.sf(f);
    const starts = sf.getLineStarts();
    return sf.text.slice(starts[line - 1], starts[line] ?? sf.text.length);
  }

  file(base, file) {
    const f = slash(resolve(base, file));
    this.sync();
    if (!this.sf(f)) fail('FILE_NOT_FOUND', `${file} is not part of the TypeScript project (${relOf(base, this.configPath)})`);
    return f;
  }

  // Gói chứa khai báo ngoài project; pnpm lồng node_modules/.pnpm/<pkg@ver>/node_modules/<pkg> nên lấy đoạn cuối.
  pkg(f) {
    const m = slash(f).match(/.*node_modules\/((?:@[^/]+\/)?[^/]+)/);
    return m ? m[1] : 'typescript';
  }

  nav(f) {
    let tree = this.navs.get(f);
    if (!tree) { tree = this.ls.getNavigationTree(f); this.navs.set(f, tree); }
    return tree;
  }

  // Chuỗi tên bao quanh vị trí, theo navigation tree: "cardRouter > create > mutation() callback".
  enclosing(f, pos) {
    const names = [];
    for (let node = this.nav(f); ;) {
      const child = node.childItems?.find(c => c.spans.some(s => s.start <= pos && pos < s.start + s.length));
      if (!child) break;
      names.push(clip(child.text, 60));
      node = child;
    }
    return names.slice(-3).join(' > ') || '(top level)';
  }

  // navigateTo bỏ qua thuộc tính của object truyền vào hàm (procedure tRPC trong createTRPCRouter({...})), nên dò thêm
  // navigation tree: thuộc tính/method ngay dưới một khai báo cấp file, ở các file có chứa tên cần tìm.
  members(test, needle) {
    const out = [];
    for (const f of this.fileNames) {
      const sf = this.sf(f);
      if (!sf || !this.isProject(sf.fileName) || !sf.text.toLowerCase().includes(needle.toLowerCase())) continue;
      for (const top of this.nav(sf.fileName).childItems ?? []) {
        for (const c of top.childItems ?? []) {
          if (!['property', 'method'].includes(c.kind) || !/^[\w$]+$/.test(c.text) || !test(c.text)) continue;
          out.push({ name: c.text, kind: c.kind, containerName: top.text, fileName: sf.fileName, textSpan: c.nameSpan ?? c.spans[0], matchKind: 'member' });
        }
      }
    }
    return out;
  }

  site(f, pos, base) {
    const line = this.line(f, pos);
    return { file: relOf(base, f), line, in: this.enclosing(f, pos), text: clip(this.lineText(f, line)) };
  }

  decl(item, base) {
    return { name: item.name, kind: item.kind, ...(item.containerName ? { container: item.containerName } : {}),
      file: relOf(base, item.fileName), line: this.line(item.fileName, item.textSpan.start) };
  }

  navigateTo(query, max) {
    return this.ls.getNavigateToItems(query, max, undefined, true).filter(i => this.isProject(i.fileName));
  }

  find(query, base) {
    this.sync();
    const rank = { exact: 0, prefix: 1, substring: 2, camelCase: 3 };
    const q = query.toLowerCase();
    const found = this.navigateTo(query, 300);
    const seen = new Set(found.map(i => `${i.fileName}:${i.textSpan.start}`));
    const members = this.members(n => n.toLowerCase().includes(q), query).filter(i => !seen.has(`${i.fileName}:${i.textSpan.start}`))
      .map(i => ({ ...i, matchKind: i.name.toLowerCase() === q ? 'exact' : i.name.toLowerCase().startsWith(q) ? 'prefix' : 'substring' }));
    return [...found, ...members]
      .sort((x, y) => (rank[x.matchKind] ?? 4) - (rank[y.matchKind] ?? 4) || isTest(relOf(base, x.fileName)) - isTest(relOf(base, y.fileName)))
      .map(i => this.decl(i, base));
  }

  // Khai báo của file theo thứ tự dòng (navigation tree sắp theo tên), tới độ sâu 2, bỏ import.
  outline(f) {
    const rows = [];
    const walk = (node, depth) => {
      const kids = [...(node.childItems ?? [])].filter(c => c.kind !== 'alias').sort((a, b) => a.spans[0].start - b.spans[0].start);
      for (const c of kids) {
        const span = c.spans[0];
        rows.push({ depth, kind: c.kind, name: clip(c.text, 80), line: this.line(f, span.start), end: this.line(f, span.start + span.length) });
        if (depth < 2) walk(c, depth + 1);
      }
    };
    walk(this.nav(f), 0);
    return rows;
  }

  // symbol ("name" hoặc "Container.name"), có thể kèm file và line → vị trí của tên trong khai báo.
  target(base, { symbol, file, line }) {
    this.sync();
    const name = symbol ? symbol.split('.').pop() : null;
    const container = symbol?.includes('.') ? symbol.slice(0, symbol.lastIndexOf('.')).split('.').pop().toLowerCase() : null;
    if (file && line) {
      const f = this.file(base, file);
      const sf = this.sf(f);
      if (line < 1 || line > sf.getLineStarts().length) fail('INVALID_ARGUMENT', `line ${line} is outside ${file}`);
      const text = this.lineText(f, line);
      const m = name ? wordRe(name).exec(text)
        : /(?<![\w$])(?!(?:export|default|async|function|const|let|var|class|public|private|protected|static|readonly|abstract|override|get|set|type|interface|enum)\b)[A-Za-z_$][\w$]*/.exec(text);
      if (!m) return { notFound: true, suggestions: [] };
      const pos = sf.getLineStarts()[line - 1] + m.index;
      return { file: f, pos, name: m[0], row: { name: m[0], file: relOf(base, f), line } };
    }
    const f = file ? this.file(base, file).toLowerCase() : null;
    const pick = list => list.filter(i => (!container || i.containerName?.toLowerCase().startsWith(container)
      || relOf(base, i.fileName).split('/').pop().replace(/\..*$/, '').toLowerCase() === container)
      && (!f || i.fileName.toLowerCase() === f));
    let items = pick(this.navigateTo(name, 500).filter(i => i.name === name));
    if (!items.length) items = pick(this.members(n => n === name, name));
    if (!items.length) return { notFound: true, suggestions: this.find(name, base).slice(0, 8) };
    if (items.length > 1) return { candidates: items.map(i => this.decl(i, base)) };
    const it = items[0];
    const text = this.sf(it.fileName).text.slice(it.textSpan.start, it.textSpan.start + it.textSpan.length);
    const pos = it.textSpan.start + (wordRe(name).exec(text)?.index ?? 0);
    return { file: it.fileName, pos, name, row: this.decl(it, base) };
  }

  hierarchy(t) {
    return [].concat(this.ls.prepareCallHierarchy(t.file, t.pos) ?? []);
  }

  references(t, base) {
    const results = [];
    const importedBy = new Set();
    for (const group of this.ls.findReferences(t.file, t.pos) ?? []) {
      for (const r of group.references) {
        if (r.isDefinition || !this.isProject(r.fileName)) continue;
        const s = this.site(r.fileName, r.textSpan.start, base);
        if (/^\s*(import|export)\b.*\bfrom\b|^\s*import\(|require\(/.test(s.text)) { importedBy.add(s.file); continue; }
        results.push(s);
      }
    }
    return { results, importedBy: [...importedBy] };
  }

  callers(t, base) {
    const items = this.hierarchy(t);
    const results = [];
    for (const item of items) {
      for (const call of this.ls.provideCallHierarchyIncomingCalls(item.file, item.selectionSpan.start)) {
        if (!this.isProject(call.from.file)) continue;
        for (const span of call.fromSpans) results.push(this.site(call.from.file, span.start, base));
      }
    }
    if (results.length) return { results };
    const refs = this.references(t, base);
    return { ...refs, via: 'references', hint: items.length ? 'no direct calls: it is passed as a value, rendered as JSX or used in types'
      : 'not callable: these are its uses' };
  }

  // Mọi lời gọi trong khai báo (cả trong callback, JSX, new), mỗi cái tra định nghĩa. Không dùng outgoing call
  // hierarchy vì nó trả rỗng với thuộc tính (procedure tRPC: create: protectedProcedure.mutation(async () => ...)).
  callees(t, base) {
    const ts = this.ts;
    const sf = this.sf(t.file);
    let decl = null;
    const find = node => {
      if (t.pos < node.pos || t.pos >= node.end) return;
      if (node.name?.getStart?.(sf) === t.pos) decl = node;
      ts.forEachChild(node, find);
    };
    find(sf);
    const calls = new Map();
    const external = new Set();
    const nameOf = e => (ts.isPropertyAccessExpression(e) ? e.name : ts.isIdentifier(e) ? e : null);
    const visit = node => {
      const callee = ts.isCallExpression(node) || ts.isNewExpression(node) ? nameOf(node.expression)
        : ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) ? nameOf(node.tagName) : null;
      if (callee && !(ts.isIdentifier(callee) && /^[a-z]/.test(callee.text) && ts.isJsxOpeningLikeElement(node))) {
        const def = this.ls.getDefinitionAtPosition(t.file, callee.getStart(sf))?.[0];
        if (def && this.isProject(def.fileName)) {
          const key = `${def.fileName}:${def.textSpan.start}`;
          const row = calls.get(key) ?? { name: callee.text, kind: def.kind, file: relOf(base, def.fileName), line: this.line(def.fileName, def.textSpan.start), calledAt: [] };
          const at = this.line(t.file, callee.getStart(sf));
          if (!row.calledAt.includes(at)) row.calledAt.push(at);
          calls.set(key, row);
        } else if (def) external.add(`${callee.text} (${this.pkg(def.fileName)})`);
      }
      ts.forEachChild(node, visit);
    };
    if (decl) ts.forEachChild(decl, visit);
    return { results: [...calls.values()], external: [...external].slice(0, 30) };
  }

  // Người gọi bắc cầu tới `depth` tầng. Chỗ gọi nằm trong callback hay code cấp module (route tRPC, handler,
  // test) là điểm vào: ghi lại nhưng không đi tiếp.
  impact(t, base, { depth }) {
    const results = [];
    const seen = new Set();
    let frontier = this.hierarchy(t);
    for (let level = 1; level <= depth && frontier.length; level++) {
      const next = [];
      for (const item of frontier) {
        for (const call of this.ls.provideCallHierarchyIncomingCalls(item.file, item.selectionSpan.start)) {
          if (!this.isProject(call.from.file)) continue;
          const key = `${call.from.file}:${call.from.selectionSpan.start}:${call.from.kind === 'module' ? call.fromSpans[0].start : ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const s = this.site(call.from.file, call.fromSpans[0].start, base);
          results.push({ level, in: s.in, file: s.file, line: s.line, ...(isTest(s.file) ? { test: true } : {}) });
          if (call.from.kind !== 'module') next.push(call.from);
        }
      }
      frontier = next;
    }
    if (!results.length) {
      for (const r of this.references(t, base).results) results.push({ level: 1, in: r.in, file: r.file, line: r.line, ...(isTest(r.file) ? { test: true } : {}) });
    }
    const files = [...new Set(results.map(r => r.file))];
    return { results, files: files.filter(f => !isTest(f)), tests: files.filter(isTest) };
  }
}

// ------------------------------------------------------------------ lexical (stack khác, hoặc không có typescript)
const FAMILY = { '.py': 'py', '.go': 'go', '.java': 'java', '.cs': 'java', '.kt': 'kt', '.kts': 'kt', '.php': 'php',
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'js', '.tsx': 'js', '.vue': 'js' };
const KEYWORDS = new Set(('if for while switch catch return new else do try typeof await function super throw using lock foreach '
  + 'elif with yield print in of case when select from where and or not is as sizeof').split(' '));
const MODS = '(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|default|async|override|virtual|sealed|partial|extern|unsafe|open|suspend|inline|operator|readonly)\\s+)*';
const DEFS = {
  py: [[/^\s*(?:async\s+)?def\s+(?<name>[A-Za-z_]\w*)/, 'function'], [/^\s*class\s+(?<name>[A-Za-z_]\w*)/, 'class']],
  go: [[/^func\s+(?:\([^)]*\)\s*)?(?<name>[A-Za-z_]\w*)\s*[[(]/, 'function'], [/^type\s+(?<name>[A-Za-z_]\w*)\s+(?:struct|interface)\b/, 'type']],
  java: [[/^\s*(?:[\w@]+(?:\([^)]*\))?\s+)*(?:class|interface|enum|record|struct)\s+(?<name>[A-Za-z_]\w*)/, 'class'],
    [new RegExp(`^\\s*${MODS}(?:<[^>]*>\\s*)?(?<type>[\\w.$]+)(?:<[^()]*>)?(?:\\[\\])*\\??\\s+(?<name>[A-Za-z_]\\w*)\\s*\\(`), 'method']],
  kt: [[/^\s*(?:\w+\s+)*(?:class|interface|object)\s+(?<name>[A-Za-z_]\w*)/, 'class'], [/\bfun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(?<name>[A-Za-z_]\w*)\s*\(/, 'function']],
  php: [[/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+(?<name>[A-Za-z_]\w*)/, 'class'], [/\bfunction\s+&?(?<name>[A-Za-z_]\w*)\s*\(/, 'function']],
  js: [[/\bclass\s+(?<name>[A-Za-z_$][\w$]*)/, 'class'], [/\bfunction\s*\*?\s*(?<name>[A-Za-z_$][\w$]*)\s*[<(]/, 'function'],
    [/\b(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, 'function'],
    [/^\s*(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*(?<name>[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/, 'method']]
};
const MAX_FILES = 20_000;
const MAX_BYTES = 1_500_000;

function parseDefs(lines, family) {
  const defs = [];
  lines.forEach((text, i) => {
    for (const [re, kind] of DEFS[family]) {
      const m = re.exec(text);
      if (!m || KEYWORDS.has(m.groups.name) || (m.groups.type && KEYWORDS.has(m.groups.type))) continue;
      defs.push({ name: m.groups.name, kind, line: i + 1, indent: text.match(/^\s*/)[0].length });
      break;
    }
  });
  // Phạm vi thân: Python theo thụt lề, còn lại đếm ngoặc nhọn (bỏ chuỗi và comment một dòng).
  for (const d of defs) {
    d.end = d.line;
    if (family === 'py') {
      for (let i = d.line; i < lines.length; i++) {
        const t = lines[i];
        if (!t.trim() || /^\s*#/.test(t)) continue;
        if (t.match(/^\s*/)[0].length <= d.indent) break;
        d.end = i + 1;
      }
      continue;
    }
    let depth = 0;
    let opened = false;
    for (let i = d.line - 1; i < lines.length; i++) {
      const t = lines[i].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '').replace(family === 'php' ? /\/\/.*$|#.*$/ : /\/\/.*$/, '');
      if (!opened && i === d.line - 1 && /;\s*$/.test(t) && !t.includes('{')) break;
      for (const ch of t) {
        if (ch === '{') { depth++; opened = true; } else if (ch === '}') depth--;
      }
      d.end = i + 1;
      if (opened && depth <= 0) break;
      if (!opened && i > d.line + 3) break;
    }
  }
  return defs;
}

class LexicalEngine {
  constructor(root) {
    this.name = 'lexical';
    this.root = root;
    this.note = 'lexical engine: matches by name, so same-name symbols in different classes are merged';
    this.cache = new Map();
  }

  index() {
    const seen = new Set();
    const walk = dir => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (seen.size >= MAX_FILES) return;
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (!e.name.startsWith('.') && !OUT_DIRS.test(`/${e.name}/`)) walk(p); continue; }
        const family = FAMILY[extname(e.name).toLowerCase()];
        if (!family || !e.isFile()) continue;
        seen.add(p);
        let st;
        try { st = statSync(p); } catch { continue; }
        const old = this.cache.get(p);
        if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) continue;
        if (st.size > MAX_BYTES) { this.cache.delete(p); continue; }
        const lines = readFileSync(p, 'utf8').split(/\r?\n/);
        this.cache.set(p, { mtimeMs: st.mtimeMs, size: st.size, family, lines, defs: parseDefs(lines, family) });
      }
    };
    walk(this.root);
    for (const p of this.cache.keys()) if (!seen.has(p)) this.cache.delete(p);
    return this.cache;
  }

  enclosing(entry, line) {
    let best = null;
    for (const d of entry.defs) if (d.line <= line && line <= d.end && (!best || d.end - d.line <= best.end - best.line)) best = d;
    return best;
  }

  file(base, file) {
    const p = resolve(base, file);
    if (!this.index().has(p)) fail('FILE_NOT_FOUND', `${file} is not a source file under ${relOf(base, this.root)}`);
    return p;
  }

  decl(p, d, base) {
    const container = this.cache.get(p).defs.filter(x => x !== d && x.line < d.line && d.line <= x.end).pop();
    return { name: d.name, kind: container && d.kind === 'function' ? 'method' : d.kind, ...(container ? { container: container.name } : {}),
      file: relOf(base, p), line: d.line };
  }

  find(query, base) {
    const q = query.toLowerCase();
    const rows = [];
    for (const [p, e] of this.index()) {
      for (const d of e.defs) {
        const n = d.name.toLowerCase();
        const score = n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : -1;
        if (score >= 0) rows.push({ score, test: isTest(relOf(base, p)), row: this.decl(p, d, base) });
      }
    }
    return rows.sort((a, b) => a.score - b.score || a.test - b.test).map(r => r.row);
  }

  outline(p) {
    const defs = this.cache.get(p).defs;
    return defs.map(d => ({ depth: defs.filter(x => x !== d && x.line < d.line && d.line <= x.end).length, kind: d.kind, name: d.name, line: d.line, end: d.end }));
  }

  target(base, { symbol, file, line }) {
    const index = this.index();
    if (file && line) {
      const p = this.file(base, file);
      const e = index.get(p);
      const d = e.defs.find(x => x.line === line && (!symbol || x.name === symbol.split('.').pop())) ?? this.enclosing(e, line);
      if (!d) return { notFound: true, suggestions: [] };
      return { name: d.name, defs: [[p, d]], row: this.decl(p, d, base) };
    }
    const name = symbol.split('.').pop();
    const container = symbol.includes('.') ? symbol.slice(0, symbol.lastIndexOf('.')).split('.').pop().toLowerCase() : null;
    let defs = [];
    for (const [p, e] of index) for (const d of e.defs) if (d.name === name) defs.push([p, d]);
    if (container) {
      defs = defs.filter(([p, d]) => this.decl(p, d, base).container?.toLowerCase() === container
        || relOf(base, p).split('/').pop().replace(/\..*$/, '').toLowerCase() === container);
    }
    if (file) { const p = this.file(base, file); defs = defs.filter(([q]) => q === p); }
    if (!defs.length) return { notFound: true, suggestions: this.find(name, base).slice(0, 8) };
    return { name, defs, row: this.decl(defs[0][0], defs[0][1], base), ...(defs.length > 1 ? { also: defs.length - 1 } : {}) };
  }

  isDefLine(entry, line, name) { return entry.defs.some(d => d.line === line && d.name === name); }

  scan(name, base, re) {
    const rows = [];
    for (const [p, e] of this.index()) {
      e.lines.forEach((text, i) => {
        if (!re.test(text) || this.isDefLine(e, i + 1, name)) return;
        const d = this.enclosing(e, i + 1);
        rows.push({ file: relOf(base, p), line: i + 1, in: d ? d.name : '(top level)', text: clip(text) });
      });
    }
    return rows;
  }

  references(t, base) {
    const all = this.scan(t.name, base, wordRe(t.name));
    const imp = /^\s*(import|from|using|use|require|package)\b|require\(/;
    return { results: all.filter(r => !imp.test(r.text)), importedBy: [...new Set(all.filter(r => imp.test(r.text)).map(r => r.file))] };
  }

  callers(t, base) {
    return { results: this.scan(t.name, base, new RegExp(`(?<![\\w$])${escapeRe(t.name)}\\s*\\(`)) };
  }

  callees(t, base) {
    const index = this.index();
    const known = new Map();
    for (const [p, e] of index) for (const d of e.defs) if (!known.has(d.name)) known.set(d.name, { p, d, n: 0 });
    for (const [, e] of index) for (const d of e.defs) known.get(d.name).n++;
    const [p, d] = t.defs[0];
    const calls = new Map();
    const lines = index.get(p).lines;
    for (let i = d.line; i < d.end; i++) {
      for (const m of lines[i].matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
        const k = known.get(m[1]);
        if (!k || KEYWORDS.has(m[1]) || m[1] === t.name) continue;
        const row = calls.get(m[1]) ?? { name: m[1], kind: k.d.kind, file: relOf(base, k.p), line: k.d.line, calledAt: [], ...(k.n > 1 ? { sameName: k.n } : {}) };
        row.calledAt.push(i + 1);
        calls.set(m[1], row);
      }
    }
    return { results: [...calls.values()] };
  }

  impact(t, base, { depth }) {
    const results = [];
    const seen = new Set([t.name]);
    let frontier = [t.name];
    for (let level = 1; level <= depth && frontier.length; level++) {
      const next = [];
      for (const name of frontier) {
        for (const r of this.callers({ name }, base).results) {
          const key = `${r.file}:${r.in}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({ level, in: r.in, file: r.file, line: r.line, ...(isTest(r.file) ? { test: true } : {}) });
          if (r.in !== '(top level)' && !seen.has(r.in)) { seen.add(r.in); next.push(r.in); }
        }
      }
      frontier = next;
    }
    const files = [...new Set(results.map(r => r.file))];
    return { results, files: files.filter(f => !isTest(f)), tests: files.filter(isTest) };
  }
}

// ------------------------------------------------------------------ tiến trình con
// Engine chạy trong tiến trình con: lần nạp đầu của TypeScript mất vài giây và vài trăm MB (Solova: ~4 s, 540 MB),
// không được chặn vòng lặp của helper (poller, wait_for_update) hay làm sập helper khi hết bộ nhớ. Tiến trình con
// không có biến môi trường bí mật (childEnv) vì nó chạy compiler lấy từ node_modules của repo.
const WORKER = fileURLToPath(new URL('./codegraph-worker.mjs', import.meta.url));
const IDLE_MS = 10 * 60_000;
const TIMEOUT_MS = 100_000;     // dưới tool_timeout_sec 120 của config/codex.toml

export class CodeGraph {
  constructor() {
    this.child = null;
    this.pending = new Map();
    this.seq = 0;
    this.idle = null;
  }

  start() {
    const child = fork(WORKER, [], { env: childEnv(), execArgv: ['--max-old-space-size=4096'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true, serialization: 'json' });
    let stderr = '';
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-1500); });
    child.on('message', m => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new HelperError(m.error.code, m.error.detail)); else p.resolve(m.result);
    });
    child.on('exit', code => {
      if (this.child === child) this.child = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new HelperError('CODEGRAPH_FAILED', `engine exited (${code}) ${stderr.trim().split('\n').pop() ?? ''}`.trim()));
      }
      this.pending.clear();
    });
    child.unref();
    child.channel?.unref();
    this.child = child;
  }

  async query(target, args) {
    checkArgs(args);
    if (!this.child) this.start();
    clearTimeout(this.idle);
    const id = ++this.seq;
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          this.stop();
          reject(new HelperError('CODEGRAPH_TIMEOUT', `no answer in ${TIMEOUT_MS / 1000}s; use rg for this query`));
        }, TIMEOUT_MS);
        this.pending.set(id, { resolve, reject, timer });
        this.child.send({ id, target, args });
      });
    } finally {
      if (!this.pending.size) {
        this.idle = setTimeout(() => this.stop(), IDLE_MS);
        this.idle.unref();
      }
    }
  }

  stop() {
    clearTimeout(this.idle);
    this.child?.kill();
    this.child = null;
  }
}

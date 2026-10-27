// Log Condenser (port orchestrator/logs.py): rút log build/test dài còn vài dòng và tạo chữ ký lỗi.
// Chữ ký = `compile:<file>:<thông báo>`, `<Exception>@<frame đầu tiên của code dự án>` hoặc `<Exception>@test:<tên test>`;
// không số dòng, không path worktree, nên giữ nguyên giữa các lần thử: gate dùng để biết một lỗi có lặp lại không.

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// frame thuộc thư viện / runtime, không phải code dự án
const LIB_JAVA = ['java.', 'javax.', 'jakarta.', 'jdk.', 'sun.', 'com.sun.', 'kotlin.', 'scala.', 'groovy.',
  'org.junit.', 'junit.', 'org.testng.', 'org.springframework.', 'org.apache.', 'org.mockito.',
  'org.hibernate.', 'org.assertj.', 'org.hamcrest.', 'net.bytebuddy.', 'com.fasterxml.',
  'io.netty.', 'reactor.', 'org.gradle.', 'worker.org.gradle.', 'com.intellij.'];
const LIB_PATH = ['node_modules', 'node:internal', 'site-packages', 'dist-packages', '/lib/python',
  '<frozen', '/usr/lib/', '/usr/local/go/', '/go/pkg/mod/', 'vendor/'];

// ---------------------------------------------------------------- lỗi compile (file, thông báo)
const DIR = String.raw`(?:\S*[/\\])?`;   // phần thư mục trước tên file, bỏ qua
const COMPILE = [
  String.raw`\[ERROR\]\s+${DIR}(?<file>[\w$-]+\.(?:java|kt|scala)):\[\d+(?:,\d+)?\]\s+(?<msg>.+)`,   // maven
  String.raw`${DIR}(?<file>[\w$-]+\.(?:java|kt)):\d+:\s+error:\s+(?<msg>.+)`,                         // javac, gradle
  String.raw`^e:\s+(?:file://)?${DIR}(?<file>[\w$-]+\.kt):\d+:\d+\s+(?<msg>.+)`,                      // kotlinc
  String.raw`${DIR}(?<file>[\w.-]+\.tsx?)[(:]\d+[,:]\d+\)?:?\s*-?\s*error\s+(?<msg>TS\d+:\s+.+)`,     // tsc
  String.raw`${DIR}(?<file>[\w.-]+\.cs)\(\d+,\d+\):\s+error\s+(?<msg>CS\d+:\s+.+?)(?:\s+\[.*\])?$`,   // dotnet
  String.raw`^${DIR}(?<file>[\w.-]+\.go):\d+:\d+:\s+(?<msg>.+)`,                                      // go build/vet
  String.raw`PHP Parse error:\s+(?<msg>.+?) in ${DIR}(?<file>[\w.-]+\.php)`                           // php
].map(p => new RegExp(p));
const PY_SYNTAX = /^\s*(SyntaxError|IndentationError|TabError):\s*(.+)/;
const PY_FILE = /File "([^"]+)", line \d+/;

// ---------------------------------------------------------------- exception, frame, test fail
const JAVA_FRAME = /^\s*at\s+([\w$.]+)\.([\w$<>]+)\(([^)]*)\)/;
const NODE_FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?):\d+:\d+\)?\s*$/;
const VITEST_FRAME = /^\s*❯\s+(\S+?):\d+:\d+\s*$/;
const PY_FRAME = /^\s*File "([^"]+)", line \d+, in (\S+)/;
const DOTNET_FRAME = /^\s*at\s+([\w.`<>+]+)\(.*?\)\s+in\s+(.+?):line\s+\d+/;
const GO_FRAME = /^\t(\S+\.go):\d+(?:\s+\+0x[0-9a-f]+)?\s*$/;   // frame của panic (thụt bằng tab)

const EXC_QUALIFIED = /\b((?:[a-z_][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error|Failure))\b/;
const EXC_BARE = /(?:^|[\s(\[])(?:E\s+)?([A-Z][\w$]*(?:Exception|Error|Failure))(?::|\s*$)/;
const GO_PANIC = /^panic:\s+(.+)/;

const TEST_FAIL = [
  /^\[ERROR\]\s+([\w$.]+\.[\w$]+):\d+/,                           // maven surefire summary
  /^\[ERROR\]\s+([\w$.]+)\s+Time elapsed.*<<<\s*(?:FAILURE|ERROR)/,
  /^FAILED\s+(\S+::\S+)/,                                         // pytest
  /^(?:ERROR|FAIL):\s+(\w+)\s+\(([\w.]+)\)/,                      // unittest / django
  /^\s*●\s+(.+?)\s*$/,                                            // jest
  /^\s*(?:×|✗|FAIL)\s+(\S+\.(?:test|spec)\.[jt]sx?)/,             // vitest / jest file
  /^--- FAIL:\s+(\S+)/,                                           // go
  /^\s*Failed\s+([\w.]+)\s+\[/,                                   // dotnet
  /^\s*\d+\)\s+([\w\\]+::\w+)/,                                   // phpunit
  /^\s*(\w+)\s+>\s+(\w+).*FAILED/                                 // gradle
];

const INTERESTING = /(error|exception|fail|failed|failure|assert|expected|but was|panic|traceback|tests run:.*(failures|errors): [1-9]|build failure|cannot find symbol|undefined|not defined|✗|×|●)/i;
const NOISE = /(^\[INFO\]|^\[WARNING\]|^Downloading|^Downloaded|^Progress|^\s*$|Tests run: \d+, Failures: 0, Errors: 0|^\[ERROR\]\s*$|^\[ERROR\] -> \[Help|^\[ERROR\] (To see the full|Re-run Maven|For more information|Please refer to)|^\[ERROR\] \[Help \d\]|Failed to execute goal)/i;

const PY_STDLIB = /\/python\d*[\d.]*\/lib\/|\/lib\/python\d|\/lib\/(unittest|importlib|asyncio|concurrent)\//i;
const ABSOLUTE = /^(\/|[A-Za-z]:\/)/;

// Bỏ mã màu, chuẩn hoá xuống dòng; có `root` thì bỏ đường dẫn worktree để log giống nhau giữa các lần chạy.
export function stripAnsi(text, root = null) {
  let out = String(text ?? '').replace(ANSI, '').replace(/\r\n?/g, '\n');
  if (root) {
    const r = String(root).replace(/[/\\]+$/, '');
    for (const form of new Set([r, r.replaceAll('\\', '/'), r.replaceAll('/', '\\')])) {
      out = out.replaceAll(`${form}/`, '').replaceAll(`${form}\\`, '');
    }
  }
  return out;
}

const isProjectJava = (cls, prefixes) => (prefixes.length ? prefixes.some(p => cls.startsWith(p)) : !LIB_JAVA.some(p => cls.startsWith(p)));

// `relativeOnly`: đã bỏ đường dẫn worktree khỏi log, nên file dự án là đường dẫn tương đối; đường dẫn còn tuyệt đối
// thuộc thư viện chuẩn / site-packages / máy chạy.
function isProjectPath(path, relativeOnly = false) {
  const p = path.replaceAll('\\', '/');
  if (relativeOnly && ABSOLUTE.test(p)) return false;
  return !PY_STDLIB.test(p) && !LIB_PATH.some(x => p.includes(x));
}

// Bỏ phần tuyệt đối của máy chạy, giữ tối đa 3 thành phần cuối để chữ ký giống nhau giữa các worktree.
const shortPath = path => path.split(/[/\\]/).filter(p => p && p !== '.' && p !== '..').slice(-3).join('/');

// Danh sách [file, thông báo] của lỗi compile/type-check, theo thứ tự xuất hiện.
export function compileErrors(text, limit = 10) {
  const out = [];
  const lines = stripAnsi(text).split('\n');
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const m = COMPILE.map(p => lines[i].match(p)).find(Boolean);
    if (m) { out.push([m.groups.file, m.groups.msg.trim()]); continue; }
    const s = lines[i].match(PY_SYNTAX);
    if (s) {
      let file = '?';
      for (let j = i - 1; j > Math.max(i - 6, -1); j--) {
        const f = lines[j].match(PY_FILE);
        if (f) { file = f[1]; break; }
      }
      out.push([shortPath(file).split('/').pop(), `${s[1]}: ${s[2].trim()}`]);
    }
  }
  return out;
}

function exception(lines) {
  for (const line of lines) {
    if (GO_PANIC.test(line)) return 'panic';
    const m = line.match(EXC_QUALIFIED) ?? line.match(EXC_BARE);
    if (m) return m[1].split('.').pop();
  }
  return null;
}

function projectFrame(lines, prefixes = [], relativeOnly = false) {
  for (const line of lines) {
    let m = line.match(JAVA_FRAME);
    if (m) {
      if (isProjectJava(m[1], prefixes)) return `${m[1]}.${m[2]}`;
      continue;
    }
    m = line.match(DOTNET_FRAME);
    if (m) {
      if (isProjectPath(m[2], relativeOnly) && !/^(System|Microsoft|Xunit|NUnit)\./.test(m[1])) return m[1];
      continue;
    }
    m = line.match(PY_FRAME);
    if (m) {
      if (isProjectPath(m[1], relativeOnly)) return `${shortPath(m[1])}:${m[2]}`;
      continue;
    }
    m = line.match(NODE_FRAME);
    if (m && /[/\\]/.test(m[2])) {
      if (isProjectPath(m[2], relativeOnly)) {
        const fn = (m[1] ?? '').split(' ').pop();
        return shortPath(m[2]) + (fn ? `:${fn}` : '');
      }
      continue;
    }
    m = line.match(VITEST_FRAME);
    if (m && isProjectPath(m[1], relativeOnly)) return shortPath(m[1]);
    m = line.match(GO_FRAME);
    if (m && isProjectPath(m[1], relativeOnly)) return shortPath(m[1]);
  }
  return null;
}

export function failingTestNames(text, limit = 10) {
  const out = [];
  for (const line of stripAnsi(text).split('\n')) {
    const m = TEST_FAIL.map(p => line.match(p)).find(Boolean);
    if (m) {
      const name = m.slice(1).filter(Boolean).join('.');
      if (!out.includes(name)) out.push(name);
    }
    if (out.length >= limit) break;
  }
  return out;
}

// Chữ ký lỗi ổn định, hoặc null khi log không có gì nhận ra được.
export function signature(text, { prefixes = [], root = null } = {}) {
  const clean = stripAnsi(text, root);
  const lines = clean.split('\n');
  const comp = compileErrors(clean, 1);
  if (comp.length) return `compile:${comp[0][0]}:${comp[0][1].replace(/\d+/g, 'N').slice(0, 120)}`;
  const exc = exception(lines);
  const frame = projectFrame(lines, prefixes, Boolean(root));
  if (frame) return `${exc ?? 'Error'}@${frame}`;
  const tests = failingTestNames(clean, 1);
  if (tests.length) return `${exc ?? 'TestFailure'}@test:${tests[0]}`;
  return exc;
}

// Giữ dòng quan trọng (lỗi compile, test fail, assertion, exception + 2 frame dự án); không có thì lấy đuôi log.
export function condense(text, { maxLines = 40, maxChars = 4000, root = null } = {}) {
  const lines = stripAnsi(text, root).split('\n');
  const keep = [];
  const seen = new Set();
  let framesLeft = 0;
  const add = line => {
    const s = line.trimEnd().slice(0, 300);
    if (s && !seen.has(s)) { seen.add(s); keep.push(s); }
  };
  for (const line of lines) {
    if (JAVA_FRAME.test(line) || PY_FRAME.test(line) || DOTNET_FRAME.test(line) || VITEST_FRAME.test(line) ||
        (NODE_FRAME.test(line) && line.trimStart().startsWith('at '))) {
      if (framesLeft > 0 && projectFrame([line]) !== null) { add(line); framesLeft--; }
      continue;
    }
    if (NOISE.test(line)) continue;
    if (INTERESTING.test(line) || COMPILE.some(p => p.test(line))) {
      add(line);
      if (EXC_QUALIFIED.test(line) || EXC_BARE.test(line) || line.includes('Traceback')) framesLeft = 2;
    }
    if (keep.length >= maxLines) break;
  }
  const picked = keep.length ? keep.slice(0, maxLines)
    : lines.filter(l => l.trim()).slice(-Math.min(20, maxLines)).map(l => l.trimEnd().slice(0, 300));
  const out = picked.join('\n');
  return out.length <= maxChars ? out : `${out.slice(0, maxChars - 15)}\n...(truncated)`;
}

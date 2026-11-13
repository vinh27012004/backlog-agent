// Checklist của một đề: luật code lập lúc prepare (ruleChecklist) từ MVS, template, schema và chữ đề, đưa vào brief
// (<checklist>) và kiểm ở candidate (checklistProblems, workflow.checklistGate). Từ sau CUZ7KL95 (13/11) không còn
// team_analyst: mọi dòng đều do luật code viết. Chỉ lấy thứ có sẵn dạng cấu trúc: evidence từng kịch bản trong MVS
// (mvsEvidence), evidence đề nêu ngoài MVS (itemEvidence), trường trả lời của đề chỉ trả lời (template + schema), dòng
// mutants khi đề chấm khả năng phát hiện lỗi (decide/signals.mjs gradingRules), các dòng kịch bản của template.
// Dòng zero_condition và minViewport vẫn được kiểm khi một luật sau này thêm chúng.
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';

const STANDARD_FIELDS = new Set(['status', 'schemaVersion', 'backlogId', 'evidenceFiles', 'testResults', 'engineeringRecord', 'requirements', 'gitRevision', 'sourceChanges', 'cases']);
export function ruleChecklist({ key = null, scenarioIds = [], mvsEvidence = new Map(), required = [], template = null, schema = null, answerOnly = false, detection = false } = {}) {
  const lines = [];
  const kind = file => (/\.(png|jpe?g|webp)$/i.test(file) ? 'screenshot' : 'other');
  const evidence = e => ({ id: `evidence:${e.scenario ?? '-'}:${e.file}`, kind: 'evidence', scenario: e.scenario, file: e.file, beforeFix: Boolean(e.beforeFix), minViewport: null,
    text: `evidence/${e.file}${e.scenario ? ` for ${e.scenario} (cited in that row's evidence when you report PASS)` : ''}${e.beforeFix ? ', captured on the unfixed code' : ''}${kind(e.file) === 'screenshot' ? ' — a real page, not a *.FAILED-step* capture' : ''}` });
  for (const id of scenarioIds) for (const file of mvsEvidence.get(id) ?? []) lines.push(evidence({ scenario: id, file }));
  for (const e of required) lines.push(evidence({ scenario: null, file: e.file, beforeFix: e.beforeFix }));
  if (answerOnly && template && typeof template === 'object' && !Array.isArray(template)) {
    for (const [name, value] of Object.entries(template)) {
      if (STANDARD_FIELDS.has(name)) continue;
      const declared = schema?.properties?.[name]?.type;
      const type = typeof declared === 'string' ? declared : jsonType(value);
      if (!['string', 'number', 'integer', 'object'].includes(type)) continue;
      lines.push({ id: `field:${name}`, kind: 'field', name, type, exact: false, text: `submit.json ${name}: ${type}, filled` });
    }
  }
  if (detection) lines.push({ id: 'detection:mutants', kind: 'mutants', text: 'run_checks {action: "mutants"} on your final source: graders run your tests against broken builds, each change needs a test that fails without it' });
  for (const id of scenarioIds) lines.push({ id: `scenario:${id}`, kind: 'scenario', scenario: id, text: `${id} reported PASS, FAIL or NOT_RUN with what you observed (NOT_RUN scores nothing)` });
  const seen = new Set();
  return lines.filter(l => !seen.has(l.id) && seen.add(l.id)).map(l => ({ ...l, key }));
}

const megabytes = bytes => (bytes >= 1048576 ? `${Number((bytes / 1048576).toFixed(2))} MB` : bytes >= 1024 ? `${Number((bytes / 1024).toFixed(1))} KB` : `${bytes} bytes`);

// Kích thước ảnh PNG từ IHDR (byte 16..23, big-endian); null khi file không bắt đầu bằng chữ ký PNG. Chỉ đọc 24 byte.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function pngSize(file) {
  let fd = null;
  try {
    fd = openSync(file, 'r');
    const head = Buffer.alloc(24);
    if (readSync(fd, head, 0, 24, 0) < 24 || !head.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch { return null; } finally { if (fd !== null) closeSync(fd); }
}

// Tổng dung lượng file hoặc thư mục (đệ quy, không theo symlink/junction: node_modules liên kết của worktree trỏ vào
// checkout chính). Dừng sớm khi đã vượt limit. null khi đường dẫn không có.
function sizeOf(path, limit = Infinity) {
  let st;
  try { st = lstatSync(path); } catch { return null; }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  const stack = [path];
  while (stack.length && total <= limit) {
    let entries = [];
    const dir = stack.pop();
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of entries) {
      if (d.isSymbolicLink()) continue;
      const full = join(dir, d.name);
      if (d.isDirectory()) stack.push(full);
      else { try { total += lstatSync(full).size; } catch { /* file vừa bị xoá */ } }
    }
  }
  return total;
}

const jsonType = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const typeOk = (v, t) => jsonType(v) === t || (t === 'number' && typeof v === 'number');
const empty = v => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) || (jsonType(v) === 'object' && !Object.keys(v).length);

// Kiểm checklist trên bài đang bàn giao. answerDir: answers/<ID> của worktree; matchRoot: thư mục trận của worktree
// (không có thì bỏ qua các kiểm tra cần nó); changed: đường dẫn (trong thư mục trận) item đã thêm/sửa; exists(path):
// file có trong worktree. Trả về [{ id, problem }]: chỉ những dòng chưa đạt mà code kiểm được chắc chắn (dòng mutants,
// typecheck, scenario do các gate sẵn có lo).
export function checklistProblems(lines, { answerDir, matchRoot = null, changed = [], exists = () => false } = {}) {
  const out = [];
  let submit = null;
  try { submit = JSON.parse(readFileSync(join(answerDir, 'submit.json'), 'utf8')); } catch { return out; }   // answerCheck báo lỗi này
  const rows = new Map((Array.isArray(submit?.testResults) ? submit.testResults : []).map(r => [r?.id, r]));
  const passed = id => /^pass$/i.test(String(rows.get(id)?.result ?? ''));
  for (const line of Array.isArray(lines) ? lines : []) {
    if (line.kind === 'evidence') {
      const there = existsSync(join(answerDir, 'evidence', line.file));
      if (line.scenario === null) {
        if (!there) out.push({ id: line.id, problem: `evidence/${line.file} is missing: the item requires it${line.beforeFix ? ' (captured on the unfixed code)' : ''}` });
      } else if (passed(line.scenario)) {
        const cited = (Array.isArray(rows.get(line.scenario)?.evidence) ? rows.get(line.scenario).evidence : []).some(e => String(e).split('/').pop() === line.file);
        if (!there) out.push({ id: line.id, problem: `${line.scenario} is PASS but evidence/${line.file} does not exist: capture it or report the scenario as observed` });
        else if (!cited) out.push({ id: line.id, problem: `${line.scenario} is PASS but its evidence does not cite evidence/${line.file}, which the item requires for it` });
      }
      // Ảnh nhỏ hơn viewport đề đòi (WQ7T6CEC CR-07 TC-03: PNG "at a desktop viewport of at least 1280x720").
      const min = /^(\d+)x(\d+)$/.exec(line.minViewport ?? '');
      if (min && there && (line.scenario === null || passed(line.scenario))) {
        const size = pngSize(join(answerDir, 'evidence', line.file));
        if (size && (size.width < Number(min[1]) || size.height < Number(min[2]))) {
          out.push({ id: `viewport:${line.scenario ?? '-'}:${line.file}`, problem: `evidence/${line.file} is ${size.width}x${size.height}, smaller than the ${line.minViewport} the item requires: capture it again at a viewport of at least ${line.minViewport}` });
        }
      }
    } else if (line.kind === 'field') {
      if (!Object.hasOwn(submit ?? {}, line.name) || empty(submit[line.name])) out.push({ id: line.id, problem: `submit.json ${line.name} is empty: the item scores it${line.exact ? ' by exact comparison' : ''}` });
      else if (!typeOk(submit[line.name], line.type)) out.push({ id: line.id, problem: `submit.json ${line.name} must be ${line.type}, it is ${jsonType(submit[line.name])}` });
    } else if (line.kind === 'source') {
      const tail = line.path.replaceAll('\\', '/').replace(/^\.?\//, '');
      // 33R91I3Q TASK-08 bị từ chối vì "không sửa" các file đề nêu làm đối tượng viết test: file có sẵn trong repo là đạt.
      if (!changed.some(p => p === tail || p.endsWith(`/${tail}`)) && !exists(tail)) out.push({ id: line.id, problem: `${line.path} does not exist: the item names this file` });
    } else if (line.kind === 'zero_condition') {
      const tail = line.path.replaceAll('\\', '/').replace(/^\.?\//, '').replace(/\/+$/, '');
      if (line.zeroKind === 'required_file') {
        // Không có matchRoot thì chỉ biết answers/ và exists(): không đủ để nói file thiếu.
        const found = existsSync(join(answerDir, tail)) || (matchRoot && existsSync(join(matchRoot, tail))) || exists(tail);
        if (!found && matchRoot) out.push({ id: line.id, problem: `${line.path} does not exist in the item's answers folder or the match folder: the item scores 0 without it` });
      } else if (line.zeroKind === 'max_size' && matchRoot) {
        const base = [join(matchRoot, tail), join(answerDir, tail)].find(p => existsSync(p));
        const size = base ? sizeOf(base, line.maxBytes) : null;
        if (size !== null && size > line.maxBytes) out.push({ id: line.id, problem: `${line.path} is ${megabytes(size)} or more, above the ${megabytes(line.maxBytes)} limit: the item scores 0 above it; make it smaller` });
      }
    }
  }
  return out;
}

export function checklistBlock(lines) {
  return ['Every line must hold before worker_checkpoint candidate; candidate checks them and names the ones that fail.',
    ...lines.map((l, i) => `${i + 1}. ${l.text}`)].join('\n');
}


// Manifest ở ngoài checkout: phân biệt before/final, giữ nguồn gốc và hash bytes của mỗi artifact.
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { digest } from '../core/candidates.mjs';
import { writeFileAtomic } from '../core/util.mjs';

const manifestFile = (teamWork, key) => join(teamWork, 'evidence', `${key}.json`);
export function recordEvidence(teamWork, key, entry) {
  const file = manifestFile(teamWork, key);
  let data = { version: 1, entries: [] };
  if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8'));
  data.entries = [...data.entries.filter(e => e.path !== entry.path), entry];
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
  return entry;
}

// Evidence final chụp trên source cũ chỉ dùng lại khi môi trường như cũ và `unchangedForItem(entry)` xác nhận sync
// chỉ mang về test/tài liệu không chạy trong app. File runtime của item khác cũng có thể làm ảnh không còn đúng.
export async function evidenceProblems(teamWork, key, matchRoot, snapshot, { unchangedForItem = null } = {}) {
  const file = manifestFile(teamWork, key);
  if (!existsSync(file)) return []; // Artifact cũ vẫn được reviewer kiểm nội dung.
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const evidence = join(matchRoot, 'answers', key, 'evidence');
  const problems = [];
  let passed = new Set();
  try {
    const answer = JSON.parse(readFileSync(join(matchRoot, 'answers', key, 'submit.json'), 'utf8'));
    passed = new Set((answer.testResults ?? []).filter(r => r.result === 'PASS').flatMap(r => r.evidence ?? []));
  } catch { /* answerCheck báo lỗi schema/file riêng */ }
  const sameForItem = async entry => Boolean(unchangedForItem && await unchangedForItem(entry).catch(() => false));
  const groups = new Map();
  for (const entry of manifest.entries) {
    const id = `${entry.name}\0${entry.phase}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(entry);
  }
  const canonical = path => typeof path !== 'string' ? '' : process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  for (const entries of groups.values()) {
    const target = join(evidence, entries[0].name);
    const exists = existsSync(target) && statSync(target).isFile();
    const bytes = exists ? digest(readFileSync(target)) : null;
    // Hai worktree có thể chụp cùng tên file. Ưu tiên provenance đúng đường dẫn; khi đã copy/publish thì đối chiếu bytes.
    const exact = entries.filter(e => canonical(e.path) === canonical(target));
    const pool = exact.length ? exact : entries.filter(e => bytes && e.sha256 === bytes);
    const entry = pool.at(-1) ?? entries.at(-1);
    if (entry.role === 'diagnostic') {
      if (passed.has(`evidence/${entry.name}`)) problems.push(`evidence/${entry.name}: diagnostic image from a failed capture cannot support PASS`);
      continue;
    }
    if (!exists) { problems.push(`missing evidence/${entry.name}`); continue; }
    if (bytes !== entry.sha256) problems.push(`evidence/${entry.name}: bytes changed since capture`);
    if (entry.phase === 'final' && (entry.environment !== snapshot.environment
      || entry.source !== snapshot.source && !await sameForItem(entry))) {
      problems.push(`evidence/${entry.name}: final evidence belongs to an older source/environment; recapture after sync/restart`);
    }
  }
  return problems;
}

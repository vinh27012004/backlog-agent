// Manifest ở ngoài checkout: phân biệt before/final, giữ nguồn gốc và hash bytes của mỗi artifact.
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

export function evidenceProblems(teamWork, key, matchRoot, snapshot) {
  const file = manifestFile(teamWork, key);
  if (!existsSync(file)) return []; // Artifact cũ vẫn được reviewer kiểm nội dung.
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const evidence = join(matchRoot, 'answers', key, 'evidence');
  const problems = [];
  for (const entry of manifest.entries) {
    const target = join(evidence, entry.name);
    if (!existsSync(target) || !statSync(target).isFile()) { problems.push(`missing evidence/${entry.name}`); continue; }
    if (digest(readFileSync(target)) !== entry.sha256) problems.push(`evidence/${entry.name}: bytes changed since capture`);
    if (entry.phase === 'final' && (entry.source !== snapshot.source || entry.environment !== snapshot.environment)) {
      problems.push(`evidence/${entry.name}: final evidence belongs to an older source/environment; recapture after sync/restart`);
    }
  }
  return problems;
}

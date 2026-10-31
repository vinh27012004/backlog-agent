// Dấu vân tay source do helper quản lý, độc lập schema/hash nội bộ của codegraph.
// Kiểm cả file mới/xoá và nội dung chưa commit; bỏ vật liệu, answers và index.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { git } from '../core/git.mjs';
import { writeFileAtomic } from '../core/util.mjs';

const EXCLUDE = ['answers', 'challenge', '.team-work', '.codegraph', 'env-require'];
const MAX_FILES = 10_000;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_OUTPUT = 1024 * 1024; // git() giữ tối đa tailBytes * 4 ký tự stdout.
export const codegraphStampPath = root => join(root, '.codegraph', 'team-source.json');

// Không lấy một phần danh sách/hash rồi coi là đầy đủ. Thiếu ngân sách hoặc file không đọc được → unknown.
export async function codegraphSourceSnapshot(root, { budgetMs = 1500 } = {}) {
  if (!root) return null;
  const until = Date.now() + budgetMs;
  try {
    const result = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.',
      ...EXCLUDE.map(p => `:(exclude)${p}/**`)], { cwd: root, timeoutMs: Math.max(1, budgetMs), allowFail: true });
    if (result.code !== 0 || result.stdout.length >= MAX_OUTPUT || Date.now() > until) return null;
    const paths = [...new Set(result.stdout.split('\0').filter(Boolean))].sort();
    if (paths.length > MAX_FILES) return null;
    const hash = createHash('sha256');
    let bytes = 0;
    for (const path of paths) {
      if (Date.now() > until) return null;
      const absolute = resolve(root, path), rel = relative(resolve(root), absolute);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) return null;
      let stat;
      try { stat = lstatSync(absolute); } catch (error) {
        if (error.code !== 'ENOENT') return null;
        hash.update(`${JSON.stringify([path, null])}\n`);
        continue;
      }
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || (bytes += stat.size) > MAX_BYTES) return null;
      const content = readFileSync(absolute);
      const after = lstatSync(absolute);
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || Date.now() > until) return null;
      hash.update(`${JSON.stringify([path, createHash('sha256').update(content).digest('hex')])}\n`);
    }
    return { fingerprint: hash.digest('hex'), files: paths.length };
  } catch { return null; }
}

export function saveCodegraphSnapshot(root, snapshot) {
  writeFileAtomic(codegraphStampPath(root), `${JSON.stringify({ schemaVersion: 1, projectPath: resolve(root),
    ...snapshot, indexedAt: new Date().toISOString() })}\n`);
}

export async function codegraphFreshness(root) {
  if (!root || !existsSync(join(root, '.codegraph', 'codegraph.db'))) return { freshness: 'unknown', reason: 'index_missing' };
  let saved;
  try { saved = JSON.parse(readFileSync(codegraphStampPath(root), 'utf8')); } catch {
    return { freshness: 'unknown', reason: 'source_stamp_missing' };
  }
  if (saved.schemaVersion !== 1 || saved.projectPath !== resolve(root) || !/^[a-f0-9]{64}$/.test(saved.fingerprint ?? '')) {
    return { freshness: 'unknown', reason: 'source_stamp_invalid' };
  }
  const current = await codegraphSourceSnapshot(root);
  if (!current) return { freshness: 'unknown', reason: 'source_check_incomplete' };
  return current.fingerprint === saved.fingerprint ? { freshness: 'fresh' } : { freshness: 'stale', reason: 'source_changed' };
}

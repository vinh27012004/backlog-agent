// Codegraph (@colbymchenry/codegraph, MCP server thứ hai trong .codex/config.toml): installer cài vào
// team-sdlc-pack/codegraph/, Codex chạy `serve --mcp`, agent gọi tool codegraph_* với projectPath = thư mục trận.
// Server không tự index: gọi lên thư mục chưa index thì nó bảo agent thôi dùng codegraph cả phiên. Nên helper dựng
// index (.codegraph/ trong thư mục trận, đã nằm trong .git/info/exclude) cho checkout chính lúc setup_environment
// và cho worktree ở nền khi `worktree create` (WQ7T6CEC: dựng index trên đường găng làm prepare mất ~45 s, 12 thợ chỉ
// gọi codegraph 3 lần); thợ gọi trước khi index xong thì server bảo thôi dùng codegraph, thợ vẫn còn rg.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv, run } from '../core/jobs.mjs';
import { codegraphFreshness, codegraphSourceSnapshot, codegraphStampPath, saveCodegraphSnapshot } from './codegraph-state.mjs';

export const CODEGRAPH = JSON.parse(readFileSync(new URL('../../config/codegraph.json', import.meta.url), 'utf8'));

// Telemetry tắt; không tự tải bundle từ GitHub giữa trận khi bản cài thiếu (shim tự làm vậy nếu không cấm).
export const CODEGRAPH_ENV = { CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_DOWNLOAD: '1' };

export function codegraphShim(teamWorkspace) {
  if (!teamWorkspace) return null;
  const dir = join(teamWorkspace, 'team-sdlc-pack', 'codegraph', 'node_modules', ...CODEGRAPH.package.split('/'));
  try {
    if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version !== CODEGRAPH.version) return null;
  } catch { return null; }
  return existsSync(join(dir, 'npm-shim.js')) ? join(dir, 'npm-shim.js') : null;
}

// init lần đầu, sync khi đã có index (chạy lại setup, worktree tạo lại). Không bao giờ làm hỏng bước gọi nó.
export async function indexCodegraph({ teamWorkspace, matchRoot, logFile, timeoutMs = 120_000 }) {
  const shim = codegraphShim(teamWorkspace);
  if (!shim) return { name: 'codegraph', skipped: 'not installed' };
  const before = await codegraphSourceSnapshot(matchRoot);
  // Index lỗi/dở không được giữ dấu "fresh" của lần trước.
  try { rmSync(codegraphStampPath(matchRoot), { force: true }); } catch {
    return { name: 'codegraph', code: -1, freshness: 'unknown', tail: 'could not invalidate source stamp' };
  }
  const args = existsSync(join(matchRoot, '.codegraph')) ? ['sync', matchRoot] : ['init', '-y', matchRoot];
  let res;
  try { res = await run(process.execPath, [shim, ...args], { cwd: matchRoot, env: childEnv(CODEGRAPH_ENV), timeoutMs, logFile }); }
  catch { return { name: 'codegraph', code: -1, freshness: 'unknown', tail: 'index could not start' }; }
  const after = res.code === 0 ? await codegraphSourceSnapshot(matchRoot) : null;
  let freshness = before && after && before.fingerprint === after.fingerprint
    && existsSync(join(matchRoot, '.codegraph', 'codegraph.db')) ? 'fresh' : 'unknown';
  if (freshness === 'fresh') {
    try { saveCodegraphSnapshot(matchRoot, after); } catch { freshness = 'unknown'; }
  }
  return { name: 'codegraph', code: res.code, freshness, seconds: Math.round(res.ms / 1000),
    ...(res.code ? { tail: res.tail.trim().split(/\r?\n/).slice(-3).join('\n') } : {}) };
}

// Chỉ sync khi source đổi hoặc chưa chứng minh được độ mới; không tải/cài giữa trận.
export async function ensureCodegraphIndex(options) {
  if (!options.matchRoot) return { name: 'codegraph', skipped: 'project missing', freshness: 'unknown' };
  if (!codegraphShim(options.teamWorkspace)) return { name: 'codegraph', skipped: 'not installed', freshness: 'unknown' };
  const state = await codegraphFreshness(options.matchRoot);
  return state.freshness === 'fresh' ? { name: 'codegraph', code: 0, freshness: 'fresh', seconds: 0 }
    : indexCodegraph(options);
}

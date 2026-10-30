// Codegraph (@colbymchenry/codegraph, MCP server thứ hai trong .codex/config.toml): installer cài vào
// team-sdlc-pack/codegraph/, Codex chạy `serve --mcp`, agent gọi tool codegraph_* với projectPath = thư mục trận.
// Server không tự index: gọi lên thư mục chưa index thì nó bảo agent thôi dùng codegraph cả phiên. Nên helper dựng
// index (.codegraph/ trong thư mục trận, đã nằm trong .git/info/exclude) cho checkout chính lúc setup_environment
// và cho worktree ngay trong `worktree create`, trước khi root kịp giao việc cho fixer.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv, run } from '../core/jobs.mjs';

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
  const args = existsSync(join(matchRoot, '.codegraph')) ? ['sync', matchRoot] : ['init', '-y', matchRoot];
  const res = await run(process.execPath, [shim, ...args], { cwd: matchRoot, env: childEnv(CODEGRAPH_ENV), timeoutMs, logFile });
  return { name: 'codegraph', code: res.code, seconds: Math.round(res.ms / 1000), ...(res.code ? { tail: res.tail.trim().split(/\r?\n/).slice(-3).join('\n') } : {}) };
}

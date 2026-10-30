// Proxy giữa các tiến trình helper (05 §5.22, D4). Mỗi subagent có tiến trình helper riêng, chưa configure_session
// (transcript 27/10: /root/bug02_fix1 gọi read_item nhận NOT_CONFIGURED). Helper của root mở một named pipe (Windows)
// hoặc Unix socket, ghi tên và token vào team-sdlc-pack/local/; helper của subagent chuyển một danh sách tool đóng
// sang đó. Credential không đi qua pipe; journal và progress log vẫn chỉ có một writer là helper của root.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HelperError, fail, writeFileAtomic } from './util.mjs';

// Tool subagent gọi được qua proxy. Root vẫn tự kiểm từng lời gọi (Runtime.proxyCall): run_gate chỉ trên worktree và
// chỉ từ file fix-result, worktree chỉ status. Tool Game Master, git publish và progress không bao giờ có ở đây.
export const PROXY_TOOLS = new Set(['read_item', 'run_gate', 'job_status', 'worktree']);
const MAX_LINE = 1024 * 1024;

export const endpointFile = teamWorkspace => join(teamWorkspace, 'team-sdlc-pack', 'local', 'runtime-endpoint.json');

const pipePath = id => (process.platform === 'win32' ? `\\\\.\\pipe\\team-runtime-${id}` : join(tmpdir(), `team-runtime-${id}.sock`));

const sameToken = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Phía root: `handle(name, args)` trả kết quả MCP ({content, structuredContent, isError}). unref: không giữ tiến trình.
export async function startProxyServer({ teamWorkspace, playerSessionId, handle }) {
  const id = randomBytes(8).toString('hex');
  const token = randomBytes(24).toString('hex');
  const path = pipePath(id);
  const server = createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) { socket.destroy(); return; }
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let req;
        try { req = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!sameToken(req?.token, token)) { socket.destroy(); return; }
        Promise.resolve().then(() => handle(req.name, req.arguments ?? {}))
          .then(result => socket.write(`${JSON.stringify({ id: req.id, result })}\n`))
          .catch(() => socket.destroy());
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  server.unref();
  const file = endpointFile(teamWorkspace);
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ path, token, pid: process.pid, playerSessionId, startedAt: new Date().toISOString() }));
  return {
    path,
    close() {
      server.close();
      try { if (JSON.parse(readFileSync(file, 'utf8')).path === path) rmSync(file, { force: true }); } catch { /* đã mất */ }
    }
  };
}

// Phía subagent: gửi một lời gọi tới helper của root, trả nguyên kết quả MCP của nó.
export function forward(teamWorkspace, name, args, { timeoutMs = 118_000, signal } = {}) {
  const file = endpointFile(teamWorkspace);
  const notReady = 'the orchestrator helper is not running (no endpoint); only the orchestrator can call this tool now';
  if (!teamWorkspace || !existsSync(file)) fail('NOT_CONFIGURED', notReady);
  let endpoint;
  try { endpoint = JSON.parse(readFileSync(file, 'utf8')); } catch { fail('NOT_CONFIGURED', notReady); }
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.path);
    let buffer = '';
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => finish(new HelperError('CANCELLED', 'the call was cancelled'));
    const timer = setTimeout(() => finish(new HelperError('PROXY_TIMEOUT', `no answer from the orchestrator helper in ${timeoutMs} ms`)), timeoutMs);
    signal?.addEventListener('abort', onAbort);
    socket.setEncoding('utf8');
    socket.on('error', () => finish(new HelperError('NOT_CONFIGURED', notReady)));
    socket.on('close', () => finish(new HelperError('PROXY_FAILED', 'the orchestrator helper closed the connection')));
    socket.on('data', chunk => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      try { finish(null, JSON.parse(buffer.slice(0, nl)).result); } catch { finish(new HelperError('PROXY_FAILED', 'bad answer from the orchestrator helper')); }
    });
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 1, token: endpoint.token, name, arguments: args })}\n`));
  });
}

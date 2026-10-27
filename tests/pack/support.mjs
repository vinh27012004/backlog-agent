// Hạ tầng test cho pack: đường dẫn source Player (oracle), workspace tạm, client MCP, Game Master giả.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, '..', '..');
export const PACK = join(REPO, 'pack');
export const PLAYER_SRC = process.env.MTM_PLAYER_SRC ?? join(REPO, 'vendor', 'mtm-player-0.9.35', 'app', 'src');
export const hasPlayer = existsSync(join(PLAYER_SRC, 'progress.mjs'));

export const player = async name => import(pathToFileURL(join(PLAYER_SRC, name)).href);

export function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function install(teamWorkspace) {
  const res = spawnSync(process.execPath, [join(PACK, 'scripts', 'install.mjs'), '--team-workspace', teamWorkspace], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`install failed: ${res.stdout} ${res.stderr}`);
  return JSON.parse(res.stdout.trim().split('\n').pop());
}

export function sh(cmd, args, cwd, env = process.env) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', env });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

// Client MCP qua stdio cho helper đã cài.
export class McpClient {
  constructor(serverPath, env) {
    this.child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    let buf = '';
    this.child.stdout.on('data', d => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = JSON.parse(line);
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      }
    });
    this.child.stderr.on('data', d => { this.stderr += d; });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async call(name, args = {}) {
    const msg = await this.request('tools/call', { name, arguments: args });
    if (msg.error) throw new Error(`${name}: ${msg.error.message}`);
    const value = msg.result.structuredContent;
    if (msg.result.isError) {
      const err = new Error(`${name}: ${value.error.code} ${value.error.message}`);
      err.code = value.error.code;
      throw err;
    }
    return value;
  }

  close() { this.child.kill(); }
}

// Repo bài thi giả: bare remote + insteadOf để URL https trỏ về file cục bộ.
export function makeRemote(root, matchId) {
  const work = join(root, 'seed');
  const bare = join(root, 'remote.git');
  mkdirSync(join(work, matchId, 'src'), { recursive: true });
  mkdirSync(join(work, matchId, 'answers'), { recursive: true });
  writeFileSync(join(work, matchId, 'exam-info.json'), '{"immutable":true}\n');
  writeFileSync(join(work, matchId, 'answers', 'README.md'), 'answers\n');
  const app = join(work, matchId, 'src');
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', private: true,
    scripts: { build: 'node build.js', test: 'node test.js' } }, null, 2));
  writeFileSync(join(app, 'package-lock.json'), JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'app', version: '1.0.0' } } }, null, 2));
  writeFileSync(join(app, 'build.js'), "require('./lib.js'); console.log('build ok');\n");
  writeFileSync(join(app, 'lib.js'), 'module.exports = { greet: () => "hello" };\n');
  writeFileSync(join(app, 'test.js'), [
    "const { greet } = require('./lib.js');",
    "const ok = greet() === 'hello' || greet() === 'hello world';",
    "console.log(` Tests  ${ok ? '2 passed' : '1 passed | 1 failed'} (2)`);",
    'process.exit(ok ? 0 : 1);', ''].join('\n'));
  writeFileSync(join(app, '.env.example'), 'DATABASE_URL="postgresql://app:CHANGE_ME@127.0.0.1:5433/app"\nAUTH_SECRET="CHANGE_ME"\n');
  writeFileSync(join(app, '.gitignore'), '.env\nnode_modules/\n');
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'seed', GIT_AUTHOR_EMAIL: 'seed@x', GIT_COMMITTER_NAME: 'seed', GIT_COMMITTER_EMAIL: 'seed@x' };
  sh('git', ['init', '-q', '-b', 'main'], work, gitEnv);
  sh('git', ['add', '-A'], work, gitEnv);
  sh('git', ['commit', '-q', '-m', 'seed'], work, gitEnv);
  sh('git', ['clone', '-q', '--bare', work, bare], root, gitEnv);
  const url = 'https://example.test/team/repo';
  const gitconfig = join(root, 'gitconfig');
  writeFileSync(gitconfig, `[url "${pathToFileURL(bare).href}"]\n\tinsteadOf = ${url}\n[safe]\n\tdirectory = *\n[protocol "file"]\n\tallow = always\n`);
  return { url, bare, gitconfig };
}

// Game Master giả, đủ cho luồng của helper (03 §2.4, §3, §4).
export function fakeGameMaster({ matchId, matchUuid, repository, password = 'pw-123456', apiKey }) {
  const state = { status: 'PREPARING', elapsedSec: 0, remainingSec: 2400, seq: 1, backlog: [], submissions: new Map(),
    started: new Set(), calls: [] };
  const sessions = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const chunk of req) body += chunk;
    state.calls.push(`${req.method} ${url.pathname}`);
    const send = (status, value, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'X-Request-Id': `req_${state.calls.length}`, Date: new Date().toUTCString(), ...headers });
      res.end(JSON.stringify(value));
    };
    const cookie = (req.headers.cookie ?? '').match(/sid=([a-z0-9-]+)/)?.[1];
    const bearer = req.headers.authorization === `Bearer ${apiKey}`;
    if (req.method === 'POST' && url.pathname === '/api/v1/auth/login') {
      // Server thật trả 403 "Origin check failed" khi thiếu Origin cùng origin (Practice 26/10).
      if (req.headers.origin !== `http://${req.headers.host}`) return send(403, { error: { code: 'FORBIDDEN', message: 'Origin check failed.' } });
      const { username, password: pw } = JSON.parse(body || '{}');
      if (username !== 'team-bun' || pw !== password) return send(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' } });
      const sid = randomUUID();
      sessions.add(sid);
      return send(200, { user: { role: 'CUDER' } }, { 'Set-Cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (req.method === 'GET' && url.pathname === `/api/v1/match/${matchId}`) {
      if (!sessions.has(cookie)) return send(401, { error: { code: 'UNAUTHENTICATED', message: 'Login required.' } });
      return send(200, { match: { publicId: matchId, status: state.status, elapsedSec: state.elapsedSec, remainingSec: state.remainingSec, currentSequence: state.seq },
        team: { code: 'BUN' }, repository: { ...repository, folder: `${matchId}/` },
        api: { startEndpoint: `/api/v1/matches/${matchUuid}/backlogs/start`, submissionEndpoint: `/api/v1/matches/${matchUuid}/submissions`,
          feedEndpoint: `/api/v1/match/${matchId}/feed`, pollActiveMs: 2000, pollIdleMs: 10000 },
        backlog: state.backlog, events: [] });
    }
    if (req.method === 'GET' && url.pathname === `/api/v1/match/${matchId}/feed`) {
      return send(200, { items: Number(url.searchParams.get('afterSequence')) < state.seq ? [{ sequence: state.seq }] : [] });
    }
    if (req.method === 'POST' && url.pathname === `/api/v1/matches/${matchUuid}/backlogs/start`) {
      if (!bearer) return send(401, { error: { code: 'INVALID_API_KEY', message: 'bad key' } });
      const { backlogItemKey } = JSON.parse(body);
      const item = state.backlog.find(b => b.key === backlogItemKey);
      if (!item) return send(404, { error: { code: 'BACKLOG_ITEM_NOT_FOUND', message: 'no item' } });
      const replay = state.started.has(backlogItemKey);
      state.started.add(backlogItemKey);
      return send(replay ? 200 : 201, { backlogId: backlogItemKey, backlogType: item.type, startInstruction: 'Fill the template.',
        submitTemplate: { backlogId: backlogItemKey, status: 'DRAFT', changeSummary: '' },
        minimumVerificationScenarios: null, replay, files: {
          [`challenge/${backlogItemKey}-submit.json`]: '{}',
          [`challenge/${backlogItemKey}-submit.schema.json`]: JSON.stringify({ type: 'object', required: ['backlogId', 'status', 'changeSummary'],
            properties: { backlogId: { const: backlogItemKey }, status: { enum: ['SUBMITTED', 'PARTIAL'] }, changeSummary: { type: 'string', minLength: 10 },
              evidence: { type: 'array', items: { type: 'string', pattern: '^evidence/' } } } })
        } });
    }
    if (req.method === 'POST' && url.pathname === `/api/v1/matches/${matchUuid}/submissions`) {
      if (!bearer) return send(401, { error: { code: 'INVALID_API_KEY', message: 'bad key' } });
      const key = req.headers['idempotency-key'];
      const parsed = JSON.parse(body);
      const stored = state.submissions.get(key);
      if (stored) {
        if (stored.body !== body) return send(409, { error: { code: 'IDEMPOTENCY_CONFLICT', message: 'conflict' } });
        return send(201, { submission: stored.submission }, { 'Idempotent-Replay': 'true' });
      }
      if ([...state.submissions.values()].some(s => s.submission.backlogItemKey === parsed.backlogItemKey)) {
        return send(409, { error: { code: 'ALREADY_SUBMITTED', message: 'already' } });
      }
      if (!state.started.has(parsed.backlogItemKey)) return send(409, { error: { code: 'BACKLOG_NOT_STARTED', message: 'start first' } });
      const submission = { id: randomUUID(), matchId: matchUuid, backlogItemKey: parsed.backlogItemKey, status: 'ACCEPTED', scoreStatus: 'PENDING', receivedAt: new Date().toISOString() };
      state.submissions.set(key, { body, submission, parsed });
      return send(201, { submission });
    }
    send(404, { error: { code: 'NOT_FOUND', message: url.pathname } });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ server, state, origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
  }));
}

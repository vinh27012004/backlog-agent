// configure_session: parse frame của Player, kiểm descriptor, giữ secret trong RAM (05 §5.1).
import { join } from 'node:path';
import { registerSecret } from './redact.mjs';
import { assertNoLinks, expectAbsolute, samePath } from './paths.mjs';
import { fail, isId, isObject, sha256 } from './util.mjs';

const MARKERS = {
  PREPARE_GAME_V2: 'PREPARE_GAME',
  START_GAME_V4: 'START_GAME',
  RESUME_PREPARATION_V1: 'RESUME_PREPARATION',
  RESUME_GAME_V1: 'RESUME_GAME'
};
const POLICY_MARKERS = ['MTM_SUBMISSION_POLICY_V1', 'MTM_MODEL_POLICY_V1'];
// Player 0.9.35–0.9.39 gửi `submission:create` (bootstrap.mjs:13); guide 0.5.1 ghi `submissions:create`. Nhận cả hai.
const SUBMIT_SCOPES = ['submission:create', 'submissions:create'];

// Frame = dòng marker + dòng JSON, rồi các khối policy (dòng trống + marker + JSON). Không parse cả prompt.
export function parseFrame(frame) {
  if (typeof frame !== 'string' || frame.length > 1024 * 1024) fail('INVALID_FRAME', 'frame must be a string');
  const lines = frame.split(/\r?\n/);
  const start = lines.findIndex(l => Object.hasOwn(MARKERS, l.trim()));
  if (start < 0) fail('INVALID_FRAME', 'no known marker line');
  const marker = lines[start].trim();
  let descriptor;
  try { descriptor = JSON.parse(lines[start + 1]); } catch { fail('INVALID_FRAME', 'descriptor line is not JSON'); }
  if (!isObject(descriptor) || descriptor.schemaVersion !== 1 || descriptor.type !== MARKERS[marker]) {
    fail('INVALID_FRAME', 'marker and descriptor.type differ');
  }
  const policies = {};
  for (let i = start + 2; i < lines.length; i++) {
    const m = lines[i].trim();
    if (!POLICY_MARKERS.includes(m)) continue;
    try { policies[m] = JSON.parse(lines[i + 1]); } catch { fail('INVALID_FRAME', `${m} is not JSON`); }
  }
  return { marker, descriptor, policies };
}

const httpsOrigin = (value, name) => {
  let u;
  try { u = new URL(value); } catch { fail('INVALID_FRAME', `${name} is not a URL`); }
  const loopback = process.env.MTM_TEAM_TEST_MODE === '1' && u.protocol === 'http:' && u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !loopback) fail('INVALID_FRAME', `${name} must be https`);
  return u.origin;
};

export class Session {
  constructor() {
    this.phase = null;           // PREPARE | GAME
    this.descriptor = null;      // bản không secret
    this.secrets = {};           // username, password, apiKey
    this.policies = {};
    this.paths = null;
    this.origins = { match: [], api: [] };
  }

  get configured() { return this.descriptor !== null; }

  configure(frame, teamWorkspace) {
    const { marker, descriptor: d, policies } = parseFrame(frame);
    const type = d.type;
    for (const key of ['requestId', 'playerSessionId', 'teamId', 'matchId']) {
      if (!isId(d[key])) fail('INVALID_FRAME', `${key}`);
    }
    if (this.descriptor && this.descriptor.playerSessionId !== d.playerSessionId) {
      fail('SESSION_MISMATCH', 'playerSessionId changed in this helper process');
    }
    if (!teamWorkspace) fail('NOT_CONFIGURED', 'helper is not installed inside a TeamWorkspace');
    if (d.teamWorkspace && !samePath(d.teamWorkspace, teamWorkspace)) fail('PATH_OUTSIDE_WORKSPACE', 'teamWorkspace');

    const checkoutRoot = expectAbsolute(d.checkoutRoot, 'checkoutRoot');
    const matchRoot = expectAbsolute(d.matchRoot, 'matchRoot');
    const progressLogFile = expectAbsolute(d.progressLogFile, 'progressLogFile');
    const repo = d.repository;
    if (repo !== undefined) {
      if (!isObject(repo) || repo.folder !== d.matchId) fail('INVALID_FRAME', 'repository.folder must equal matchId');
    }
    if (!samePath(checkoutRoot, join(teamWorkspace, 'matches', d.matchId))) fail('PATH_OUTSIDE_WORKSPACE', 'checkoutRoot');
    if (!samePath(matchRoot, join(checkoutRoot, d.matchId))) fail('PATH_OUTSIDE_WORKSPACE', 'matchRoot');
    if (!samePath(progressLogFile, join(teamWorkspace, 'team-sdlc-pack', 'logs', `${d.matchId}.progress.ndjson`))) {
      fail('PATH_OUTSIDE_WORKSPACE', 'progressLogFile');
    }
    assertNoLinks(teamWorkspace, checkoutRoot);
    assertNoLinks(teamWorkspace, progressLogFile);

    const secrets = { ...this.secrets };
    if (typeof d.username === 'string' && typeof d.password === 'string') {
      secrets.username = d.username;
      secrets.password = d.password;
    }
    if (type === 'START_GAME' || type === 'RESUME_GAME') {
      const key = d.apiKeySecret;
      if (typeof key !== 'string' || Buffer.byteLength(key, 'utf8') !== d.apiKeyLength || sha256(key) !== d.apiKeySha256) {
        fail('API_KEY_INTEGRITY_MISMATCH');
      }
      if (!Array.isArray(d.apiKeyScopes) || !d.apiKeyScopes.some(s => SUBMIT_SCOPES.includes(s))) {
        fail('INVALID_FRAME', 'apiKeyScopes lacks submission:create');
      }
      secrets.apiKey = key;
      if (!secrets.password) fail('NEEDS_PREPARATION_FRAME', 'send the PREPARE_GAME_V2 frame from this thread first, then this frame again');
    }
    for (const value of Object.values(secrets)) registerSecret(value);

    const matchPage = d.matchPageUrl ?? this.descriptor?.matchPageUrl;
    const matchOrigins = (d.allowedMatchOrigins ?? this.origins.match).map(o => httpsOrigin(o, 'allowedMatchOrigins'));
    if (matchPage && !matchOrigins.includes(httpsOrigin(matchPage, 'matchPageUrl'))) {
      fail('INVALID_FRAME', 'matchPageUrl origin is not allowed');
    }
    const apiOrigins = (d.allowedApiOrigins ?? this.origins.api).map(o => httpsOrigin(o, 'allowedApiOrigins'));

    // Bản không secret của descriptor, gộp với bản trước (START không có username/repository...).
    const { username, password, apiKeySecret, ...publicPart } = d;
    this.descriptor = { ...(this.descriptor ?? {}), ...publicPart };
    this.secrets = secrets;
    this.policies = { ...this.policies, ...policies };
    this.phase = type === 'START_GAME' || type === 'RESUME_GAME' ? 'GAME' : 'PREPARE';
    this.type = type;
    this.marker = marker;
    this.origins = { match: matchOrigins, api: apiOrigins.length ? apiOrigins : this.origins.api };
    this.paths = { teamWorkspace, checkoutRoot, matchRoot, progressLogFile,
      teamWork: join(checkoutRoot, '.team-work'), local: join(teamWorkspace, 'team-sdlc-pack', 'local') };
    return this;
  }

  require(phase) {
    if (!this.configured) fail('NOT_CONFIGURED', 'call configure_session with the frame first');
    if (phase && this.phase !== phase) fail('NOT_CONFIGURED', `tool needs the ${phase} phase, current ${this.phase}`);
  }

  get gameMasterOrigin() {
    return new URL(this.descriptor.matchPageUrl).origin;
  }

  get models() {
    const p = this.policies.MTM_MODEL_POLICY_V1;
    return p ? { orchestratorModel: p.orchestratorModel, allowedModels: p.allowedModels ?? [] } : null;
  }
}

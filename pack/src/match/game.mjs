// Game Master (docs/team-pack/03): đăng nhập trang, đọc trận qua JSON của chính trang,
// Start Work và Submit. Mọi request tới Game Master được ghi GAME_MASTER_API.
import { HelperError, deterministicUuid, fail, oneLine } from '../core/util.mjs';

const START_PATH = /^\/api\/v1\/matches\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/backlogs\/start$/i;
const SUBMIT_PATH = /^\/api\/v1\/matches\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/submissions$/i;

const errorCode = res => res.json?.error?.code ?? null;
const errorMessage = res => oneLine(res.json?.error?.message ?? `HTTP ${res.status}`, 160);

export class GameMaster {
  constructor({ session, http, progress }) {
    this.session = session;
    this.http = http;
    this.progress = progress;     // () => ProgressWriter
    this.view = null;
    this.fetchedAt = 0;
    this.loggedIn = false;
  }

  get origin() { return this.session.gameMasterOrigin; }

  // Ghi một event GAME_MASTER_API; hết ngân sách log thì bỏ qua event phụ (REFRESH).
  api(operation, phase, { method, url, status = null, requestId = null, backlogId = null, summary, optional = false }) {
    const u = url ? new URL(url) : null;
    try {
      this.progress().write({ type: 'GAME_MASTER_API', operation, backlogId, method,
        origin: u ? u.origin : null, path: u ? u.pathname : null, phase,
        httpStatus: phase === 'REQUESTED' ? null : (phase === 'FAILED' && status !== null && status < 400 ? null : status),
        requestId, summary }, { optional });
    } catch (error) {
      if (!(error instanceof HelperError)) throw error;
    }
  }

  async login() {
    const { username, password } = this.session.secrets;
    if (!username || !password) fail('NEEDS_PREPARATION_FRAME', 'no match credentials in this helper process');
    const url = `${this.origin}/api/v1/auth/login`;
    this.api('LOGIN', 'REQUESTED', { method: 'POST', url, summary: 'Login to the match portal.' });
    let res;
    try {
      res = await this.http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json',
        Origin: this.origin, Referer: `${this.origin}/login` }, body: JSON.stringify({ username, password }) });
    } catch (error) {
      this.api('LOGIN', 'FAILED', { method: 'POST', url, summary: 'Login request failed.' });
      throw error;
    }
    const ok = res.status >= 200 && res.status < 300;
    this.api('LOGIN', ok ? 'SUCCEEDED' : 'FAILED', { method: 'POST', url, status: res.status, requestId: res.requestId,
      summary: ok ? 'Logged in to the match portal.' : `Login rejected: ${errorMessage(res)}` });
    if (!ok) fail('LOGIN_FAILED', errorMessage(res));
    this.loggedIn = true;
    return res.json;
  }

  // GET /api/v1/match/<matchId>: nguồn dữ liệu thật của trang /match/<matchId> (03 §2.4).
  // log: false cho poll nhanh (trước START_GAME, quanh mốc ra đề): như feed, chỉ networkActivity, không GAME_MASTER_API
  // (hai dòng khoảng 600 byte mỗi lần đọc, poll 250 ms thì vượt trần log 230 KB trong vài phút).
  async fetchMatch({ optional = false, log = true } = {}) {
    const matchId = this.session.descriptor.matchId;
    const url = `${this.origin}/api/v1/match/${encodeURIComponent(matchId)}`;
    const api = log ? (...args) => this.api(...args) : () => {};
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.loggedIn) await this.login();
      api('REFRESH', 'REQUESTED', { method: 'GET', url, summary: 'Refresh match page.', optional });
      let res;
      try {
        res = await this.http.request(url, { headers: { Accept: 'application/json' } });
      } catch (error) {
        api('REFRESH', 'FAILED', { method: 'GET', url, summary: 'Match refresh failed.', optional });
        throw error;
      }
      if (res.status === 401 && attempt === 0) {
        api('REFRESH', 'FAILED', { method: 'GET', url, status: 401, requestId: res.requestId, summary: 'Session expired.', optional });
        this.loggedIn = false;
        continue;
      }
      const ok = res.status >= 200 && res.status < 300 && res.json;
      api('REFRESH', ok ? 'SUCCEEDED' : 'FAILED', { method: 'GET', url, status: res.status, requestId: res.requestId,
        summary: ok ? 'Match page refreshed.' : `Match refresh failed: ${errorMessage(res)}`, optional });
      if (res.status === 401) fail('MATCH_LOGIN_AUTHENTICATION_REQUIRED', 'still 401 after login');
      if (!ok) fail('REFRESH_FAILED', errorMessage(res));
      this.view = normalizeMatch(res.json, this.origin);
      this.fetchedAt = Date.now();
      return this.view;
    }
    fail('REFRESH_FAILED');
  }

  // Feed delta: rẻ, không ghi log (chỉ networkActivity). true = có thay đổi, cần đọc lại trận.
  async feedChanged() {
    const feed = this.view?.api?.feedEndpoint;
    const seq = this.view?.currentSequence;
    if (!feed || seq === null || seq === undefined) return true;
    const url = new URL(feed, this.origin);
    url.searchParams.set('afterSequence', String(seq));
    const res = await this.http.request(url.href, { headers: { Accept: 'application/json' } });
    if (res.status === 401) { this.loggedIn = false; return true; }
    if (res.status === 409) return true;
    if (res.status < 200 || res.status >= 300) return false;
    return Array.isArray(res.json?.items) && res.json.items.length > 0;
  }

  // Ước lượng thời gian còn lại theo đồng hồ trận, cộng thời gian trôi từ lần đọc nếu trận đang chạy.
  elapsedSec() {
    const m = this.view;
    if (!m || typeof m.elapsedSec !== 'number') return null;
    return m.status === 'IN_PROGRESS' ? m.elapsedSec + (Date.now() - this.fetchedAt) / 1000 : m.elapsedSec;
  }

  remainingSec() {
    const m = this.view;
    if (!m || typeof m.remainingSec !== 'number') return null;
    const r = m.status === 'IN_PROGRESS' ? m.remainingSec - (Date.now() - this.fetchedAt) / 1000 : m.remainingSec;
    return Math.max(0, r);
  }

  itemMinutesLeft(item) {
    const elapsed = this.elapsedSec();
    const match = this.remainingSec();
    let left = match === null ? null : match / 60;
    if (typeof item.deadlineMinutes === 'number' && typeof item.revealedElapsedSec === 'number' && elapsed !== null) {
      const own = item.deadlineMinutes - (elapsed - item.revealedElapsedSec) / 60;
      left = left === null ? own : Math.min(left, own);
    }
    return left === null ? null : Math.round(left * 10) / 10;
  }

  // forCall: sắp gửi bearer tới URL này, nên origin phải thuộc allowedApiOrigins (chỉ có ở phase GAME).
  endpoint(kind, { forCall = true } = {}) {
    const raw = kind === 'start' ? this.view?.api?.startEndpoint : this.view?.api?.submissionEndpoint;
    if (!raw) fail('MATCH_UUID_NOT_FOUND', `no ${kind} endpoint on the match page`);
    const url = new URL(raw, this.origin);
    const re = kind === 'start' ? START_PATH : SUBMIT_PATH;
    const m = url.pathname.match(re);
    if (!m) fail('MATCH_UUID_NOT_FOUND', `unexpected ${kind} endpoint path`);
    if (forCall && !this.session.origins.api.includes(url.origin)) fail('ORIGIN_NOT_ALLOWED', url.origin);
    return { url: `${url.origin}${url.pathname}`, matchUuid: m[1].toLowerCase() };
  }

  bearer() {
    const key = this.session.secrets.apiKey;
    if (!key) fail('NOT_CONFIGURED', 'no team API key: needs START_GAME or RESUME_GAME frame');
    return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  // Start Work: idempotent ở server (200 replay), nên thử lại khi lỗi mạng/5xx.
  async startWork(key) {
    const { url } = this.endpoint('start');
    const body = JSON.stringify({ backlogItemKey: key });
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      this.api('START_WORK', 'REQUESTED', { method: 'POST', url, backlogId: key, summary: 'Start Work requested.' });
      let res;
      try {
        res = await this.http.request(url, { method: 'POST', headers: this.bearer(), body, timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024, cookies: false });
      } catch (error) {
        this.api('START_WORK', 'FAILED', { method: 'POST', url, backlogId: key, summary: 'Start Work network error.' });
        last = error;
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      const ok = res.status === 200 || res.status === 201;
      this.api('START_WORK', ok ? 'SUCCEEDED' : 'FAILED', { method: 'POST', url, backlogId: key, status: res.status,
        requestId: res.requestId, summary: ok ? (res.json?.replay ? 'Start Work replayed.' : 'Start Work accepted.') : `Start Work rejected: ${errorCode(res) ?? res.status}` });
      if (ok) return res.json;
      if (res.status >= 500) { last = new HelperError('GM_UNAVAILABLE', String(res.status)); continue; }
      fail('START_WORK_REJECTED', `${errorCode(res) ?? res.status}: ${errorMessage(res)}`);
    }
    throw last ?? new HelperError('GM_UNAVAILABLE');
  }

  submissionId(matchUuid, key, revision, n) {
    return deterministicUuid(`mtm-submit:v1|${matchUuid}|${key}|${revision}|${n}`);
  }

  // Gửi đúng chuỗi body đã lưu trong journal. Trả {kind, ...}: SUBMITTED | RETRY | REJECTED | ALREADY.
  async postSubmission(key, intent) {
    const { url } = this.endpoint('submit');
    const headers = { ...this.bearer(), 'Idempotency-Key': intent.clientSubmissionId };
    this.api('SUBMIT', 'REQUESTED', { method: 'POST', url, backlogId: key, summary: 'Submission sent.' });
    let res;
    try {
      res = await this.http.request(url, { method: 'POST', headers, body: intent.body, timeoutMs: 30_000, maxBytes: 512 * 1024, cookies: false });
    } catch (error) {
      this.api('SUBMIT', 'FAILED', { method: 'POST', url, backlogId: key, summary: 'Submission network error; will retry same body.' });
      return { kind: 'RETRY', reason: error.code ?? 'NETWORK_ERROR' };
    }
    const id = res.json?.submission?.id;
    const ok = res.status >= 200 && res.status < 300 && typeof id === 'string';
    const code = errorCode(res);
    this.api('SUBMIT', ok ? 'SUCCEEDED' : 'FAILED', { method: 'POST', url, backlogId: key, status: res.status,
      requestId: res.requestId, summary: ok ? 'Submission accepted.' : `Submission rejected: ${code ?? res.status}` });
    if (ok) return { kind: 'SUBMITTED', submission: res.json.submission, replay: res.headers.get('idempotent-replay') === 'true' };
    if (res.status >= 200 && res.status < 300) return { kind: 'RETRY', reason: 'no submission.id in 2xx' };
    if (res.status >= 500 || res.status === 429 || code === 'IDEMPOTENCY_CONFLICT') {
      return { kind: 'RETRY', reason: code ?? String(res.status), retryAfter: Number(res.headers.get('retry-after')) || null };
    }
    if (code === 'ALREADY_SUBMITTED') return { kind: 'ALREADY', reason: code };
    if (code === 'MATCH_NOT_ACCEPTING_SUBMISSIONS' || code === 'BACKLOG_NOT_STARTED' ||
        code === 'BACKLOG_ITEM_NOT_VISIBLE' || code === 'NOT_OPEN') return { kind: 'RETRY', reason: code };
    return { kind: 'REJECTED', reason: code ?? String(res.status), message: errorMessage(res), status: res.status };
  }
}

// Chuẩn hoá response của GET /api/v1/match/<id> thành MatchView (03 §2.3). Giữ raw item để root đọc.
export function normalizeMatch(raw, origin) {
  const m = raw?.match ?? {};
  const backlog = Array.isArray(raw?.backlog) ? raw.backlog : [];
  return {
    matchId: m.publicId ?? m.code ?? m.id ?? null,
    status: m.status ?? 'UNKNOWN',
    elapsedSec: typeof m.elapsedSec === 'number' ? m.elapsedSec : null,
    remainingSec: typeof m.remainingSec === 'number' ? m.remainingSec : null,
    currentSequence: m.currentSequence ?? null,
    team: raw?.team ?? null,
    repository: raw?.repository ?? null,
    api: raw?.api ?? {},
    items: backlog.map(b => ({
      key: b.key, type: b.type ?? String(b.key ?? '').split('-')[0], title: b.title ?? b.key,
      status: b.status ?? 'UNKNOWN', points: b.points ?? null, deadlineMinutes: b.deadlineMinutes ?? null,
      revealedElapsedSec: b.revealedElapsedSec ?? null, revisionNo: b.revisionNo ?? null, raw: b
    })),
    events: Array.isArray(raw?.events) ? raw.events : [],
    origin,
    raw
  };
}

// Progress log NDJSON (docs/team-pack/04): validator bản sao luật của Player 0.9.33
// (src/progress.mjs validateProgressEvent + reduceProgressEvents), writer chỉ append, ngân sách byte.
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { HelperError, exactKeys, isId, oneLine } from './util.mjs';

const credentialValue = /(?:authorization\s*:\s*bearer\s+\S{8,}|\b(?:password|secret|api[-_ ]?key|access[-_ ]?token)\s*[:=]\s*\S{8,}|\b(?:gm|gh[pousr])_[A-Za-z0-9_-]{12,})/i;
const safeText = (value, max) => typeof value === 'string' && value.length > 0 &&
  value.length <= max && !/[\r\n\0]/.test(value) && !credentialValue.test(value);
const nullableId = value => value === null || isId(value);
const nullableRevision = value => value === null || (typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value));
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 100_000;
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const safeOrigin = value => {
  if (!safeText(value, 256)) return false;
  try {
    const u = new URL(value);
    const loopback = u.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(u.hostname);
    return (u.protocol === 'https:' || loopback) && u.origin === value && !u.username && !u.password &&
      u.pathname === '/' && !u.search && !u.hash;
  } catch { return false; }
};
const safePath = value => safeText(value, 512) && value.startsWith('/') && !/[?#\\]/.test(value);

export const PREPARATION_STAGES = ['GIT_AUTH', 'REPOSITORY', 'ENVIRONMENT', 'BUILD', 'MATCH_LOGIN'];
const STAGE_STATUSES = ['IN_PROGRESS', 'COMPLETED', 'BLOCKED', 'FAILED'];
const BACKLOG_STATUSES = ['DISCOVERED', 'IN_PROGRESS', 'COMPLETED', 'SUBMITTED', 'BLOCKED', 'FAILED'];
const TEST_STATUSES = ['NOT_RUN', 'RUNNING', 'PASSED', 'FAILED'];
const API_PHASES = ['REQUESTED', 'SUCCEEDED', 'FAILED'];
const TRANSITIONS = {
  DISCOVERED: ['DISCOVERED', 'IN_PROGRESS', 'SUBMITTED', 'BLOCKED', 'FAILED'],
  IN_PROGRESS: ['IN_PROGRESS', 'COMPLETED', 'SUBMITTED', 'BLOCKED', 'FAILED'],
  COMPLETED: ['COMPLETED', 'IN_PROGRESS', 'SUBMITTED', 'BLOCKED', 'FAILED'],
  BLOCKED: ['BLOCKED', 'IN_PROGRESS', 'SUBMITTED', 'FAILED'],
  FAILED: ['FAILED', 'IN_PROGRESS', 'SUBMITTED'],
  SUBMITTED: ['SUBMITTED']
};

const BASE = ['schemaVersion', 'playerSessionId', 'type'];
const KEYS = {
  ORCHESTRATOR_STARTED: ['summary'],
  ORCHESTRATOR_RESTARTED: ['attempt', 'phase', 'reason', 'summary'],
  PREPARATION_STATUS: ['stage', 'status', 'summary'],
  ENVIRONMENT_READY: ['requestId', 'repository', 'revision', 'build', 'matchLogin'],
  GAME_START_STATUS: ['stage', 'status', 'summary'],
  BACKLOG_STATUS: ['backlogId', 'title', 'status', 'summary', 'revision', 'receiptId'],
  BACKLOG_TESTS: ['backlogId', 'status', 'required', 'executed', 'passed', 'failed', 'skipped', 'summary'],
  GAME_MASTER_API: ['operation', 'backlogId', 'method', 'origin', 'path', 'phase', 'httpStatus', 'requestId', 'summary'],
  BLOCKER_OPENED: ['blockerId', 'backlogId', 'summary'],
  BLOCKER_RESOLVED: ['blockerId', 'summary'],
  ORCHESTRATOR_ENDED: ['status', 'summary']
};

// Kiểm một event theo đúng luật của Player. Trả lý do sai, hoặc null nếu hợp lệ.
export function eventProblem(e, playerSessionId) {
  if (!isId(playerSessionId) || e?.schemaVersion !== 1 || e?.playerSessionId !== playerSessionId) return 'envelope';
  const keys = KEYS[e.type];
  if (!keys) return `type ${e.type} not allowed`;
  if (!exactKeys(e, [...BASE, ...keys])) return 'exact keys';
  const summaryOk = e.type === 'ENVIRONMENT_READY' || safeText(e.summary, 240);
  if (!summaryOk) return 'summary (1-240 chars, single line, no credential-like text)';
  switch (e.type) {
    case 'ORCHESTRATOR_STARTED': return null;
    case 'ORCHESTRATOR_RESTARTED':
      return Number.isSafeInteger(e.attempt) && e.attempt >= 1 && e.attempt <= 10_000 &&
        ['PREPARATION', 'GAME'].includes(e.phase) && isId(e.reason) ? null : 'restart fields';
    case 'PREPARATION_STATUS':
      return [...PREPARATION_STAGES, 'PREPARE_COMPLETE'].includes(e.stage) && STAGE_STATUSES.includes(e.status) ? null : 'stage/status';
    case 'GAME_START_STATUS':
      return e.stage === 'BACKLOG_SYNC' && STAGE_STATUSES.includes(e.status) ? null : 'stage/status';
    case 'ENVIRONMENT_READY': {
      if (!isId(e.requestId) || e.build !== 'PASS' || e.matchLogin !== 'PASS' || !nullableRevision(e.revision) ||
          e.revision === null || !exactKeys(e.repository, ['url', 'branch', 'folder']) ||
          !safeText(e.repository.url, 4096) || !safeText(e.repository.branch, 255) ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(e.repository.folder)) return 'readiness fields';
      try {
        const u = new URL(e.repository.url);
        if (u.protocol !== 'https:' || u.username || u.password) return 'repository url';
      } catch { return 'repository url'; }
      return null;
    }
    case 'BACKLOG_STATUS':
      return isId(e.backlogId) && safeText(e.title, 160) && BACKLOG_STATUSES.includes(e.status) &&
        nullableRevision(e.revision) && nullableId(e.receiptId) &&
        (e.status !== 'SUBMITTED' || (e.revision !== null && e.receiptId !== null)) ? null : 'backlog fields';
    case 'BACKLOG_TESTS': {
      const nums = [e.required, e.executed, e.passed, e.failed, e.skipped];
      return isId(e.backlogId) && TEST_STATUSES.includes(e.status) && nums.every(count) &&
        e.executed === e.passed + e.failed + e.skipped &&
        (e.status !== 'NOT_RUN' || e.executed === 0) &&
        (e.status !== 'PASSED' || (e.executed > 0 && e.failed === 0 && e.executed >= e.required)) &&
        (e.status !== 'FAILED' || e.failed > 0) ? null : 'test counts';
    }
    case 'GAME_MASTER_API':
      return isId(e.operation) && nullableId(e.backlogId) && (e.method === null || methods.includes(e.method)) &&
        (e.origin === null || safeOrigin(e.origin)) && (e.path === null || safePath(e.path)) &&
        API_PHASES.includes(e.phase) && nullableId(e.requestId) &&
        (e.httpStatus === null || (Number.isSafeInteger(e.httpStatus) && e.httpStatus >= 100 && e.httpStatus <= 599)) &&
        (e.phase !== 'REQUESTED' || e.httpStatus === null) &&
        (e.phase !== 'SUCCEEDED' || (e.httpStatus >= 200 && e.httpStatus < 300)) &&
        (e.phase !== 'FAILED' || e.httpStatus === null || e.httpStatus >= 400) ? null : 'api fields';
    case 'BLOCKER_OPENED': return isId(e.blockerId) && nullableId(e.backlogId) ? null : 'blocker fields';
    case 'BLOCKER_RESOLVED': return isId(e.blockerId) ? null : 'blocker fields';
    case 'ORCHESTRATOR_ENDED': return ['COMPLETED', 'BLOCKED', 'FAILED'].includes(e.status) ? null : 'status';
    default: return 'type';
  }
}

// Trạng thái dựng từ log, để kiểm luật chuyển trạng thái trước khi ghi.
export function emptyState() {
  return { started: false, restartCount: 0, ended: false, backlogs: {}, blockers: {}, stages: {},
    gameStart: null, environmentReady: null, bytes: 0, lines: 0 };
}

// Áp một event hợp lệ vào state. Trả lý do vi phạm chuyển trạng thái, hoặc null.
export function applyEvent(state, e, { dryRun = false } = {}) {
  const s = dryRun ? structuredClone(state) : state;
  if (s.ended && e.type !== 'ORCHESTRATOR_RESTARTED') return 'log already ended';
  switch (e.type) {
    case 'ORCHESTRATOR_STARTED':
      if (s.started) return 'ORCHESTRATOR_STARTED twice';
      s.started = true; break;
    case 'ORCHESTRATOR_RESTARTED':
      if (!s.started || e.attempt !== s.restartCount + 1) return `restart attempt must be ${s.restartCount + 1}`;
      s.restartCount = e.attempt; s.ended = false; break;
    case 'PREPARATION_STATUS': s.stages[e.stage] = e.status; break;
    case 'GAME_START_STATUS': s.gameStart = e.status; break;
    case 'ENVIRONMENT_READY': {
      const text = JSON.stringify([e.requestId, e.repository, e.revision]);
      if (s.environmentReady && s.environmentReady !== text) return 'ENVIRONMENT_READY_CONFLICT';
      s.environmentReady = text; break;
    }
    case 'BACKLOG_STATUS': {
      const prev = s.backlogs[e.backlogId];
      if (prev && e.status === 'DISCOVERED') break;
      if (prev && !TRANSITIONS[prev.status].includes(e.status)) return `transition ${prev.status} -> ${e.status}`;
      s.backlogs[e.backlogId] = { status: e.status, title: e.title, revision: e.revision, receiptId: e.receiptId };
      if (e.status === 'SUBMITTED') {
        for (const [id, b] of Object.entries(s.blockers)) if (b === e.backlogId) delete s.blockers[id];
      }
      break;
    }
    case 'BACKLOG_TESTS':
      if (!s.backlogs[e.backlogId]) return 'BACKLOG_TESTS before BACKLOG_STATUS';
      s.backlogs[e.backlogId].tests = e.status; break;
    case 'BLOCKER_OPENED':
      if (Object.hasOwn(s.blockers, e.blockerId)) return 'blocker already open';
      s.blockers[e.blockerId] = e.backlogId; break;
    case 'BLOCKER_RESOLVED':
      if (!Object.hasOwn(s.blockers, e.blockerId)) return 'blocker not open';
      delete s.blockers[e.blockerId]; break;
    case 'ORCHESTRATOR_ENDED':
      if (e.status === 'COMPLETED' && Object.keys(s.blockers).length) return 'COMPLETED with open blockers';
      s.ended = true; break;
    default: break;
  }
  return null;
}

// Ngân sách byte (04 §7): trần cứng của Player 256 KB, của đội 230 KB.
export const LOG_HARD_LIMIT = 230 * 1024;
const ESSENTIAL = new Set(['ENVIRONMENT_READY', 'BACKLOG_STATUS', 'BACKLOG_TESTS', 'BLOCKER_OPENED',
  'BLOCKER_RESOLVED', 'ORCHESTRATOR_ENDED', 'ORCHESTRATOR_RESTARTED', 'PREPARATION_STATUS', 'GAME_START_STATUS']);

export class ProgressWriter {
  constructor(path, playerSessionId) {
    this.path = path;
    this.playerSessionId = playerSessionId;
    this.state = emptyState();
    this.reload();
  }

  // Đọc lại toàn bộ log (lúc configure / resume). Dòng không hợp lệ bị bỏ qua như Player làm.
  reload() {
    this.state = emptyState();
    if (!existsSync(this.path)) return;
    const text = readFileSync(this.path, 'utf8');
    this.state.bytes = Buffer.byteLength(text, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (eventProblem(e, this.playerSessionId)) continue;
      applyEvent(this.state, e);
      this.state.lines += 1;
    }
  }

  budgetLevel() {
    const b = this.state.bytes;
    return b < 150 * 1024 ? 0 : b < 200 * 1024 ? 1 : b < LOG_HARD_LIMIT ? 2 : 3;
  }

  // Ghi một event (không có envelope). Không hợp lệ thì ném EVENT_INVALID, không ghi gì.
  write(partial, { optional = false } = {}) {
    const event = { schemaVersion: 1, playerSessionId: this.playerSessionId, ...partial };
    if (typeof event.summary === 'string') {
      event.summary = oneLine(event.summary, this.budgetLevel() >= 1 ? 60 : 200) || 'Update.';
    }
    if (typeof event.title === 'string') event.title = oneLine(event.title, 160) || event.backlogId;
    const problem = eventProblem(event, this.playerSessionId);
    if (problem) throw new HelperError('EVENT_INVALID', `${event.type}: ${problem}`);
    const transition = applyEvent(this.state, event, { dryRun: true });
    if (transition) throw new HelperError(transition === 'ENVIRONMENT_READY_CONFLICT' ? transition : 'EVENT_INVALID', transition);
    const line = `${JSON.stringify(event)}\n`;
    const size = Buffer.byteLength(line, 'utf8');
    if (size > 16 * 1024) throw new HelperError('EVENT_INVALID', 'line > 16 KB');
    if (this.state.bytes + size > LOG_HARD_LIMIT && (optional || !ESSENTIAL.has(event.type))) {
      return { written: false, reason: 'LOG_BUDGET_EXCEEDED' };
    }
    appendFileSync(this.path, line, { encoding: 'utf8' });
    applyEvent(this.state, event);
    this.state.bytes += size;
    this.state.lines += 1;
    return { written: true, event };
  }

  size() {
    try { return statSync(this.path).size; } catch { return this.state.bytes; }
  }
}

// Validator log của đội phải cho cùng kết quả với validateProgressEvent của Player 0.9.33.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventProblem, ProgressWriter } from '../../pack/src/progress.mjs';
import { hasPlayer, player, tempDir } from './support.mjs';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const sid = '7b0c9d1e-2f3a-4b5c-8d6e-0f1a2b3c4d5e';
const base = { schemaVersion: 1, playerSessionId: sid };
const sha = 'a'.repeat(40);

const samples = [
  { type: 'ORCHESTRATOR_STARTED', summary: 'Team orchestrator started.' },
  { type: 'PREPARATION_STATUS', stage: 'GIT_AUTH', status: 'COMPLETED', summary: 'ok' },
  { type: 'PREPARATION_STATUS', stage: 'GIT_AUTH', status: 'PASS', summary: 'ok' },
  { type: 'PREPARATION_STATUS', stage: 'BUILD', status: 'COMPLETED', summary: 'line\nbreak' },
  { type: 'PREPARATION_STATUS', stage: 'BUILD', status: 'COMPLETED', summary: 'api key: verified-123' },
  { type: 'PREPARATION_STATUS', stage: 'BUILD', status: 'COMPLETED', summary: 'ok', extra: 1 },
  { type: 'ENVIRONMENT_READY', requestId: 'prepare-1', repository: { url: 'https://github.com/a/b', branch: 'main', folder: 'ABCD1234' }, revision: sha, build: 'PASS', matchLogin: 'PASS' },
  { type: 'ENVIRONMENT_READY', requestId: 'prepare-1', repository: { url: 'http://github.com/a/b', branch: 'main', folder: 'ABCD1234' }, revision: sha, build: 'PASS', matchLogin: 'PASS' },
  { type: 'ENVIRONMENT_READY', requestId: 'prepare-1', repository: { url: 'https://github.com/a/b', branch: 'main', folder: 'ABCD1234' }, revision: null, build: 'PASS', matchLogin: 'PASS' },
  { type: 'GAME_START_STATUS', stage: 'BACKLOG_SYNC', status: 'IN_PROGRESS', summary: 'sync' },
  { type: 'BACKLOG_STATUS', backlogId: 'BUG-01', title: 'Fix', status: 'DISCOVERED', summary: 'new', revision: null, receiptId: null },
  { type: 'BACKLOG_STATUS', backlogId: 'BUG-01', title: 'Fix', status: 'SUBMITTED', summary: 'done', revision: null, receiptId: 'r1' },
  { type: 'BACKLOG_STATUS', backlogId: 'BUG-01', title: 'Fix', status: 'SUBMITTED', summary: 'done', revision: sha, receiptId: 'r1' },
  { type: 'BACKLOG_TESTS', backlogId: 'BUG-01', status: 'PASSED', required: 3, executed: 3, passed: 3, failed: 0, skipped: 0, summary: 'ok' },
  { type: 'BACKLOG_TESTS', backlogId: 'BUG-01', status: 'PASSED', required: 3, executed: 2, passed: 2, failed: 0, skipped: 0, summary: 'ok' },
  { type: 'BACKLOG_TESTS', backlogId: 'BUG-01', status: 'FAILED', required: 3, executed: 2, passed: 2, failed: 0, skipped: 0, summary: 'ok' },
  { type: 'BACKLOG_TESTS', backlogId: 'BUG-01', status: 'NOT_RUN', required: 3, executed: 1, passed: 1, failed: 0, skipped: 0, summary: 'ok' },
  { type: 'GAME_MASTER_API', operation: 'LOGIN', backlogId: null, method: 'POST', origin: 'https://masterthemachine.tech', path: '/api/v1/auth/login', phase: 'SUCCEEDED', httpStatus: 200, requestId: 'req_1', summary: 'ok' },
  { type: 'GAME_MASTER_API', operation: 'LOGIN', backlogId: null, method: 'POST', origin: 'https://masterthemachine.tech/', path: '/x', phase: 'SUCCEEDED', httpStatus: 200, requestId: null, summary: 'ok' },
  { type: 'GAME_MASTER_API', operation: 'REFRESH', backlogId: null, method: 'GET', origin: 'http://127.0.0.1:9', path: '/x?y=1', phase: 'FAILED', httpStatus: 302, requestId: null, summary: 'ok' },
  { type: 'GAME_MASTER_API', operation: 'REFRESH', backlogId: null, method: 'GET', origin: 'http://127.0.0.1:9', path: '/x', phase: 'REQUESTED', httpStatus: null, requestId: null, summary: 'ok' },
  { type: 'BLOCKER_OPENED', blockerId: 'GIT_AUTHENTICATION_REQUIRED', backlogId: null, summary: 'blocked' },
  { type: 'BLOCKER_RESOLVED', blockerId: 'GIT_AUTHENTICATION_REQUIRED', summary: 'ok' },
  { type: 'ORCHESTRATOR_ENDED', status: 'COMPLETED', summary: 'done' },
  { type: 'ORCHESTRATOR_RESTARTED', attempt: 1, phase: 'GAME', reason: 'LOCAL_APP_RESUME', summary: 'r' },
  { type: 'ORCHESTRATOR_RESTARTED', attempt: 0, phase: 'GAME', reason: 'LOCAL_APP_RESUME', summary: 'r' }
];

test('validator matches Player validateProgressEvent', { skip: !hasPlayer }, async () => {
  const { validateProgressEvent } = await player('progress.mjs');
  for (const sample of samples) {
    const event = { ...base, ...sample };
    let playerOk = true;
    try { validateProgressEvent(event, sid); } catch { playerOk = false; }
    assert.equal(eventProblem(event, sid) === null, playerOk, JSON.stringify(sample));
  }
});

test('writer refuses invalid transitions and duplicate ENVIRONMENT_READY', () => {
  const dir = tempDir('mtm-progress-');
  const path = join(dir, 'log.ndjson');
  writeFileSync(path, `${JSON.stringify({ ...base, type: 'ORCHESTRATOR_STARTED', summary: 'Team orchestrator started.' })}\n`);
  const w = new ProgressWriter(path, sid);
  w.write({ type: 'BACKLOG_STATUS', backlogId: 'BUG-01', title: 'Fix', status: 'DISCOVERED', summary: 'new', revision: null, receiptId: null });
  w.write({ type: 'BACKLOG_STATUS', backlogId: 'BUG-01', title: 'Fix', status: 'FAILED', summary: 'x', revision: null, receiptId: null });
  assert.throws(() => w.write({ type: 'BACKLOG_STATUS', backlogId: 'BUG-01', title: 'Fix', status: 'COMPLETED', summary: 'x', revision: null, receiptId: null }), /EVENT_INVALID/);
  assert.throws(() => w.write({ type: 'BACKLOG_TESTS', backlogId: 'TASK-09', status: 'NOT_RUN', required: 1, executed: 0, passed: 0, failed: 0, skipped: 0, summary: 'x' }), /EVENT_INVALID/);
  const ready = { type: 'ENVIRONMENT_READY', requestId: 'prepare-1', repository: { url: 'https://github.com/a/b', branch: 'main', folder: 'ABCD1234' }, revision: sha, build: 'PASS', matchLogin: 'PASS' };
  w.write(ready);
  assert.throws(() => w.write({ ...ready, revision: 'b'.repeat(40) }), /ENVIRONMENT_READY_CONFLICT/);
  // Đọc lại từ file cho cùng trạng thái
  const again = new ProgressWriter(path, sid);
  assert.equal(again.state.backlogs['BUG-01'].status, 'FAILED');
  assert.ok(again.state.environmentReady);
  assert.equal(readFileSync(path, 'utf8').split('\n').filter(Boolean).length, 4);
});

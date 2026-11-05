// configure_session: kiểm scope của bearer trong frame RESUME_GAME_V1 (có cả mật khẩu lẫn bearer).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { Session } from '../../pack/src/core/session.mjs';
import { Runtime } from '../../pack/src/tools.mjs';
import { redact } from '../../pack/src/core/redact.mjs';
import { sha256 } from '../../pack/src/core/util.mjs';
import { hasPlayer, player, tempDir } from './support.mjs';

const MATCH = 'TEST1234';
const API_KEY = 'gm_test_key_0123456789abcdef';
const ORIGIN = 'https://masterthemachine.tech';

function resumeFrame(tw, apiKeyScopes) {
  const checkoutRoot = join(tw, 'matches', MATCH);
  const descriptor = {
    schemaVersion: 1, type: 'RESUME_GAME', requestId: 'restart-1', playerSessionId: 'session-1', teamId: 'BUN', matchId: MATCH,
    username: 'team-bun', password: 'pw-123456', repository: { url: 'https://github.com/x/y.git', branch: 'main', folder: MATCH },
    checkoutRoot, matchRoot: join(checkoutRoot, MATCH), progressLogFile: join(tw, 'team-sdlc-pack', 'logs', `${MATCH}.progress.ndjson`),
    apiKeySecret: API_KEY, apiKeyLength: API_KEY.length, apiKeySha256: sha256(API_KEY), apiKeyScopes,
    matchPageUrl: `${ORIGIN}/match`, allowedMatchOrigins: [ORIGIN], allowedApiOrigins: [ORIGIN]
  };
  return `RESUME_GAME_V1\n${JSON.stringify(descriptor)}`;
}

test('bearer scope accepts the Player and the guide spelling', () => {
  const tw = tempDir('mtm-session-');
  for (const scopes of [['submission:create', 'submission:read'], ['backlogs:start', 'submissions:create']]) {
    assert.equal(new Session().configure(resumeFrame(tw, scopes), tw).phase, 'GAME');
  }
});

test('bearer without a submit scope is rejected', () => {
  const tw = tempDir('mtm-session-');
  assert.throws(() => new Session().configure(resumeFrame(tw, ['submission:read']), tw), { code: 'INVALID_FRAME' });
});

const compactFields = ['schemaVersion', 'type', 'requestId', 'playerSessionId', 'teamId', 'matchId',
  'apiKeySecret', 'apiKeyLength', 'apiKeySha256', 'apiKeyScopes', 'gameMasterApiUrl', 'allowedApiOrigins'];
function frames(tw) {
  const full = JSON.parse(resumeFrame(tw, ['submission:create']).split('\n')[1]);
  full.type = 'START_GAME'; full.gameMasterApiUrl = `${ORIGIN}/api`;
  const { apiKeySecret, apiKeyLength, apiKeySha256, apiKeyScopes, ...prep } = full;
  prep.type = 'PREPARE_GAME';
  const model = { orchestratorModel: 'gpt-6-luna', allowedModels: ['gpt-6-luna'] };
  return { full, prep: `PREPARE_GAME_V2\n${JSON.stringify(prep)}\n\nMTM_MODEL_POLICY_V1\n${JSON.stringify(model)}`,
    compact: Object.fromEntries(compactFields.map(k => [k, full[k]])), model };
}

for (const type of ['START_GAME', 'RESUME_GAME']) test(`${type} compact inherits PREPARE paths, credentials and model policy without exposing secrets`, () => {
  const tw = tempDir('mtm-session-'), f = frames(tw), rt = new Runtime({ teamWorkspace: tw });
  mkdirSync(join(f.full.checkoutRoot, '.git'), { recursive: true });
  rt.configureSession({ frame: f.prep });
  const result = rt.configureSession({ frame: `${type === 'START_GAME' ? 'START_GAME_V4' : 'RESUME_GAME_V1'}\n${JSON.stringify({ ...f.compact, type })}` });
  assert.equal(result.phase, 'GAME'); assert.equal(result.paths.matchRoot, f.full.matchRoot);
  assert.deepEqual(result.models, f.model); assert.equal(rt.session.secrets.password, 'pw-123456');
  assert.equal(rt.session.secrets.apiKey, API_KEY);
  for (const value of [result, rt.session.descriptor, rt.journal.data]) assert.ok(!JSON.stringify(value).includes(API_KEY));
  assert.ok(!redact(API_KEY).includes(API_KEY));
});

test('START requires PREPARE, validates integrity, scope and session/match identity, and still accepts the full frame', () => {
  const tw = tempDir('mtm-session-'), f = frames(tw), s = new Session();
  const start = d => `START_GAME_V4\n${JSON.stringify(d)}`;
  assert.throws(() => s.configure(start(f.compact), tw), { code: 'NEEDS_PREPARATION_FRAME' });
  assert.throws(() => s.configure(start(f.full), tw), { code: 'NEEDS_PREPARATION_FRAME' });
  s.configure(f.prep, tw);
  for (const delta of [{ apiKeySha256: '0'.repeat(64) }, { apiKeyLength: 1 }]) {
    assert.throws(() => s.configure(start({ ...f.compact, ...delta }), tw), { code: 'API_KEY_INTEGRITY_MISMATCH' });
    assert.equal(s.phase, 'PREPARE');
  }
  assert.throws(() => s.configure(start({ ...f.compact, apiKeyScopes: ['submission:read'] }), tw), { code: 'INVALID_FRAME' });
  for (const field of ['playerSessionId', 'matchId', 'teamId']) {
    assert.throws(() => s.configure(start({ ...f.compact, [field]: 'OTHER123' }), tw), { code: 'SESSION_MISMATCH' });
  }
  assert.equal(s.configure(start(f.full), tw).phase, 'GAME');
});

test('rebuilt submission policy matches every field emitted by Player; explicit policy is preserved', { skip: !hasPlayer }, async () => {
  const tw = tempDir('mtm-session-'), f = frames(tw), s = new Session(); s.configure(f.prep, tw);
  const { submissionPolicyFrame } = await player('submission-policy.mjs');
  const full = { ...f.full, challengeWorkspace: join(tw, 'matches') };
  const frame = submissionPolicyFrame({ followup: { message: `START_GAME_V4\n${JSON.stringify(full)}` } }).followup.message;
  const expected = JSON.parse(frame.split('MTM_SUBMISSION_POLICY_V1\n')[1]);
  s.configure(`START_GAME_V4\n${JSON.stringify(f.compact)}`, tw);
  assert.deepEqual(s.policies.MTM_SUBMISSION_POLICY_V1, expected);
  const explicit = { ...expected, instruction: 'Explicit organizer policy' };
  s.configure(`START_GAME_V4\n${JSON.stringify(f.full)}\n\nMTM_SUBMISSION_POLICY_V1\n${JSON.stringify(explicit)}`, tw);
  assert.deepEqual(s.policies.MTM_SUBMISSION_POLICY_V1, explicit);
});

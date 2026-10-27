// configure_session: kiểm scope của bearer trong frame RESUME_GAME_V1 (có cả mật khẩu lẫn bearer).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { Session } from '../../pack/src/session.mjs';
import { sha256 } from '../../pack/src/util.mjs';
import { tempDir } from './support.mjs';

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

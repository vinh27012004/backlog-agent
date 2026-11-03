// Test fail ở baseline (Practice #6, HIET12OA): start_work giao đúng một item chủ (item đầu tiên có đề/MVS đòi chạy cả
// bộ test), giao lại khi chủ đã xong.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Journal } from '../../pack/src/core/journal.mjs';
import { Runtime } from '../../pack/src/tools.mjs';
import { tempDir } from './support.mjs';

const FAILING = 'tests/cascade.test.ts > deletion cascades > deleting a company with invoices is RESTRICTED';

function runtime() {
  const root = tempDir('mtm-baseline-');
  const teamWork = join(root, '.team-work');
  const rt = new Runtime({ teamWorkspace: root });
  rt.session.paths = { teamWork, checkoutRoot: root, matchRoot: join(root, 'M1') };
  rt.session.descriptor = { matchId: 'M1' };
  mkdirSync(teamWork, { recursive: true });
  rt.journalObj = new Journal(teamWork);
  rt.journalObj.data.preparation = { baseline: { status: 'FAIL', failing: [FAILING] } };
  const item = (key, mvs) => {
    const dir = join(teamWork, 'items', key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'start.json'), JSON.stringify({ minimumVerificationScenarios: mvs }));
    rt.journalObj.item(key).startedAt = new Date().toISOString();
  };
  return { rt, item };
}

test('one owner per baseline failure: the first item whose MVS runs the suite, reassigned when it ends without the fix', () => {
  const { rt, item } = runtime();
  item('TASK-01', '## TASK-01-TC-01\nTrace the reorder position in the source.');
  item('BUG-02', '## BUG-02-TC-04 – existing tests\n1. Run `BUG-02-run-checks.mjs`.\nExpected: `pnpm test` exits 0 with no failed test.');
  item('CR-01', '| `CR-01-run-checks.mjs` | Runs `pnpm test` and `pnpm typecheck` and writes their logs |');

  assert.deepEqual(rt.baselineBrief('TASK-01'), { failing: [FAILING], owner: null, youFix: false }, 'TASK-01 does not run the suite');
  assert.deepEqual(rt.baselineBrief('BUG-02'), { failing: [FAILING], owner: 'BUG-02', youFix: true });
  assert.deepEqual(rt.baselineBrief('CR-01'), { failing: [FAILING], owner: 'BUG-02', youFix: false }, 'only one owner while BUG-02 works');
  assert.equal(rt.baselineBrief('BUG-02').youFix, true, 'a replayed start_work keeps the owner');

  // BUG-02 nộp mà không sửa được test: item kế tiếp có MVS chạy bộ test nhận việc.
  rt.journalObj.item('BUG-02').endedAt = new Date().toISOString();
  assert.deepEqual(rt.baselineBrief('CR-01'), { failing: [FAILING], owner: 'CR-01', youFix: true });
});

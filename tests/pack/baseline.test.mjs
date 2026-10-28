// Test fail ở baseline (Practice #6, HIET12OA): start_work giao đúng một item chủ (item đầu tiên có đề/MVS đòi chạy cả
// bộ test), giao lại khi chủ đã xong mà test vẫn fail; integrate ghi bản sửa và trả các worktree còn mở cần sync.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Journal } from '../../pack/src/journal.mjs';
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
  const worktree = key => mkdirSync(rt.wtPaths(key).worktreeRoot, { recursive: true });
  return { rt, item, worktree };
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

test('integrate records the baseline fix and lists the open worktrees to sync; later items see it as fixed', () => {
  const { rt, item, worktree } = runtime();
  for (const k of ['BUG-01', 'BUG-02', 'CR-01']) { item(k, 'Expected: `pnpm test` exits 0.'); worktree(k); }
  rt.journalObj.item('CR-01').integratedRevision = 'abc';   // đã nộp: không cần sync
  rt.baselineBrief('BUG-02');
  rt.journalObj.item('BUG-02').lastGate = { passed: true, fixesBaseline: [FAILING] };
  rt.journalObj.item('BUG-02').integratedRevision = 'def';

  assert.deepEqual(rt.recordBaselineFix('BUG-02'), { fixedNow: [FAILING], sync: ['BUG-01'] });
  assert.deepEqual(rt.journalObj.data.preparation.baselineFixed, { [FAILING]: 'BUG-02' });
  assert.deepEqual(rt.recordBaselineFix('BUG-02'), { fixedNow: [], sync: [] }, 'recorded once');

  item('TASK-02', 'run typecheck and existing tests');
  assert.deepEqual(rt.baselineBrief('TASK-02'), { failing: [], fixedBy: { [FAILING]: 'BUG-02' } });
});

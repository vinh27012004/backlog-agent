// Khoá dữ liệu của app (mục 8): một item seed / tạo dữ liệu kịch bản một lúc, khoá tự hết hạn.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { appDataLock, lockFile } from '../../pack/src/datalock.mjs';
import { tempDir } from './support.mjs';

test('app_data lock is exclusive, renewable by its holder and expires', async () => {
  const tw = tempDir('mtm-lock-');
  const call = a => appDataLock({ teamWorkspace: tw, ...a });
  assert.deepEqual(await call({ action: 'status' }), { free: true });
  const first = await call({ action: 'lock', backlogItemKey: 'BUG-02' });
  assert.equal(first.locked, true);
  const other = await call({ action: 'lock', backlogItemKey: 'CR-01' });
  assert.equal(other.locked, false);
  assert.equal(other.heldBy, 'BUG-02');
  assert.match(other.hint, /do not seed/);
  assert.equal((await call({ action: 'unlock', backlogItemKey: 'CR-01' })).unlocked, false, 'only the holder unlocks');
  assert.equal((await call({ action: 'lock', backlogItemKey: 'BUG-02', minutes: 30 })).locked, true, 'holder renews');
  // CR-01 chờ: BUG-02 nhả khoá sau ~1,5 s thì CR-01 lấy được trong cùng lời gọi.
  setTimeout(() => { call({ action: 'unlock', backlogItemKey: 'BUG-02' }); }, 1500);
  const waited = await call({ action: 'lock', backlogItemKey: 'CR-01', waitSeconds: 10 });
  assert.equal(waited.locked, true);
  assert.equal(waited.heldBy, 'CR-01');
  // Item bị kill giữ khoá: hết hạn thì item khác lấy được.
  const file = lockFile(tw);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), until: new Date(Date.now() - 1000).toISOString() }));
  assert.equal((await call({ action: 'lock', backlogItemKey: 'TASK-02' })).locked, true);
  await assert.rejects(call({ action: 'lock', backlogItemKey: '../x' }), /backlogItemKey/);
});

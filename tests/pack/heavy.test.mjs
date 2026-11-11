// Hàng chờ lệnh nặng của cả máy (pack/src/env/heavy.mjs): helper không còn giới hạn số item làm cùng lúc, chỉ số lệnh
// typecheck/build/test chạy cùng lúc.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { heavyHolders, heavyLimit, withHeavySlot } from '../../pack/src/env/heavy.mjs';
import { tempDir } from './support.mjs';

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

test('the limit defaults to half the CPU threads, at least 3; a valid setting wins', () => {
  assert.ok(heavyLimit(null) >= 3);
  assert.equal(heavyLimit(2), 2);
  assert.equal(heavyLimit(0), heavyLimit(null));
  assert.equal(heavyLimit('4'), heavyLimit(null));
});

test('at most max heavy commands run at once; the others wait and then run', async () => {
  const teamWork = tempDir('mtm-heavy-');
  let running = 0, peak = 0;
  const waited = [];
  const jobs = Array.from({ length: 5 }, (_, i) => withHeavySlot(teamWork, { max: 2, key: `BUG-0${i}`, name: 'build', onWait: () => waited.push(i) }, async ({ waitedMs }) => {
    running++; peak = Math.max(peak, running);
    if (i === 0) assert.deepEqual(heavyHolders(teamWork).map(h => h.name), ['build', 'build'].slice(0, heavyHolders(teamWork).length));
    await sleep(150);
    running--;
    return { i, waitedMs };
  }));
  const done = await Promise.all(jobs);
  assert.equal(peak, 2);
  assert.deepEqual(done.map(d => d.i), [0, 1, 2, 3, 4]);
  assert.equal(waited.length, 3, 'three commands had to wait');
  assert.ok(done.filter(d => d.waitedMs >= 100).length >= 3);
  assert.deepEqual(readdirSync(join(teamWork, 'scratch', 'heavy')), [], 'every slot is released');
});

test('a slot left by a dead process is taken over; a cancelled wait does not run the command', async () => {
  const teamWork = tempDir('mtm-heavy-');
  const dir = join(teamWork, 'scratch', 'heavy');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'slot-0.json'), JSON.stringify({ pid: 2 ** 30, key: 'CR-01', name: 'test' }));
  assert.deepEqual(heavyHolders(teamWork), []);
  assert.equal(await withHeavySlot(teamWork, { max: 1 }, async () => 'ran'), 'ran');
  const ac = new AbortController();
  let ran = false;
  const hold = withHeavySlot(teamWork, { max: 1 }, () => sleep(600));
  const waiting = withHeavySlot(teamWork, { max: 1, signal: ac.signal }, async () => { ran = true; });
  await sleep(100); ac.abort();
  assert.equal(await waiting, null);
  assert.equal(ran, false);
  await hold;
  assert.equal(existsSync(join(dir, 'slot-0.json')), false);
});

test('a failing command still releases its slot', async () => {
  const teamWork = tempDir('mtm-heavy-');
  await assert.rejects(withHeavySlot(teamWork, { max: 1 }, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await withHeavySlot(teamWork, { max: 1 }, async () => 1), 1);
});

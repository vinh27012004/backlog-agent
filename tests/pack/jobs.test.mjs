// OMZJW0S0: lệnh không tồn tại từng trả exit 0 và làm install/checks báo PASS giả.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPwsh } from '../../pack/src/core/jobs.mjs';

test('runPwsh fails when the executable does not exist, including after a successful native command', async () => {
  for (const prefix of ['', 'node -e "process.exit(0)"; ']) {
    const res = await runPwsh(`${prefix}mtm_nonexistent_command_omzjw0s0`, { timeoutMs: 15_000 });
    assert.equal(res.code, process.platform === 'win32' ? 1 : 127, res.tail);
    assert.match(res.tail, /mtm_nonexistent_command_omzjw0s0/);
    assert.equal(res.timedOut, false);
  }
});

test('runPwsh preserves successful and failing native exit codes', async () => {
  for (const code of [0, 7]) {
    const res = await runPwsh(`node -e "console.log('native ran'); process.exit(${code})"`);
    assert.equal(res.code, code, res.tail);
    assert.match(res.tail, /native ran/);
  }
});

test('runPwsh handles PowerShell-only success, exceptions and non-terminating errors', { skip: process.platform !== 'win32' }, async () => {
  assert.equal((await runPwsh("Write-Output 'cmdlet ran'")).code, 0);
  for (const command of ["throw 'fixture failure'", "Write-Error 'fixture failure' -ErrorAction Continue"]) {
    const res = await runPwsh(command);
    assert.equal(res.code, 1, res.tail);
    assert.match(res.tail, /fixture failure/);
  }
});

// contentTree (snapshot source của helper) thử lại khi `git add` hỏng vì một tiến trình đang ghi file (LXRMBRA2 BUG-09:
// bộ test nền ghi lại *.snap đúng lúc capture_evidence chụp snapshot, lần chụp hỏng GIT_FAILED).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { contentTree } from '../../pack/src/core/git.mjs';
import { HelperError } from '../../pack/src/core/util.mjs';
import { sh, tempDir } from './support.mjs';

const flaky = (failures, code = 'GIT_FAILED') => {
  const calls = [];
  const runGit = async args => {
    calls.push(args[0]);
    if (args[0] === 'add' && calls.filter(c => c === 'add').length <= failures) {
      throw new HelperError(code, 'add: error: x.test.ts.snap: failed to insert into database');
    }
    return { out: args[0] === 'write-tree' ? 'abc123' : '' };
  };
  return { calls, runGit };
};

test('a git add that fails while a file is being written is tried again with a fresh index', async () => {
  const twice = flaky(2);
  assert.equal(await contentTree('.', 'M1', [], { runGit: twice.runGit, delayMs: 1 }), 'abc123');
  assert.deepEqual(twice.calls, ['add', 'add', 'add', 'write-tree']);
  const always = flaky(99);
  await assert.rejects(contentTree('.', 'M1', [], { runGit: always.runGit, delayMs: 1 }), /GIT_FAILED/);
  assert.equal(always.calls.length, 4, 'four attempts, then the error');
  const other = flaky(1, 'GIT_COMMAND_NOT_ALLOWED');
  await assert.rejects(contentTree('.', 'M1', [], { runGit: other.runGit, delayMs: 1 }), /GIT_COMMAND_NOT_ALLOWED/);
  assert.equal(other.calls.length, 1, 'other errors are not retried');
});

test('contentTree hashes the folder without the excluded paths', async () => {
  const repo = tempDir('mtm-tree-');
  sh('git', ['init', '-q'], repo);
  mkdirSync(join(repo, 'M1', 'answers'), { recursive: true });
  writeFileSync(join(repo, 'M1', 'lib.js'), 'export const v = 1;\n');
  const before = await contentTree(repo, 'M1', ['M1/answers']);
  writeFileSync(join(repo, 'M1', 'answers', 'note.txt'), 'not source');
  assert.equal(await contentTree(repo, 'M1', ['M1/answers']), before);
  writeFileSync(join(repo, 'M1', 'lib.js'), 'export const v = 2;\n');
  assert.notEqual(await contentTree(repo, 'M1', ['M1/answers']), before);
});

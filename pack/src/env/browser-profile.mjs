// Snapshot riêng theo worktree; khóa file dùng được giữa các helper process.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { digest } from '../core/candidates.mjs';
import { fail, sleep } from '../core/util.mjs';

export const SNAPSHOT_STORES = ['cookies', 'localStorage', 'indexedDB', 'opfs'];
export const UNSAVED_STORES = ['sessionStorage', 'pageMemory', 'serviceWorkers', 'cacheStorage'];

export function browserProfileFile(teamWorkspace, name, context = null) {
  if (name === null || name === undefined) return null;
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(name)) fail('INVALID_ARGUMENT', 'browserProfile must be 1-40 letters, digits, _ or -');
  let scope = '';
  if (context?.matchRoot) {
    const root = resolve(context.matchRoot);
    const item = context.backlogItemKey;
    scope = `-${digest({ root: process.platform === 'win32' ? root.toLowerCase() : root,
      item: process.platform === 'win32' ? item?.toLowerCase() : item }).slice(0, 20)}`;
  }
  return join(teamWorkspace, 'team-sdlc-pack', 'local', 'browser', `${name}${scope}.json`);
}

const alive = pid => {
  if (!Number.isInteger(pid) || pid < 1) return true; // Không biết chủ khóa: không tự giành.
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

function reapDeadOwner(file) {
  const guard = `${file}.reap`;
  try { mkdirSync(guard); } catch (error) { if (error.code === 'EEXIST') return; throw error; }
  try {
    let owner;
    try { owner = JSON.parse(readFileSync(file, 'utf8')); } catch { return; }
    if (!alive(owner.pid)) unlinkSync(file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { rmdirSync(guard); }
}

export async function withBrowserProfile(file, run, waitMs = 50_000) {
  if (!file) return run({ waitedMs: 0 });
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`, token = randomUUID(), since = Date.now();
  for (;;) {
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      reapDeadOwner(lock);
      if (Date.now() - since >= waitMs) fail('BROWSER_PROFILE_BUSY', 'another capture owns this profile; wait for it or use a separate profile for independent data');
      await sleep(100);
    }
  }
  let failure;
  try { return await run({ waitedMs: Date.now() - since }); }
  catch (error) { failure = error; throw error; }
  finally {
    try {
      if (existsSync(lock) && JSON.parse(readFileSync(lock, 'utf8')).token === token) unlinkSync(lock);
    } catch {
      if (failure) failure.details = { ...failure.details, profileLockReleaseFailed: true };
      else fail('BROWSER_PROFILE_LOCK_FAILED', 'capture completed but its profile lock could not be released');
    }
  }
}

export async function withBrowserLocks(files, run, waitMs = 50_000) {
  const keys = [...new Set(files.filter(Boolean))].sort(), since = Date.now();
  const take = index => index === keys.length ? run({ waitedMs: Date.now() - since })
    : withBrowserProfile(keys[index], () => take(index + 1), Math.max(0, waitMs - (Date.now() - since)));
  return take(0);
}

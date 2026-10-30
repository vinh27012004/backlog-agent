// TeamWorkspace tin cậy được suy ra từ chỗ helper được cài (05 §2), không lấy từ frame.
import { existsSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './util.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// src/core/ → runtime/ → team-sdlc-pack/ → TeamWorkspace
export function trustedTeamWorkspace() {
  if (process.env.MTM_TEAM_WORKSPACE_OVERRIDE && process.env.MTM_TEAM_TEST_MODE === '1') {
    return resolve(process.env.MTM_TEAM_WORKSPACE_OVERRIDE);
  }
  const runtime = resolve(here, '..', '..');
  const tw = resolve(runtime, '..', '..');
  if (!existsSync(join(tw, '.mtm', 'team-runtime.json'))) return null;
  return tw;
}

const norm = p => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

export const samePath = (a, b) => norm(a) === norm(b);

export function inside(root, target) {
  const rel = relative(norm(root), norm(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// Chặn symlink/junction trên mọi đoạn từ root tới target (đoạn chưa tồn tại thì bỏ qua).
export function assertNoLinks(root, target) {
  if (!inside(root, target)) fail('PATH_OUTSIDE_WORKSPACE', target);
  let cursor = resolve(target);
  while (!samePath(cursor, root)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) fail('PATH_OUTSIDE_WORKSPACE', `link: ${cursor}`);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

export function expectAbsolute(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('INVALID_FRAME', `${name} must be absolute`);
  return resolve(value);
}

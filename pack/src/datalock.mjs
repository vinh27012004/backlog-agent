// Khoá dữ liệu của app (mục 8). Mọi worktree chạy app trên cùng một database dev (chỉ TEST_DATABASE_URL có hậu tố
// riêng), mà seed của BTC xoá rồi tạo lại dữ liệu (CR-01 "deletes every invoice"): hai item cùng seed / tạo dữ liệu
// qua app thì làm hỏng evidence của nhau. Item giữ khoá từ lúc seed tới lúc ghi xong report/evidence đọc dữ liệu đó.
// Khoá là một file tạo độc quyền (flag "wx") trong team-sdlc-pack/local/, vì subagent có thể gọi helper ở tiến trình
// khác; tự hết hạn (mặc định 15 phút) để item bị kill giữa chừng không giữ khoá mãi.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fail } from './util.mjs';

const isKey = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(value);
const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

export const lockFile = teamWorkspace => join(teamWorkspace, 'team-sdlc-pack', 'local', 'app-data.lock.json');

function current(file) {
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8'));
    return Date.parse(lock.until) > Date.now() ? lock : null;
  } catch {
    return null;
  }
}

function tryTake(file, key, minutes) {
  const lock = { heldBy: key, since: new Date().toISOString(), until: new Date(Date.now() + minutes * 60_000).toISOString() };
  try {
    writeFileSync(file, JSON.stringify(lock), { flag: 'wx' });
    return lock;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const held = current(file);
  if (held && held.heldBy !== key) return null;
  // Hết hạn, hoặc chính item này gia hạn: xoá rồi tạo lại độc quyền (hai bên cùng thấy hết hạn thì chỉ một bên thắng).
  rmSync(file, { force: true });
  try {
    writeFileSync(file, JSON.stringify(lock), { flag: 'wx' });
    return lock;
  } catch {
    return null;
  }
}

export async function appDataLock({ teamWorkspace, action, backlogItemKey: key, minutes = 15, waitSeconds = 0 }) {
  if (!teamWorkspace) fail('NOT_CONFIGURED', 'helper is not installed inside a TeamWorkspace');
  const file = lockFile(teamWorkspace);
  mkdirSync(dirname(file), { recursive: true });
  if (action === 'status') {
    const held = current(file);
    return held ? { free: false, ...held } : { free: true };
  }
  if (!isKey(key)) fail('INVALID_ARGUMENT', 'backlogItemKey');
  if (action === 'unlock') {
    const held = current(file);
    if (held && held.heldBy !== key) return { unlocked: false, ...held };
    rmSync(file, { force: true });
    return { unlocked: true };
  }
  if (action !== 'lock') fail('INVALID_ARGUMENT', 'action');
  const span = Math.min(30, Math.max(1, Math.floor(Number(minutes) || 15)));
  const deadline = Date.now() + Math.min(50, Math.max(0, Number(waitSeconds) || 0)) * 1000;
  for (;;) {
    const lock = tryTake(file, key, span);
    if (lock) return { locked: true, ...lock };
    if (Date.now() >= deadline) {
      return { locked: false, ...current(file),
        hint: 'Another item is seeding or capturing data in the shared app database. Call lock again (waitSeconds up to 50); do not seed or create data meanwhile.' };
    }
    await sleep(1000);
  }
}

// Giới hạn số lệnh nặng (typecheck, build, bộ test của run_checks) chạy cùng lúc trên cả máy. Từ 11/11 helper không
// còn giới hạn số item làm cùng lúc (QDO8W480: TASK-07 hạn 15 phút chờ slot 9 phút rồi đóng khi chưa nộp): thợ nào
// cũng được bắt đầu ngay để đọc đề, sửa code, tra dữ liệu; chỉ lúc chạy lệnh ngốn CPU mới xếp hàng. run_checks chạy
// trong helper của root hoặc của từng thợ (tiến trình khác nhau), nên chỗ là file tạo độc quyền (flag "wx") trong
// .team-work/scratch/heavy/; chỗ của tiến trình đã chết được lấy lại.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const POLL_MS = 400;

// Mặc định một nửa số luồng CPU, ít nhất 3: tsc dùng một luồng, build và vitest tự dùng nhiều luồng.
export function heavyLimit(value) {
  if (Number.isInteger(value) && value >= 1 && value <= 64) return value;
  return Math.max(3, Math.round(availableParallelism() / 2));
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const slotFile = (dir, i) => join(dir, `slot-${i}.json`);
function holder(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function tryTake(dir, max, who) {
  for (let i = 0; i < max; i++) {
    const file = slotFile(dir, i);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(file, JSON.stringify({ pid: process.pid, ...who, since: new Date().toISOString() }), { flag: 'wx' });
        return file;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const h = holder(file);
      // File đang được ghi (chưa đọc được) coi như có chủ; chủ đã chết thì xoá rồi thử lại một lần.
      if (!h || alive(h.pid)) break;
      rmSync(file, { force: true });
    }
  }
  return null;
}

// Các lệnh nặng đang giữ chỗ: [{pid, key, name, since}].
export function heavyHolders(teamWork) {
  const dir = join(teamWork, 'scratch', 'heavy');
  let files = [];
  try { files = readdirSync(dir).filter(f => /^slot-\d+\.json$/.test(f)); } catch { return []; }
  return files.map(f => holder(join(dir, f))).filter(h => h && alive(h.pid));
}

// Chạy fn khi có chỗ. signal huỷ lúc đang chờ thì trả null, không chạy fn. onWait(ms) gọi một lần khi phải chờ.
export async function withHeavySlot(teamWork, { max, key = null, name = null, signal = null, onWait = null } = {}, fn) {
  const dir = join(teamWork, 'scratch', 'heavy');
  mkdirSync(dir, { recursive: true });
  const limit = heavyLimit(max), t0 = Date.now();
  let file = tryTake(dir, limit, { key, name }), told = false;
  while (!file) {
    if (signal?.aborted) return null;
    if (!told) { told = true; onWait?.(); }
    await sleep(POLL_MS);
    file = tryTake(dir, limit, { key, name });
  }
  try {
    return await fn({ waitedMs: Date.now() - t0 });
  } finally {
    rmSync(file, { force: true });
  }
}

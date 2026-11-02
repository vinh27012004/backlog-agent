import { execFile } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const megabytes = bytes => Math.round(bytes / 1048576);

/** Sums the resident memory of a process tree from `ps -A -o pid=,ppid=,rss=` output (KiB). */
export function processTreeRssMb(output, rootPid) {
  const rows = output.split('\n').map(line => line.trim().split(/\s+/).map(Number))
    .filter(row => row.length === 3 && row.every(Number.isSafeInteger));
  const tree = new Set([rootPid]); let total = 0;
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, parent] of rows) if (tree.has(parent) && !tree.has(pid)) { tree.add(pid); grew = true; }
  }
  for (const [pid, , rss] of rows) if (tree.has(pid)) total += rss;
  return Math.round(total / 1024);
}

const readTreeRss = rootPid => new Promise(resolve => {
  if (process.platform === 'win32' || !rootPid) { resolve(null); return; }
  execFile('ps', ['-A', '-o', 'pid=,ppid=,rss='], { timeout: 5_000, windowsHide: true }, (error, stdout) =>
    resolve(error ? null : processTreeRssMb(stdout, rootPid)));
});

/** Reads `footprint -p` output, for example `phys_footprint: 162 GB`; the last total wins. */
export function parseFootprintMb(output) {
  const match = [...output.matchAll(/phys_footprint:\s*([\d.]+)\s*(B|KB|MB|GB)\b/g)].at(-1);
  if (!match) return null;
  return Math.round(Number(match[1]) * { B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024 }[match[2]]);
}

// On macOS resident memory hides swapped and compressed pages: a Player that Jetsam killed at
// 162 GB footprint had only 0.75 GB resident. Jetsam acts on the footprint, so that is what to record.
const readOwnFootprint = () => new Promise(resolve => {
  if (process.platform !== 'darwin') { resolve(null); return; }
  execFile('footprint', ['-p', String(process.pid)], { timeout: 5_000, maxBuffer: 4 << 20 }, (error, stdout) =>
    resolve(error ? null : parseFootprintMb(stdout)));
});

/** Records memory evidence for a later diagnosis: on growth of a quarter, otherwise every ten minutes.
 * Reports pressure across softLimitMb so optional work can stop before the machine starts to thrash. */
export function createResourceMonitor({ record, childPid = () => null, counts = () => ({}),
  sampleIntervalMs = 60_000, heartbeatMs = 600_000, memoryUsage = process.memoryUsage, readChildRss = readTreeRss,
  readFootprint = readOwnFootprint, softLimitMb = 4_096, onPressure = () => {},
  activeResources = () => process.getActiveResourcesInfo().length, now = Date.now }) {
  const delay = monitorEventLoopDelay({ resolution: 50 }); delay.enable();
  let lastTotal = 0, lastChild = 0, lastAt = 0, pressure = false;
  const sample = async () => {
    const memory = memoryUsage();
    const rssMb = megabytes(memory.rss), externalMb = megabytes(memory.external + memory.arrayBuffers);
    const [codexRssMb, footprintMb] = await Promise.all([readChildRss(childPid()), readFootprint()]);
    const totalMb = Math.max(rssMb, footprintMb ?? 0, megabytes(memory.heapTotal ?? 0) + externalMb);
    const grew = totalMb > lastTotal * 1.25 || (codexRssMb ?? 0) > lastChild * 1.25;
    if (grew || now() - lastAt >= heartbeatMs) {
      lastTotal = totalMb; lastChild = codexRssMb ?? 0; lastAt = now();
      record({ rssMb, heapUsedMb: megabytes(memory.heapUsed), externalMb,
        ...(footprintMb === null ? {} : { footprintMb }), ...(codexRssMb === null ? {} : { codexRssMb }),
        activeResources: activeResources(), loopLagMaxMs: Math.round(delay.max / 1e6), ...counts() });
    }
    const next = totalMb >= softLimitMb;
    if (next !== pressure) { pressure = next; onPressure(next, totalMb); }
    delay.reset();
  };
  const timer = setInterval(() => { void sample().catch(() => {}); }, sampleIntervalMs); timer.unref?.();
  return Object.freeze({ sample, close: () => { clearInterval(timer); delay.disable(); } });
}

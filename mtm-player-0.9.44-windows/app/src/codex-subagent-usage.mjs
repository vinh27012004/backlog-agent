import { closeSync, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';

const idOk = id => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id);
const label = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/.test(value);
const counters = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
// Codex reports null when no tier override applies, which runs at the default tier.
const tierOf = value => value === null || value === undefined ? 'default' :
  typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : 'unknown';

function readFirstLine(path, limit = 1 << 20) {
  const fd = openSync(path, 'r');
  try {
    const chunks = []; let total = 0;
    while (total < limit) {
      const chunk = Buffer.alloc(65536), count = readSync(fd, chunk, 0, chunk.length, total);
      if (!count) break;
      const end = chunk.subarray(0, count).indexOf(10);
      if (end >= 0) { chunks.push(chunk.subarray(0, end)); return Buffer.concat(chunks).toString('utf8'); }
      chunks.push(chunk.subarray(0, count)); total += count;
    }
    return null;
  } finally { closeSync(fd); }
}

/** Reads the Codex session files of a root thread's descendants and reports their token usage.
 * Codex writes each subagent to its own rollout whose `session_id` is the root thread. Guardian
 * auto-review threads are excluded because Codex does not charge for them.
 */
export function createSubagentUsageTracker({ sessionsDirectory, now = Date.now, days = 7,
  scanIntervalMs = 15_000, readIntervalMs = 2_000, maxFiles = 256, chunkBytes = 4 << 20 }) {
  const metas = new Map(), threads = new Map();
  let rootId = null, nextScan = 0, nextRead = 0, rows = [];
  const dayDirectories = () => {
    const names = new Set();
    for (let day = 0; day < days; day++) {
      const at = new Date(now() - day * 86_400_000);
      for (const [y, m, d] of [[at.getFullYear(), at.getMonth() + 1, at.getDate()],
        [at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate()]]) {
        names.add(join(sessionsDirectory, String(y), String(m).padStart(2, '0'), String(d).padStart(2, '0')));
      }
    }
    return [...names].filter(path => existsSync(path) && !lstatSync(path).isSymbolicLink());
  };
  const scan = () => {
    for (const directory of dayDirectories()) {
      for (const name of readdirSync(directory)) {
        if (!/^rollout-.*\.jsonl$/.test(name)) continue;
        const path = join(directory, name);
        if (metas.has(path) || metas.size >= maxFiles * 16) continue;
        let meta = null;
        try {
          if (!lstatSync(path).isSymbolicLink()) {
            const line = readFirstLine(path);
            if (line === null) continue; // Codex is still writing session metadata.
            const payload = JSON.parse(line)?.payload;
            if (payload && idOk(payload.id) && idOk(payload.session_id)) meta = payload;
          }
        } catch { meta = null; }
        metas.set(path, meta);
      }
    }
  };
  const isGuardian = meta => meta.thread_source === 'guardian_review' || meta.source?.subagent?.other === 'guardian';
  const read = (path, thread) => {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size < thread.offset) Object.assign(thread, { offset: 0, pending: '', totals: null, usage: new Map() });
      const chunk = Buffer.alloc(Math.min(chunkBytes, size - thread.offset));
      const count = readSync(fd, chunk, 0, chunk.length, thread.offset);
      thread.offset += count;
      const text = thread.pending + chunk.subarray(0, count).toString('utf8');
      const lines = text.split('\n'); thread.pending = lines.pop();
      for (const line of lines) {
        if (!line.includes('thread_settings_applied') && !line.includes('turn_context') &&
            !line.includes('token_count')) continue;
        let record; try { record = JSON.parse(line); } catch { continue; }
        const payload = record?.payload;
        if (record?.type === 'turn_context' && label(payload?.model)) thread.model = payload.model;
        if (record?.type !== 'event_msg') continue;
        if (payload?.type === 'thread_settings_applied' && payload.thread_settings) {
          if (label(payload.thread_settings.model)) thread.model = payload.thread_settings.model;
          thread.serviceTier = tierOf(payload.thread_settings.service_tier);
        } else if (payload?.type === 'token_count') {
          const next = payload.info?.total_token_usage;
          if (!next || !counters.every(key => Number.isSafeInteger(next[key] ?? 0) && (next[key] ?? 0) >= 0)) continue;
          const values = Object.fromEntries(counters.map(key => [key, next[key] ?? 0]));
          if (thread.totals && counters.some(key => values[key] < thread.totals[key])) { thread.totals = values; continue; }
          const delta = Object.fromEntries(counters.map(key => [key, values[key] - (thread.totals?.[key] ?? 0)]));
          thread.totals = values;
          if (!Object.values(delta).some(value => value > 0)) continue;
          const model = thread.model ?? 'Unknown', key = JSON.stringify([model, thread.serviceTier]);
          const row = thread.usage.get(key) ?? { model, serviceTier: thread.serviceTier,
            inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
          row.inputTokens += delta.input_tokens; row.cachedInputTokens += delta.cached_input_tokens;
          row.outputTokens += delta.output_tokens; row.reasoningTokens += delta.reasoning_output_tokens;
          thread.usage.set(key, row);
        }
      }
    } finally { closeSync(fd); }
  };
  return Object.freeze({
    poll(root) {
      if (!sessionsDirectory || !idOk(root)) return [];
      if (root !== rootId) { rootId = root; threads.clear(); rows = []; nextScan = 0; nextRead = 0; }
      const at = now();
      if (at < nextRead) return rows;
      nextRead = at + readIntervalMs;
      try {
        if (at >= nextScan) { nextScan = at + scanIntervalMs; scan(); }
        for (const [path, meta] of metas) {
          if (!meta || meta.session_id !== rootId || meta.id === rootId || isGuardian(meta)) continue;
          if (!threads.has(meta.id) && threads.size >= maxFiles) continue;
          const thread = threads.get(meta.id) ?? { path, offset: 0, pending: '', model: null,
            serviceTier: 'default', totals: null, usage: new Map(),
            agent: label(meta.agent_path) ? meta.agent_path : label(meta.agent_nickname) ? meta.agent_nickname : meta.id.slice(0, 8) };
          threads.set(meta.id, thread);
          try { read(path, thread); } catch { /* a locked or rotated file is retried on the next read */ }
        }
      } catch { return rows; }
      rows = [...threads.entries()].flatMap(([sessionId, thread]) => [...thread.usage.values()]
        .map(row => ({ ...row, agent: thread.agent, sessionId })));
      return rows;
    }
  });
}

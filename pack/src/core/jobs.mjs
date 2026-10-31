// Chạy lệnh con (không qua shell của model) và job nền cho việc lâu hơn một lời gọi tool (05 §3).
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redact } from './redact.mjs';

const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

export function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!SECRET_ENV.test(k) || /^GIT_CONFIG_KEY_\d+$/.test(k)) env[k] = v;
  return { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', PRISMA_HIDE_UPDATE_MESSAGE: '1',
    CHECKPOINT_DISABLE: '1', NEXT_TELEMETRY_DISABLED: '1', NO_COLOR: '1', FORCE_COLOR: '0', ...extra };
}

export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(-pid, 'SIGKILL'); } catch { /* đã chết */ }
}

// Trả {code, timedOut, ms, tail}. `tail` là phần cuối output đã che secret.
export function run(cmd, args, { cwd, env, timeoutMs = 120_000, logFile = null, input = null, tailBytes = 6000 } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let out = '';
    let stdout = '';
    let log = null;
    if (logFile) { mkdirSync(dirname(logFile), { recursive: true }); log = createWriteStream(logFile); }
    const child = spawn(cmd, args, { cwd, env: env ?? childEnv(), windowsHide: true, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const onData = chunk => {
      const text = chunk.toString('utf8');
      out = (out + text).slice(-tailBytes * 4);
      log?.write(redact(text));
    };
    // stdout riêng để parse kết quả máy đọc (git): stderr có cảnh báo như "LF will be replaced by CRLF".
    child.stdout.on('data', chunk => { onData(chunk); stdout = (stdout + chunk.toString('utf8')).slice(-tailBytes * 4); });
    child.stderr.on('data', onData);
    if (input !== null) child.stdin.end(input); else child.stdin.end();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    const finish = code => {
      clearTimeout(timer);
      log?.end();
      resolve({ code, timedOut, ms: Date.now() - t0, tail: redact(out.slice(-tailBytes)).replace(/\x1b\[[0-9;]*m/g, ''), stdout });
    };
    child.on('error', error => { onData(Buffer.from(String(error.message))); finish(-1); });
    child.on('close', code => finish(timedOut ? -2 : code));
  });
}

// Lệnh của package manager / script: chạy qua PowerShell 7 với chuỗi lệnh do helper dựng.
export function runPwsh(command, options = {}) {
  const shell = process.platform === 'win32' ? 'pwsh' : 'sh';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `$ErrorActionPreference='Continue'; ${command}; exit $LASTEXITCODE`]
    : ['-c', command];
  return run(shell, args, options);
}

export class Jobs {
  constructor(onDone) {
    this.jobs = new Map();
    this.seq = 0;
    this.runId = randomUUID().slice(0, 8);
    this.onDone = onDone;
  }

  // meta.key: item của job (gate, chuẩn bị worktree), để onDone ghi thời gian chạy vào đúng item.
  start(kind, fn, meta = {}) {
    const id = `job-${++this.seq}-${kind}-${this.runId}`;
    const job = { id, kind, ...meta, state: 'running', startedAt: Date.now(), result: null, error: null, progress: [] };
    this.jobs.set(id, job);
    job.promise = (async () => {
      try {
        job.result = await fn(job);
        job.state = 'done';
      } catch (error) {
        job.state = 'failed';
        job.error = { code: error.code ?? 'JOB_FAILED', message: redact(error.message) };
      }
      job.ms = Date.now() - job.startedAt;
      this.onDone?.(job);
      return job;
    })();
    return job;
  }

  // Chờ job xong trong tối đa waitMs; trả trạng thái gọn.
  async settle(id, waitMs = 0) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.state === 'running' && waitMs > 0) {
      await Promise.race([job.promise, new Promise(r => setTimeout(r, waitMs))]);
    }
    return this.view(job);
  }

  view(job) {
    return { jobId: job.id, kind: job.kind, state: job.state, seconds: Math.round((Date.now() - job.startedAt) / 1000),
      progress: job.progress.slice(-5), ...(job.state === 'done' ? { result: job.result } : {}),
      ...(job.state === 'failed' ? { error: job.error } : {}) };
  }

  running(kind) {
    return [...this.jobs.values()].find(j => j.kind === kind && j.state === 'running') ?? null;
  }
}

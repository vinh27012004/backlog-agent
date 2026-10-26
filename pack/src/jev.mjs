// Client Jev (TypeSafe AI, model "System One"): quyết định có kiểu, không sinh chữ (port orchestrator/jev.py, D9).
// POST {baseUrl}/v1/systemone, Bearer key. Key đọc từ biến môi trường (Codex chuyển qua env_vars) hoặc file
// ngoài TeamWorkspace; không bao giờ vào log, kết quả tool hay shell của model. Mọi lỗi → HelperError JEV_ERROR
// để bên gọi dùng luật code. Request được khai vào networkActivity như mọi request khác (08 §8).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerSecret } from './redact.mjs';
import { HelperError, sleep } from './util.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export const noul = (instructions, yes = null, no = null) =>
  ({ type: 'noul', instructions, ...(yes !== null || no !== null ? { criteria: { true: yes, false: no } } : {}) });
export const choice = (instructions, options) => ({ type: 'choice', instructions, criteria: { ...options } });
export const score = (instructions, levels) => ({ type: 'score', instructions, criteria: [...levels] });

// Cấu hình pack + ghi đè cục bộ team-sdlc-pack/local/jev.json (enabled, apiKeyFile; baseUrl chỉ khi test mode).
export function loadJevConfig(localDir = null) {
  const base = JSON.parse(readFileSync(join(here, '..', 'config', 'jev.json'), 'utf8'));
  let local = {};
  if (localDir && existsSync(join(localDir, 'jev.json'))) {
    try { local = JSON.parse(readFileSync(join(localDir, 'jev.json'), 'utf8')); } catch { local = {}; }
  }
  const cfg = { ...base, thresholds: { ...base.thresholds, ...(local.thresholds ?? {}) } };
  if (typeof local.enabled === 'boolean') cfg.enabled = local.enabled;
  if (typeof local.apiKeyFile === 'string') cfg.apiKeyFile = local.apiKeyFile;
  if (typeof local.model === 'string') cfg.model = local.model;
  if (typeof local.baseUrl === 'string' && process.env.MTM_TEAM_TEST_MODE === '1') cfg.baseUrl = local.baseUrl;
  return cfg;
}

function parseAnswer(raw) {
  const t = raw?.type;
  if (t === 'noul') {
    if (typeof raw.noul !== 'number') throw new HelperError('JEV_ERROR', 'noul answer without probability');
    return { type: t, pYes: raw.noul, confidence: Math.max(raw.noul, 1 - raw.noul) };
  }
  if (t === 'choice') {
    if (raw.choice === undefined) throw new HelperError('JEV_ERROR', 'choice answer without choice');
    return { type: t, choice: raw.choice, confidence: raw.confidence ?? null };
  }
  if (t === 'score') {
    if (raw.score === undefined) throw new HelperError('JEV_ERROR', 'score answer without score');
    // Jev trả điểm liên tục trên thang (vd 2.74 với legend "0".."3"): làm tròn về mức gần nhất rồi tra nhãn.
    const legend = raw.legend && typeof raw.legend === 'object' ? raw.legend : {};
    const level = typeof raw.score === 'number' ? Math.round(raw.score) : raw.score;
    return { type: t, score: raw.score, level, label: legend[String(raw.score)] ?? legend[String(level)] ?? null, confidence: raw.confidence ?? null };
  }
  throw new HelperError('JEV_ERROR', `unknown answer type ${t}`);
}

export class JevClient {
  // record(url, method, status): khai networkActivity cho Player. transport: thay HTTP trong test.
  constructor(config, { record = () => {}, transport = null } = {}) {
    this.config = config;
    this.record = record;
    this.transport = transport;
    this.key = process.env[config.apiKeyEnv] ?? null;
    if (!this.key && config.apiKeyFile && existsSync(config.apiKeyFile)) {
      try { this.key = readFileSync(config.apiKeyFile, 'utf8').trim() || null; } catch { this.key = null; }
    }
    if (this.key) registerSecret(this.key);
  }

  get available() { return Boolean(this.config.enabled && (this.transport || this.key)); }

  get status() {
    return { enabled: Boolean(this.config.enabled), keyPresent: Boolean(this.key), available: this.available, model: this.config.model };
  }

  async ask(state, questions) {
    if (!this.available) throw new HelperError('JEV_ERROR', this.config.enabled ? 'API key missing' : 'disabled');
    const text = String(state).slice(0, this.config.maxStateChars ?? 4000);
    const body = { model: this.config.model, state: text, questions };
    const raw = this.transport ? await this.transport(body) : await this.http(body);
    const answers = raw?.answers;
    if (!answers || typeof answers !== 'object') throw new HelperError('JEV_ERROR', 'response without answers');
    const missing = Object.keys(questions).filter(k => !Object.hasOwn(answers, k));
    if (missing.length) throw new HelperError('JEV_ERROR', `missing answers: ${missing.join(', ')}`);
    return Object.fromEntries(Object.keys(questions).map(k => [k, parseAnswer(answers[k])]));
  }

  async http(body) {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/systemone`;
    const payload = JSON.stringify(body);
    for (let attempt = 0; attempt <= (this.config.retries ?? 1); attempt++) {
      let res;
      try {
        res = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.config.timeoutMs ?? 5000),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}`, 'User-Agent': 'team-sdlc-pack/0.1.0' }, body: payload });
      } catch (error) {
        this.record(url, 'POST', null);
        if (attempt < (this.config.retries ?? 1)) { await sleep(300); continue; }
        throw new HelperError('JEV_ERROR', `network error: ${error?.name ?? 'fetch failed'}`);
      }
      this.record(url, 'POST', res.status);
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < (this.config.retries ?? 1)) {
        await sleep(Math.min(2000, Number(res.headers.get('retry-after') ?? 0.5) * 1000));
        continue;
      }
      if (!res.ok) throw new HelperError('JEV_ERROR', `HTTP ${res.status}`);      // không đưa body/key vào lỗi
      try { return await res.json(); } catch { throw new HelperError('JEV_ERROR', 'invalid JSON from Jev'); }
    }
    throw new HelperError('JEV_ERROR', 'request failed');
  }
}

// Trả lời giả xác định được (chạy thử không cần key): chọn phương án đầu, yes/no = 0.1.
export function mockTransport(body) {
  const answers = {};
  for (const [k, q] of Object.entries(body.questions)) {
    if (q.type === 'noul') answers[k] = { type: 'noul', noul: 0.1 };
    else if (q.type === 'choice') answers[k] = { type: 'choice', choice: Object.keys(q.criteria)[0], confidence: 0.9 };
    else answers[k] = { type: 'score', score: 1, legend: Object.fromEntries(q.criteria.map((l, i) => [String(i), l])), confidence: 0.85 };
  }
  return { model: 'jev-mock', answers };
}

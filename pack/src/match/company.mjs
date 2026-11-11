// Proxy tới Company Tools: MCP server riêng của trận (03 §9). Key chỉ nằm trong helper;
// kết quả là dữ liệu untrusted. Server giới hạn mỗi API key 120 request/phút và burst 20 request/10 giây, dùng chung
// cho cả đội (mọi worker tra qua helper của root). LXRMBRA2: helper chỉ giữ cửa sổ 60 s (100 request), nên một job tra
// log hàng loạt (8 lời gọi song song) bắn liền tới 100 request đầu phút, vượt burst; lỗi bị job thử lại và bỏ qua.
import { HelperError, fail, sleep } from '../core/util.mjs';

// [cửa sổ ms, số request tối đa], chừa khoảng trống dưới giới hạn của server (đồng hồ hai bên lệch nhau). BTC (10/11)
// sẽ nâng burst lên 60/10 giây và hiện giới hạn trên trang /match/<id>; tới khi helper đọc được trang đó, đổi bằng
// "companyLimits" trong runtime.json (vd [[10000, 55], [60000, 110]]).
export const COMPANY_LIMITS = [[10_000, 18], [60_000, 110]];
// Giá trị hợp lệ: mảng 1–4 cặp [ms 1000–600000, max 1–1000] số nguyên; sai thì dùng mặc định.
export function companyLimits(value) {
  const ok = Array.isArray(value) && value.length >= 1 && value.length <= 4 && value.every(p => Array.isArray(p) && p.length === 2
    && Number.isInteger(p[0]) && p[0] >= 1000 && p[0] <= 600_000 && Number.isInteger(p[1]) && p[1] >= 1 && p[1] <= 1000);
  return ok ? value.map(([ms, max]) => [ms, max]) : COMPANY_LIMITS;
}
// HTTP 429: chờ theo Retry-After (tối đa 10 s, không có thì 5 s) rồi gửi lại, tối đa 2 lần.
const RETRY_429 = 2;

export class CompanyTools {
  constructor({ session, http, limits = COMPANY_LIMITS }) {
    this.session = session;
    this.http = http;
    // Mảng, hoặc hàm trả mảng (đọc lại runtime.json mỗi lần, đổi được giữa trận).
    this.limits = limits;
    this.stats = { requests: 0, throttledMs: 0, rejected429: 0 };
    this.sessionId = null;
    this.protocolVersion = null;
    this.tools = null;
    this.sent = [];
    this.waiting = [];
    this.nextId = 1;
  }

  get url() {
    return `${this.session.gameMasterOrigin}/api/v1/mcp/${encodeURIComponent(this.session.descriptor.matchId)}`;
  }

  // Request/phút helper tự cho phép (cửa sổ chặt nhất), để ước lượng một lần tra hàng loạt mất bao lâu.
  ratePerMinute() {
    const limits = typeof this.limits === 'function' ? this.limits() : this.limits;
    return Math.min(...limits.map(([ms, max]) => max * 60_000 / ms));
  }

  // Mọi cửa sổ trượt cùng lúc: chờ tới khi request mới không vượt cửa sổ nào. `weight`: request đang chờ có weight nhỏ
  // hơn đi trước (0: lời gọi lẻ; tra hàng loạt: số lời gọi của cả lần tra, nên lần tra ngắn xong trước). QDO8W480: 341
  // lời gọi của PI-03 chia băng thông với 1015 lời gọi của PI-02 và mất 588 s thay vì khoảng 200 s.
  async throttle(weight = 0) {
    const t0 = Date.now();
    const limits = typeof this.limits === 'function' ? this.limits() : this.limits;
    const me = { weight };
    this.waiting.push(me);
    try { await this.throttleTurn(me, limits, t0); } finally { this.waiting.splice(this.waiting.indexOf(me), 1); }
  }
  async throttleTurn(me, limits, t0) {
    for (;;) {
      if (this.waiting.some(w => w.weight < me.weight)) { await sleep(40); continue; }
      const now = Date.now(), longest = Math.max(...limits.map(([ms]) => ms));
      this.sent = this.sent.filter(t => now - t < longest);
      let wait = 0;
      for (const [ms, max] of limits) {
        const inWindow = this.sent.filter(t => now - t < ms);
        if (inWindow.length >= max) wait = Math.max(wait, ms - (now - inWindow[inWindow.length - max]) + 50);
      }
      if (!wait) { this.sent.push(now); this.stats.requests++; this.stats.throttledMs += now - t0; return; }
      await sleep(wait);
    }
  }

  async rpc(method, params, { notify = false, weight = 0 } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.rpcOnce(method, params, { notify, weight });
      } catch (error) {
        if (error.code !== 'COMPANY_RATE_LIMITED' || attempt >= RETRY_429) throw error;
        this.stats.rejected429++;
        await sleep(error.retryMs);
      }
    }
  }

  async rpcOnce(method, params, { notify = false, weight = 0 } = {}) {
    const key = this.session.secrets.apiKey;
    if (!key) fail('NOT_CONFIGURED', 'company tools need the team API key (GAME phase)');
    await this.throttle(weight);
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream' };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;
    const message = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: this.nextId++, method, params };
    const res = await this.http.request(this.url, { method: 'POST', headers, body: JSON.stringify(message),
      timeoutMs: 45_000, maxBytes: 2 * 1024 * 1024, cookies: false });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 401 || res.status === 403) fail('COMPANY_TOOLS_FORBIDDEN', `HTTP ${res.status}`);
    if (res.status === 404 && this.sessionId && !notify) {
      this.sessionId = null;          // phiên MCP hết hạn: khởi tạo lại một lần
      throw new HelperError('COMPANY_SESSION_EXPIRED');
    }
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      throw Object.assign(new HelperError('COMPANY_RATE_LIMITED', 'HTTP 429 from Company Tools'),
        { retryMs: Math.min(10_000, Number.isFinite(after) && after > 0 ? after * 1000 : 5_000) });
    }
    if (notify) return null;
    if (res.status < 200 || res.status >= 300) fail('COMPANY_TOOLS_ERROR', `HTTP ${res.status}`);
    const reply = res.json ?? parseSse(res.text);
    if (!reply) fail('COMPANY_TOOLS_ERROR', 'unreadable response');
    if (reply.error) fail('COMPANY_TOOLS_ERROR', `${reply.error.code}: ${reply.error.message}`);
    return reply.result;
  }

  async ensureInitialized() {
    if (this.protocolVersion) return;
    const result = await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'team-sdlc-pack', version: '0.1.0' } });
    this.protocolVersion = result?.protocolVersion ?? '2025-06-18';
    await this.rpc('notifications/initialized', {}, { notify: true });
  }

  async call(method, params, opts = {}) {
    await this.ensureInitialized();
    try {
      return await this.rpc(method, params, opts);
    } catch (error) {
      if (error.code !== 'COMPANY_SESSION_EXPIRED') throw error;
      this.protocolVersion = null;
      await this.ensureInitialized();
      return this.rpc(method, params, opts);
    }
  }

  async list({ refresh = false } = {}) {
    if (this.tools && !refresh) return this.tools;
    const result = await this.call('tools/list', {});
    this.tools = (result?.tools ?? []).map(t => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? {},
      ...(t.annotations?.readOnlyHint === true ? { readOnly: true } : {}) }));
    return this.tools;
  }

  async invoke(name, args, { weight = 0 } = {}) {
    return this.call('tools/call', { name, arguments: args ?? {} }, { weight });
  }
}

function parseSse(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try {
      const value = JSON.parse(line.slice(5).trim());
      if (value && (value.result !== undefined || value.error !== undefined)) return value;
    } catch { /* bỏ qua */ }
  }
  return null;
}

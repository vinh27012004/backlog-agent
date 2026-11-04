// Proxy tới Company Tools: MCP server riêng của trận (03 §9). Key chỉ nằm trong helper;
// kết quả là dữ liệu untrusted. Giới hạn 120 request/phút dùng chung cho cả đội.
import { HelperError, fail, sleep } from '../core/util.mjs';

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 100;      // chừa khoảng trống dưới 120 của server

export class CompanyTools {
  constructor({ session, http }) {
    this.session = session;
    this.http = http;
    this.sessionId = null;
    this.protocolVersion = null;
    this.tools = null;
    this.sent = [];
    this.nextId = 1;
  }

  get url() {
    return `${this.session.gameMasterOrigin}/api/v1/mcp/${encodeURIComponent(this.session.descriptor.matchId)}`;
  }

  async throttle() {
    for (;;) {
      const now = Date.now();
      this.sent = this.sent.filter(t => now - t < WINDOW_MS);
      if (this.sent.length < MAX_PER_WINDOW) { this.sent.push(now); return; }
      await sleep(WINDOW_MS - (now - this.sent[0]) + 50);
    }
  }

  async rpc(method, params, { notify = false } = {}) {
    const key = this.session.secrets.apiKey;
    if (!key) fail('NOT_CONFIGURED', 'company tools need the team API key (GAME phase)');
    await this.throttle();
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

  async call(method, params) {
    await this.ensureInitialized();
    try {
      return await this.rpc(method, params);
    } catch (error) {
      if (error.code !== 'COMPANY_SESSION_EXPIRED') throw error;
      this.protocolVersion = null;
      await this.ensureInitialized();
      return this.rpc(method, params);
    }
  }

  async list({ refresh = false } = {}) {
    if (this.tools && !refresh) return this.tools;
    const result = await this.call('tools/list', {});
    this.tools = (result?.tools ?? []).map(t => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? {},
      ...(t.annotations?.readOnlyHint === true ? { readOnly: true } : {}) }));
    return this.tools;
  }

  async invoke(name, args) {
    return this.call('tools/call', { name, arguments: args ?? {} });
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

// HTTP client của helper (05 §7): chỉ origin được phép, redirect thủ công cùng origin,
// cookie jar tự viết, telemetry networkActivity cho Player, không log header/body/query.
import { HelperError, fail } from './util.mjs';

const VERSION = '0.1.0';

export class CookieJar {
  constructor() { this.cookies = new Map(); }   // key `${host}|${name}` → {value, path, expires}

  store(url, response) {
    const host = new URL(url).hostname;
    const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const raw of list) {
      const [pair, ...attrs] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let path = '/';
      let expires = null;
      for (const a of attrs) {
        const [k, v = ''] = a.trim().split('=');
        const key = k.toLowerCase();
        if (key === 'path' && v) path = v;
        if (key === 'max-age') expires = Date.now() + Number(v) * 1000;
        if (key === 'expires' && expires === null) { const t = Date.parse(v); if (!Number.isNaN(t)) expires = t; }
      }
      const id = `${host}|${name}`;
      if (expires !== null && expires <= Date.now()) this.cookies.delete(id);
      else this.cookies.set(id, { value, path, expires });
    }
  }

  header(url) {
    const u = new URL(url);
    const now = Date.now();
    const parts = [];
    for (const [id, c] of this.cookies) {
      const [host, name] = id.split('|');
      if (host !== u.hostname || (c.expires !== null && c.expires <= now) || !u.pathname.startsWith(c.path)) continue;
      parts.push(`${name}=${c.value}`);
    }
    return parts.join('; ');
  }

  get size() { return this.cookies.size; }
  clear() { this.cookies.clear(); }
}

export class HttpClient {
  constructor({ allowedOrigins = () => [] } = {}) {
    this.allowedOrigins = allowedOrigins;
    this.jar = new CookieJar();
    this.activity = [];          // networkActivity chưa báo cho Player
    this.skewMs = 0;
  }

  takeActivity() {
    const out = this.activity.slice(0, 100);
    this.activity = [];
    return out;
  }

  record(url, method, httpStatus) {
    const u = new URL(url);
    this.activity.push({ url: `${u.origin}${u.pathname}`, method, httpStatus });
    if (this.activity.length > 200) this.activity.shift();
  }

  now() { return Date.now() + this.skewMs; }

  // Trả {status, headers, json, text, requestId, url}. Lỗi mạng/timeout → HelperError NETWORK_ERROR.
  async request(url, { method = 'GET', headers = {}, body, timeoutMs = 15_000, maxBytes = 2 * 1024 * 1024,
    cookies = true, maxRedirects = 3 } = {}) {
    let current = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const origin = new URL(current).origin;
      if (!this.allowedOrigins().includes(origin)) fail('ORIGIN_NOT_ALLOWED', origin);
      const h = { 'User-Agent': `team-sdlc-pack/${VERSION}`, ...headers };
      // Portal kiểm CSRF bằng Origin như trình duyệt (403 "Origin check failed" nếu thiếu).
      if (cookies && method !== 'GET' && method !== 'HEAD') h.Origin ??= origin;
      if (cookies) {
        const c = this.jar.header(current);
        if (c) h.Cookie = c;
      }
      let res;
      try {
        res = await fetch(current, { method, headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        this.record(current, method, null);
        throw new HelperError('NETWORK_ERROR', error?.name === 'TimeoutError' ? 'timeout' : (error?.cause?.code ?? 'fetch failed'));
      }
      this.record(current, method, res.status);
      if (cookies) this.jar.store(current, res);
      const date = Date.parse(res.headers.get('date') ?? '');
      if (!Number.isNaN(date)) this.skewMs = date - Date.now();
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location'), current).href;
        if (new URL(next).origin !== origin) fail('ORIGIN_NOT_ALLOWED', 'cross-origin redirect');
        current = next;
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) fail('RESPONSE_TOO_LARGE', String(buf.length));
      const text = buf.toString('utf8');
      let json = null;
      if (/json/i.test(res.headers.get('content-type') ?? '') || /^\s*[[{]/.test(text)) {
        try { json = JSON.parse(text); } catch { json = null; }
      }
      const rid = res.headers.get('x-request-id');
      return { status: res.status, headers: res.headers, json, text, url: current,
        requestId: rid && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(rid) ? rid : null };
    }
    fail('TOO_MANY_REDIRECTS');
  }
}

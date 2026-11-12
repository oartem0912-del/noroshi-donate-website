import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { HttpError } from './util.js';
import { log } from './db.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};
export const mimeOf = (f) => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';

// ---------- ограничитель запросов (в памяти) ----------
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < t) { b = { n: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.n++;
  if (b.n > max) throw new HttpError(429, 'rate_limited', 'Слишком много запросов. Попробуйте позже.');
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60_000).unref();
export const _resetRateLimits = () => buckets.clear();

export function clientIp(req) {
  if (config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '0.0.0.0';
}

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class Ctx {
  constructor(req, res) {
    this.req = req; this.res = res;
    this.url = new URL(req.url, 'http://x');
    this.path = this.url.pathname;
    this.query = Object.fromEntries(this.url.searchParams);
    this.params = {};
    this.method = req.method;
    this.ip = clientIp(req);
    this.cookies = parseCookies(req.headers.cookie);
    this.setCookies = [];
    this.responded = false;
    this._raw = null;
  }

  /** Тело запроса целиком (с ограничением размера). */
  async raw(limit = 256 * 1024) {
    if (this._raw) return this._raw;
    const chunks = []; let size = 0;
    for await (const c of this.req) {
      size += c.length;
      if (size > limit) throw new HttpError(413, 'too_large', 'Слишком большой запрос');
      chunks.push(c);
    }
    return (this._raw = Buffer.concat(chunks));
  }
  async json(limit) {
    const b = await this.raw(limit);
    if (!b.length) return {};
    try { const v = JSON.parse(b.toString('utf8')); if (v === null || typeof v !== 'object') throw new Error(); return v; } catch { throw new HttpError(400, 'bad_json', 'Некорректный JSON'); }
  }
  async form() {
    const b = await this.raw();
    return Object.fromEntries(new URLSearchParams(b.toString('utf8')));
  }

  cookie(name, value, opts = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (config.baseUrl.startsWith('https://')) parts.push('Secure');
    if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
    this.setCookies.push(parts.join('; '));
  }
  clearCookie(name) { this.cookie(name, '', { maxAge: 0 }); }

  send(status, body, headers = {}) {
    if (this.responded) return;
    this.responded = true;
    const h = { ...headers };
    if (this.setCookies.length) h['Set-Cookie'] = this.setCookies;
    this.res.writeHead(status, h);
    this.res.end(body);
  }
  json_(status, obj, headers = {}) { this.send(status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); }
  ok(obj = {}) { this.json_(200, { ok: true, ...obj }); }
  html(body, status = 200, headers = {}) { this.send(status, body, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); }
  text(body, status = 200, type = 'text/plain; charset=utf-8') { this.send(status, body, { 'Content-Type': type }); }
  redirect(to, status = 303) { this.send(status, '', { Location: to }); }
}

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler, opts });
    return this;
  }
  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  del(p, h, o) { return this.add('DELETE', p, h, o); }
  match(method, p) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(p);
      if (m) { const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); return { r, params }; }
    }
    return null;
  }
}

const staticCache = new Map();
function serveStatic(ctx, baseDir, rel, extraHeaders = {}) {
  const full = path.resolve(baseDir, '.' + path.posix.normalize('/' + rel));
  if (!full.startsWith(path.resolve(baseDir) + path.sep)) return false;
  let st;
  try { st = fs.statSync(full); } catch { return false; }
  if (!st.isFile()) return false;
  const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
  const headers = { 'Content-Type': mimeOf(full), ETag: etag, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': config.production ? 'public, max-age=300' : 'no-cache', ...extraHeaders };
  if (ctx.req.headers['if-none-match'] === etag) { ctx.send(304, '', headers); return true; }
  let body = staticCache.get(full);
  if (!body || body.etag !== etag) { body = { etag, data: fs.readFileSync(full) }; if (st.size < 512 * 1024) staticCache.set(full, body); }
  ctx.send(200, body.data, headers);
  return true;
}
export { serveStatic };

export function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "style-src-attr 'unsafe-inline'", "img-src 'self' https: data:",
    "connect-src 'self'", "font-src 'self'", "frame-src 'self'", "frame-ancestors 'self'", "object-src 'none'",
    "base-uri 'self'", "form-action 'self' https://www.liqpay.ua",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self)');
  if (config.baseUrl.startsWith('https://')) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/** CSRF-защита для браузерных запросов: Origin/Sec-Fetch-Site должны указывать на наш сайт. */
export function checkSameOrigin(ctx) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(ctx.method)) return;
  const sfs = ctx.req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') throw new HttpError(403, 'csrf', 'Запрос отклонён');
  const origin = ctx.req.headers.origin;
  if (origin) {
    const allowed = new URL(config.baseUrl).origin;
    const host = ctx.req.headers.host;
    let ok = origin === allowed;
    try { ok = ok || new URL(origin).host === host; } catch { ok = false; }
    if (!ok) throw new HttpError(403, 'csrf', 'Запрос отклонён');
  } else if (!sfs) {
    // ни Origin, ни Sec-Fetch-Site: допускаем только не-браузерные JSON-клиенты без cookie
    if (ctx.req.headers.cookie) throw new HttpError(403, 'csrf', 'Запрос отклонён');
  }
}

export async function dispatch(router, req, res, { staticDirs = [] } = {}) {
  const ctx = new Ctx(req, res);
  securityHeaders(res);
  try {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const m = router.match(method, ctx.path);
    if (m) {
      ctx.params = m.params;
      if (!m.r.opts.noCsrf) checkSameOrigin(ctx);
      await m.r.handler(ctx);
      if (!ctx.responded) ctx.send(204, '');
      return;
    }
    if (method === 'GET') {
      for (const [prefix, dir, headers] of staticDirs) {
        if (ctx.path.startsWith(prefix) && serveStatic(ctx, dir, ctx.path.slice(prefix.length), headers)) return;
      }
    }
    notFound(ctx);
  } catch (e) {
    if (ctx.responded) return;
    const wantsJson = ctx.path.startsWith('/api/') || (req.headers.accept || '').includes('application/json');
    if (e instanceof HttpError) {
      if (wantsJson) ctx.json_(e.status, { ok: false, error: e.code, message: e.message });
      else ctx.html(errorPage(e.status, e.message), e.status);
    } else {
      log('error', 'http', `${req.method} ${ctx.path}: ${e?.message}`, { stack: String(e?.stack).split('\n').slice(0, 4) });
      if (wantsJson) ctx.json_(500, { ok: false, error: 'internal', message: 'Внутренняя ошибка сервера' });
      else ctx.html(errorPage(500, 'Внутренняя ошибка сервера'), 500);
    }
  }
}

export function notFound(ctx) {
  const wantsJson = ctx.path.startsWith('/api/');
  if (wantsJson) ctx.json_(404, { ok: false, error: 'not_found', message: 'Не найдено' });
  else ctx.html(errorPage(404, 'Страница не найдена'), 404);
}

function errorPage(status, message) {
  const safe = String(message).replace(/[<>&"]/g, '');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${status} — Noroshi</title><link rel="stylesheet" href="/css/site.css"></head><body class="errpage"><main class="err"><div class="err-code">${status}</div><p>${safe}</p><a class="btn" href="/">На главную</a></main></body></html>`;
}

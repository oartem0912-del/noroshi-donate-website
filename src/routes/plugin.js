// API для Minecraft-плагина. Каждый запрос подписан HMAC-SHA256, ответ тоже подписывается.
// Формат подписи описан в docs/API.md.
import { config } from '../config.js';
import { q, tx, log } from '../db.js';
import { now, sha256, hmacHex, safeEqual, HttpError, safeJson } from '../util.js';
import { rateLimit } from '../http.js';
import { confirmCode, normUuid } from '../linking.js';

const nonces = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of nonces) if (v < t) nonces.delete(k); }, 30_000).unref();
export const _clearNonces = () => nonces.clear();

const LEASE_MS = 120_000;
const MAX_ATTEMPTS_SEEN = 50;

export const canonical = ({ ts, nonce, method, path, body }) => `${ts}\n${nonce}\n${method}\n${path}\n${sha256(body)}`;
export const sign = (secret, parts) => hmacHex(secret, canonical(parts));

async function verified(ctx) {
  const h = ctx.req.headers;
  const ts = String(h['x-noroshi-timestamp'] || ''); const nonce = String(h['x-noroshi-nonce'] || ''); const sig = String(h['x-noroshi-signature'] || '');
  const server = String(h['x-noroshi-server'] || '').slice(0, 64);
  if (!ts || !nonce || !sig || nonce.length < 12 || nonce.length > 64) throw new HttpError(401, 'unsigned', 'Нет подписи');
  const skew = Math.abs(Date.now() / 1000 - Number(ts));
  if (!(skew <= config.pluginMaxSkewSec)) throw new HttpError(401, 'stale', 'Просроченная подпись (проверьте время на сервере)');
  const body = (await ctx.raw(128 * 1024)).toString('utf8');
  const expect = sign(config.pluginSecret, { ts, nonce, method: ctx.method, path: ctx.url.pathname + ctx.url.search, body });
  if (!safeEqual(expect, sig)) { log('warn', 'plugin', 'Неверная подпись запроса плагина', { ip: ctx.ip }); throw new HttpError(401, 'bad_signature', 'Неверная подпись'); }
  if (nonces.has(nonce)) throw new HttpError(401, 'replay', 'Повторный запрос');
  nonces.set(nonce, Date.now() + config.pluginMaxSkewSec * 2000);
  ctx.pluginNonce = nonce; ctx.pluginServer = server || 'default';
  return body ? safeJson(body, {}) : {};
}

function reply(ctx, status, obj) {
  const body = JSON.stringify(obj);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = hmacHex(config.pluginSecret, `${ctx.pluginNonce || '-'}\n${ts}\n${sha256(body)}`);
  ctx.send(status, body, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Noroshi-Response-Timestamp': ts, 'X-Noroshi-Response-Signature': sig });
}

const guarded = (fn) => async (ctx) => {
  rateLimit(`plugin:${ctx.ip}`, 600, 60_000);
  try { const body = await verified(ctx); await fn(ctx, body); } catch (e) {
    if (e instanceof HttpError) { reply(ctx, e.status, { ok: false, error: e.code, message: e.message }); return; }
    throw e;
  }
};

export function mountPlugin(router) {
  const opt = { noCsrf: true };

  router.post('/api/plugin/heartbeat', guarded((ctx, b) => {
    const s = b.server || {};
    const players = Array.isArray(b.players) ? b.players.map(String).slice(0, 500) : [];
    q.run(`INSERT INTO servers(name, version, online, max_players, players, last_seen) VALUES(?,?,?,?,?,?)
           ON CONFLICT(name) DO UPDATE SET version=excluded.version, online=excluded.online, max_players=excluded.max_players, players=excluded.players, last_seen=excluded.last_seen`,
    ctx.pluginServer, String(s.version || '').slice(0, 64), Number(b.online) || 0, Number(b.max) || 0, JSON.stringify(players), now());
    const pending = q.get("SELECT COUNT(*) n FROM orders WHERE status='paid' AND delivery_status IN ('queued','delivering')").n;
    reply(ctx, 200, { ok: true, serverTime: now(), pending });
  }), opt);

  // Выдача заказов: заказ переходит в «delivering» с арендой (lease). Если плагин упал — аренда истечёт, заказ вернётся в очередь.
  router.get('/api/plugin/orders', guarded((ctx) => {
    const limit = Math.min(parseInt(ctx.query.limit, 10) || 20, 50);
    const rows = tx(() => {
      const t = now();
      const list = q.all(`SELECT * FROM orders WHERE status='paid' AND (delivery_status='queued' OR (delivery_status='delivering' AND delivery_lease_until < ?))
                          ORDER BY paid_at LIMIT ?`, t, limit);
      for (const o of list) q.run("UPDATE orders SET delivery_status='delivering', delivery_lease_until=?, updated_at=? WHERE id=?", t + LEASE_MS, t, o.id);
      return list;
    });
    reply(ctx, 200, {
      ok: true,
      orders: rows.map((o) => ({
        id: o.id, attempt: o.delivery_attempt, productName: o.product_name,
        player: { uuid: o.mc_uuid, name: o.mc_name },
        commands: safeJson(o.delivery_commands, []), requireOnline: !!o.require_online,
      })),
    });
  }), opt);

  router.post('/api/plugin/orders/:id/result', guarded((ctx, b) => {
    const status = b.status === 'delivered' ? 'delivered' : b.status === 'failed' ? 'failed' : null;
    if (!status) throw new HttpError(400, 'bad_status', 'status: delivered|failed');
    const attempt = Number(b.attempt);
    const message = String(b.message || '').slice(0, 500);
    const o = q.get('SELECT id, status, delivery_status, delivery_attempt FROM orders WHERE id = ?', ctx.params.id);
    if (!o) throw new HttpError(404, 'no_order', 'Заказ не найден');
    if (attempt !== o.delivery_attempt) { reply(ctx, 200, { ok: true, ignored: 'stale_attempt' }); return; }
    if (o.delivery_status === 'delivered') { reply(ctx, 200, { ok: true, duplicate: true }); return; } // повтор — идемпотентно
    q.run("UPDATE orders SET delivery_status=?, delivery_message=?, delivered_at=?, delivery_lease_until=NULL, updated_at=? WHERE id=?",
      status, message, status === 'delivered' ? now() : null, now(), o.id);
    log(status === 'delivered' ? 'info' : 'error', 'delivery', `Заказ ${o.id}: ${status}`, { message, attempt });
    reply(ctx, 200, { ok: true });
  }), opt);

  router.post('/api/plugin/link/confirm', guarded((ctx, b) => {
    rateLimit(`linkconfirm:${normUuid(b.uuid)}`, 10, 60_000);
    try {
      const r = confirmCode({ code: b.code, uuid: b.uuid, name: b.name });
      reply(ctx, 200, { ok: true, ...r });
    } catch (e) {
      if (e instanceof HttpError) { reply(ctx, 200, { ok: false, error: e.code, message: e.message }); return; } // плагину нужен текст ошибки для игрока
      throw e;
    }
  }), opt);
}

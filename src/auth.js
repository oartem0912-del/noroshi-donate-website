import { config } from './config.js';
import { q, tx, log } from './db.js';
import { now, sha256, randToken, numericCode, safeEqual, HttpError } from './util.js';
import { rateLimit } from './http.js';
import { sendMail } from './mail.js';

export const OWNER_COOKIE = 'no_sid';
export const PLAYER_COOKIE = 'np_sid';
const OWNER_TTL = 12 * 3600_000;
const PLAYER_TTL = 30 * 24 * 3600_000;
const CODE_TTL = 10 * 60_000;

// ---------------- владельцы ----------------
export function ensureOwners() {
  const t = now();
  const seed = [[config.owners.primary, 'primary'], [config.owners.secondary, 'secondary']];
  for (const [email, role] of seed) {
    if (!email) continue;
    const row = q.get('SELECT email FROM owners WHERE role = ?', role);
    if (!row) q.run('INSERT OR IGNORE INTO owners(email, role, added_at) VALUES(?,?,?)', email, role, t);
  }
}
export const listOwners = () => q.all('SELECT email, role, added_at, verified_at FROM owners ORDER BY role');
export const isOwnerEmail = (email) => !!q.get('SELECT 1 x FROM owners WHERE email = ?', String(email).toLowerCase());
const otherOwner = (email) => q.get('SELECT email FROM owners WHERE email != ? ORDER BY role LIMIT 1', email)?.email;

// ---------------- сессии ----------------
export function createSession(ctx, kind, extra = {}) {
  const token = randToken(32);
  const t = now();
  const ttl = kind === 'owner' ? OWNER_TTL : PLAYER_TTL;
  q.run('INSERT INTO sessions(id,kind,email,mc_uuid,mc_name,created_at,expires_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',
    sha256(token), kind, extra.email ?? null, null, null, t, t + ttl, t);
  ctx.cookie(kind === 'owner' ? OWNER_COOKIE : PLAYER_COOKIE, token, { maxAge: ttl / 1000 });
  return q.get('SELECT * FROM sessions WHERE id = ?', sha256(token));
}

export function getSession(ctx, kind) {
  const name = kind === 'owner' ? OWNER_COOKIE : PLAYER_COOKIE;
  const token = ctx.cookies[name];
  if (!token || token.length < 20) return null;
  const s = q.get('SELECT * FROM sessions WHERE id = ? AND kind = ?', sha256(token), kind);
  if (!s) return null;
  if (s.expires_at < now()) { q.run('DELETE FROM sessions WHERE id = ?', s.id); return null; }
  if (kind === 'owner' && !isOwnerEmail(s.email)) { q.run('DELETE FROM sessions WHERE id = ?', s.id); return null; }
  return s;
}
export const getOwner = (ctx) => getSession(ctx, 'owner');
export const playerSession = (ctx, create = false) => getSession(ctx, 'player') || (create ? createSession(ctx, 'player') : null);

export function requireOwner(ctx) {
  const s = getOwner(ctx);
  if (!s) throw new HttpError(401, 'unauthorized', 'Нужна авторизация владельца');
  return s;
}
export function destroySession(ctx, kind) {
  const token = ctx.cookies[kind === 'owner' ? OWNER_COOKIE : PLAYER_COOKIE];
  if (token) q.run('DELETE FROM sessions WHERE id = ?', sha256(token));
  ctx.clearCookie(kind === 'owner' ? OWNER_COOKIE : PLAYER_COOKIE);
}
export const purgeExpired = () => {
  const t = now();
  q.run('DELETE FROM sessions WHERE expires_at < ?', t);
  q.run('DELETE FROM login_codes WHERE expires_at < ?', t - 3600_000);
  q.run('DELETE FROM confirmations WHERE expires_at < ?', t - 3600_000);
  q.run("DELETE FROM link_requests WHERE expires_at < ?", t - 24 * 3600_000);
};

// ---------------- вход владельца по коду на почту ----------------
export async function requestOwnerCode(email, ip) {
  email = String(email || '').trim().toLowerCase();
  rateLimit(`ocode:ip:${ip}`, 10, 15 * 60_000);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'bad_email', 'Некорректный адрес');
  // Ответ одинаков для любого адреса — не раскрываем, кто является владельцем.
  if (!isOwnerEmail(email)) { log('warn', 'auth', 'Запрос кода для неизвестного адреса', { ip }); return; }
  rateLimit(`ocode:mail:${email}`, 5, 15 * 60_000);
  const code = numericCode(6);
  q.run('UPDATE login_codes SET used = 1 WHERE email = ? AND used = 0', email);
  q.run('INSERT INTO login_codes(email, code_hash, expires_at, created_at) VALUES(?,?,?,?)', email, sha256(`${email}:${code}`), now() + CODE_TTL, now());
  await sendMail({ to: email, subject: 'Noroshi Donate — код входа', text: `Ваш код входа: ${code}\nОн действует 10 минут. Если это были не вы — просто игнорируйте письмо.` });
}

export function verifyOwnerCode(ctx, email, code) {
  email = String(email || '').trim().toLowerCase(); code = String(code || '').trim();
  rateLimit(`overify:ip:${ctx.ip}`, 20, 15 * 60_000);
  const row = q.get('SELECT * FROM login_codes WHERE email = ? AND used = 0 ORDER BY id DESC LIMIT 1', email);
  const fail = () => { throw new HttpError(400, 'bad_code', 'Неверный или просроченный код'); };
  if (!row || row.expires_at < now() || !isOwnerEmail(email)) fail();
  q.run('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
  if (row.attempts + 1 > 5) { q.run('UPDATE login_codes SET used = 1 WHERE id = ?', row.id); fail(); }
  if (!safeEqual(row.code_hash, sha256(`${email}:${code}`))) fail();
  q.run('UPDATE login_codes SET used = 1 WHERE id = ?', row.id);
  q.run('UPDATE owners SET verified_at = COALESCE(verified_at, ?) WHERE email = ?', now(), email);
  const s = createSession(ctx, 'owner', { email });
  log('info', 'auth', 'Вход владельца', { email, ip: ctx.ip });
  return s;
}

// ---------------- подтверждение критичных действий ----------------
const handlers = new Map();
/** Регистрация исполнителя критичного действия: fn(payload, requestedBy). */
export const onConfirmed = (action, fn) => handlers.set(action, fn);

/** Код подтверждения уходит на ДРУГОЙ адрес владельца (на свой — только если второго нет). */
export async function requestConfirmation(action, payload, requestedBy, describe) {
  rateLimit(`confirm:${requestedBy}`, 10, 3600_000);
  const sentTo = otherOwner(requestedBy) || requestedBy;
  const id = randToken(12); const code = numericCode(6);
  q.run('INSERT INTO confirmations(id, action, payload, code_hash, requested_by, sent_to, expires_at, created_at) VALUES(?,?,?,?,?,?,?,?)',
    id, action, JSON.stringify(payload), sha256(`${id}:${code}`), requestedBy, sentTo, now() + CODE_TTL, now());
  await sendMail({ to: sentTo, subject: 'Noroshi Donate — подтверждение действия', text: `Владелец ${requestedBy} запросил действие:\n${describe}\n\nКод подтверждения: ${code}\nКод действует 10 минут. Если вы не ожидали этого письма — не вводите код.` });
  return { id, sentTo: maskEmail(sentTo) };
}
export function confirmAction(id, code, by) {
  rateLimit(`confirmtry:${by}`, 15, 15 * 60_000);
  const row = q.get('SELECT * FROM confirmations WHERE id = ? AND used = 0', String(id));
  const fail = () => { throw new HttpError(400, 'bad_code', 'Неверный или просроченный код'); };
  if (!row || row.expires_at < now() || row.requested_by !== by) fail();
  q.run('UPDATE confirmations SET attempts = attempts + 1 WHERE id = ?', row.id);
  if (row.attempts + 1 > 5) { q.run('UPDATE confirmations SET used = 1 WHERE id = ?', row.id); fail(); }
  if (!safeEqual(row.code_hash, sha256(`${row.id}:${String(code).trim()}`))) fail();
  const fn = handlers.get(row.action);
  if (!fn) throw new HttpError(500, 'no_handler', 'Неизвестное действие');
  return tx(() => {
    q.run('UPDATE confirmations SET used = 1 WHERE id = ?', row.id);
    const result = fn(JSON.parse(row.payload), row.requested_by);
    log('info', 'confirm', `Подтверждено: ${row.action}`, { by });
    return result;
  });
}
export const maskEmail = (e) => e.replace(/^(.).*(@.*)$/, '$1•••$2');

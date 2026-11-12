// Привязка Minecraft-аккаунта: одноразовый код, который игрок вводит В ИГРЕ (/donate confirm КОД).
// Ввод чужого ника на сайте ничего не даёт: код видит только тот, кто сидит на сайте, а подтвердить его
// может только игрок, реально зашедший на сервер под этим ником.
import { q, tx, log } from './db.js';
import { now, sha256, linkCode, randToken, MC_NAME_RE, HttpError } from './util.js';

const TTL = 10 * 60_000;
export const normUuid = (u) => String(u || '').replace(/-/g, '').toLowerCase();

function issue(session, purpose, nickname, uuid) {
  q.run("UPDATE link_requests SET status='superseded' WHERE session_id = ? AND status='pending'", session.id);
  const code = linkCode(8);
  q.run('INSERT INTO link_requests(id, session_id, purpose, nickname, mc_uuid, code_hash, expires_at, created_at) VALUES(?,?,?,?,?,?,?,?)',
    randToken(9), session.id, purpose, nickname, uuid, sha256(code), now() + TTL, now());
  return { code, expiresInSec: TTL / 1000 };
}

export function startLink(session, nickname) {
  nickname = String(nickname || '').trim();
  if (!MC_NAME_RE.test(nickname)) throw new HttpError(400, 'bad_nick', 'Ник: 3–16 символов, латиница, цифры и _');
  return { ...issue(session, 'link', nickname, null), nickname };
}

export function startUnlink(session) {
  if (!session.mc_uuid) throw new HttpError(400, 'not_linked', 'Аккаунт не привязан');
  return { ...issue(session, 'unlink', session.mc_name, session.mc_uuid), nickname: session.mc_name };
}

export function linkStatus(session) {
  const pending = q.get("SELECT purpose, nickname, expires_at FROM link_requests WHERE session_id = ? AND status='pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 1", session.id, now());
  return {
    linked: !!session.mc_uuid, nickname: session.mc_name || null, uuid: session.mc_uuid || null,
    pending: pending ? { purpose: pending.purpose, nickname: pending.nickname, expiresAt: pending.expires_at } : null,
  };
}

/** Вызывается плагином от имени игрока (запрос подписан HMAC). */
export function confirmCode({ code, uuid, name }) {
  uuid = normUuid(uuid); name = String(name || '');
  if (!/^[0-9a-f]{32}$/.test(uuid)) throw new HttpError(400, 'bad_uuid', 'Некорректный UUID');
  if (!MC_NAME_RE.test(name) && !/^[.A-Za-z0-9_]{3,20}$/.test(name)) throw new HttpError(400, 'bad_nick', 'Некорректный ник');
  return tx(() => {
    const r = q.get("SELECT * FROM link_requests WHERE code_hash = ? AND status = 'pending'", sha256(String(code || '').trim().toUpperCase()));
    if (!r || r.expires_at < now()) throw new HttpError(404, 'bad_code', 'Код не найден или просрочен');
    if (r.purpose === 'link') {
      if (r.nickname.toLowerCase() !== name.toLowerCase()) throw new HttpError(403, 'wrong_nick', `Код выдан для ника ${r.nickname}`);
      q.run(`INSERT INTO mc_accounts(uuid, name, linked_at, updated_at) VALUES(?,?,?,?)
             ON CONFLICT(uuid) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`, uuid, name, now(), now());
      q.run('UPDATE sessions SET mc_uuid = ?, mc_name = ? WHERE id = ?', uuid, name, r.session_id);
      q.run("UPDATE link_requests SET status='confirmed' WHERE id = ?", r.id);
      log('info', 'link', 'Аккаунт привязан', { name, uuid });
      return { purpose: 'link', name };
    }
    if (r.mc_uuid !== uuid) throw new HttpError(403, 'wrong_owner', 'Подтвердить отвязку может только владелец аккаунта');
    q.run('UPDATE sessions SET mc_uuid = NULL, mc_name = NULL WHERE id = ?', r.session_id);
    q.run("UPDATE link_requests SET status='confirmed' WHERE id = ?", r.id);
    log('info', 'link', 'Аккаунт отвязан', { name, uuid });
    return { purpose: 'unlink', name };
  });
}

// Резервные копии SQLite: VACUUM INTO даёт согласованный снимок без остановки сервиса.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { raw, log } from './db.js';

export const backupDir = () => path.join(config.dataDir, 'backups');

export function makeBackup() {
  fs.mkdirSync(backupDir(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(backupDir(), `noroshi-${stamp}.sqlite`);
  raw().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const check = verifyBackup(file);
  if (!check.ok) { fs.rmSync(file, { force: true }); throw new Error('Резервная копия не прошла проверку: ' + check.error); }
  const files = fs.readdirSync(backupDir()).filter((f) => f.endsWith('.sqlite')).sort();
  for (const old of files.slice(0, Math.max(0, files.length - config.backupKeep))) fs.rmSync(path.join(backupDir(), old), { force: true });
  log('info', 'backup', 'Резервная копия создана', { file: path.basename(file) });
  return file;
}

/** Проверка восстановления: открываем копию, integrity_check и проверяем, что ключевые таблицы читаются. */
export function verifyBackup(file) {
  let d;
  try {
    d = new DatabaseSync(file, { readOnly: true });
    const ic = d.prepare('PRAGMA integrity_check').get().integrity_check;
    if (ic !== 'ok') return { ok: false, error: 'integrity_check: ' + ic };
    const orders = d.prepare('SELECT COUNT(*) n FROM orders').get().n;
    const products = d.prepare('SELECT COUNT(*) n FROM products').get().n;
    return { ok: true, orders, products };
  } catch (e) { return { ok: false, error: e.message }; } finally { try { d?.close(); } catch { /* */ } }
}

export function latestBackup() {
  if (!fs.existsSync(backupDir())) return null;
  const f = fs.readdirSync(backupDir()).filter((x) => x.endsWith('.sqlite')).sort().pop();
  return f ? path.join(backupDir(), f) : null;
}

import http from 'node:http';
import path from 'node:path';
import { config, validateConfig } from './config.js';
import { openDb, closeDb, log, q } from './db.js';
import { Router, dispatch } from './http.js';
import { ensureOwners, purgeExpired } from './auth.js';
import { mountPublic, seedContent } from './routes/public.js';
import { mountAdmin, uploadsDir } from './routes/admin.js';
import { mountPlugin } from './routes/plugin.js';
import { expirePendingOrders } from './payments/core.js';
import { refreshRates } from './rates.js';
import { makeBackup } from './backup.js';

export function buildApp() {
  const router = new Router();
  mountPublic(router);
  mountAdmin(router);
  mountPlugin(router);
  const staticDirs = [
    ['/uploads/', uploadsDir(), { 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'public, max-age=86400' }],
    ['/', config.publicDir, {}],
  ];
  return http.createServer((req, res) => { dispatch(router, req, res, { staticDirs }); });
}

export function startJobs() {
  const timers = [];
  const every = (ms, fn, name) => { const t = setInterval(() => { try { const r = fn(); if (r?.catch) r.catch((e) => log('error', 'job', `${name}: ${e.message}`)); } catch (e) { log('error', 'job', `${name}: ${e.message}`); } }, ms); t.unref(); timers.push(t); };
  every(10 * 60_000, () => { purgeExpired(); expirePendingOrders(); }, 'cleanup');
  every(6 * 3600_000, refreshRates, 'rates');
  every(config.backupIntervalHours * 3600_000, makeBackup, 'backup');
  every(24 * 3600_000, () => q.run('DELETE FROM logs WHERE created_at < ?', Date.now() - 90 * 86400_000), 'logs-gc');
  refreshRates();
  return () => timers.forEach(clearInterval);
}

export function init() {
  validateConfig();
  openDb();
  ensureOwners();
  seedContent();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  try { init(); } catch (e) { console.error(e.message); process.exit(1); }
  const server = buildApp();
  startJobs();
  server.listen(config.port, config.host, () => {
    console.log(`Noroshi Donate запущен: ${config.baseUrl} (порт ${config.port}, ${config.production ? 'production' : 'development'})`);
    if (config.payments.testEnabled) console.warn('⚠ Включена ТЕСТОВАЯ оплата (TEST_PAYMENTS=true). Для боевого режима отключите её.');
  });
  const stop = () => { server.close(() => { closeDb(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  process.on('unhandledRejection', (e) => log('error', 'process', `unhandledRejection: ${e?.message || e}`));
}

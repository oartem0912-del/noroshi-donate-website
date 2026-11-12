// Конфигурация читается из переменных окружения (и из файла .env, если он есть).
// Секреты НИКОГДА не хранятся в репозитории — см. .env.example и README.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(path.resolve('.env')); } catch { /* .env необязателен */ }

const env = process.env;
const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const production = env.NODE_ENV === 'production';

export const config = {
  root,
  production,
  port: int(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  baseUrl: (env.BASE_URL || `http://localhost:${int(env.PORT, 3000)}`).replace(/\/+$/, ''),
  trustProxy: bool(env.TRUST_PROXY, false),
  timezone: env.SITE_TIMEZONE || 'Europe/Kyiv',
  dataDir: path.resolve(env.DATA_DIR || path.join(root, 'data')),
  publicDir: path.join(root, 'public'),

  // Владельцы сайта. Доступ выдаётся только после подтверждения владения ящиком (код на почту).
  owners: {
    primary: (env.OWNER_PRIMARY_EMAIL || 'oartem0912@gmail.com').toLowerCase(),
    secondary: (env.OWNER_SECONDARY_EMAIL || 'amongtem151@gmail.com').toLowerCase(),
  },

  // Общий секрет сайта и плагина (HMAC). Минимум 32 символа.
  pluginSecret: env.PLUGIN_SECRET || (production ? '' : 'dev-only-secret-dev-only-secret-0123456789'),
  pluginMaxSkewSec: int(env.PLUGIN_MAX_SKEW_SEC, 60),

  smtp: {
    host: env.SMTP_HOST || '',
    port: int(env.SMTP_PORT, 465),
    secure: bool(env.SMTP_SECURE, int(env.SMTP_PORT, 465) === 465),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || 'Noroshi Donate <no-reply@localhost>',
  },

  payments: {
    // Тестовая оплата: заказы помечаются test и не попадают в «Доходы» по умолчанию.
    testEnabled: bool(env.TEST_PAYMENTS, !production),
    liqpay: {
      publicKey: env.LIQPAY_PUBLIC_KEY || '',
      privateKey: env.LIQPAY_PRIVATE_KEY || '',
      sandbox: bool(env.LIQPAY_SANDBOX, !production),
    },
  },

  orderPendingTtlHours: int(env.ORDER_PENDING_TTL_HOURS, 24),
  backupKeep: int(env.BACKUP_KEEP, 14),
  backupIntervalHours: int(env.BACKUP_INTERVAL_HOURS, 24),
  allowedOwnerEmailsExtra: list(env.OWNER_EXTRA_EMAILS),
};

export function validateConfig() {
  const problems = [];
  if (!config.pluginSecret || config.pluginSecret.length < 32) problems.push('PLUGIN_SECRET должен быть не короче 32 символов');
  if (production) {
    if (!config.baseUrl.startsWith('https://')) problems.push('В production BASE_URL должен начинаться с https://');
    if (!config.smtp.host) problems.push('В production нужно настроить SMTP_* — иначе владельцы не смогут войти');
  }
  if (config.payments.liqpay.publicKey && !config.payments.liqpay.privateKey) problems.push('LIQPAY_PRIVATE_KEY не задан');
  if (problems.length) throw new Error('Ошибка конфигурации:\n - ' + problems.join('\n - '));
}

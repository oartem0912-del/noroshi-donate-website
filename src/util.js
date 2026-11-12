import crypto from 'node:crypto';

export const now = () => Date.now();
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hmacHex = (secret, s) => crypto.createHmac('sha256', secret).update(s).digest('hex');
export const randToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Сравнение строк за постоянное время. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** Идентификатор заказа: время + случайность, удобно сортировать. */
export function orderId() {
  return 'ord_' + Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Одноразовый код для привязки (без похожих символов). */
export function linkCode(len = 8) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}
export const numericCode = (len = 6) => String(crypto.randomInt(0, 10 ** len)).padStart(len, '0');

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const slugify = (s) => String(s || '').toLowerCase()
  .replace(/[а-яёіїєґ]/g, (c) => ({ а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ё: 'e', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'iu', я: 'ia' }[c] ?? ''))
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/** Копейки/центы -> строка «12.34». */
export const minorToStr = (minor) => (Math.round(minor) / 100).toFixed(2);
/** «12.34» -> копейки. */
export const strToMinor = (s) => Math.round(parseFloat(String(s).replace(',', '.')) * 100);

export const CURRENCY_SYMBOL = { UAH: '₴', EUR: '€', USD: '$', RUB: '₽', USDT: 'USDT' };
export const fmtMoney = (minor, cur) => {
  const v = Math.round(minor); const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v); const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  return `${sign}${whole},${String(abs % 100).padStart(2, '0')} ${CURRENCY_SYMBOL[cur] || cur}`;
};

export const MC_NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

export function safeJson(s, fallback) {
  try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; }
}

/** Разрешены только http(s) и относительные ссылки — защита от javascript:. */
export function safeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  if (s.startsWith('#')) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^mailto:/i.test(s)) return s;
  return '';
}

/** Смещение часового пояса (мс) на момент date. */
function tzOffsetMs(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(date.getTime() / 1000) * 1000;
}

/** Начало дня/недели/месяца в часовом поясе сайта (мс epoch). */
export function startOfPeriod(kind, tz, at = new Date()) {
  const off = tzOffsetMs(at, tz);
  const local = new Date(at.getTime() + off); // «настенное» время в UTC-полях
  let y = local.getUTCFullYear(); let m = local.getUTCMonth(); let d = local.getUTCDate();
  if (kind === 'week') { const wd = (local.getUTCDay() + 6) % 7; d -= wd; }
  if (kind === 'month') d = 1;
  if (kind === 'all') return 0;
  const wall = Date.UTC(y, m, d);
  // корректируем на смещение именно той даты (учёт перехода на летнее время)
  return wall - tzOffsetMs(new Date(wall - off), tz);
}

export class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

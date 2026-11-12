import { q } from './db.js';
import { config } from './config.js';
import { startOfPeriod } from './util.js';

const testCond = (includeTest) => (includeTest ? '' : ' AND test = 0');

function periodSums(since, includeTest) {
  const t = testCond(includeTest);
  const paid = q.get(`SELECT COUNT(*) n, COALESCE(SUM(price_kop),0) gross, COALESCE(SUM(fee_kop),0) fees, COALESCE(SUM(net_kop),0) net
                      FROM orders WHERE status='paid' AND paid_at >= ?${t}`, since);
  const ref = q.get(`SELECT COUNT(*) n, COALESCE(SUM(price_kop),0) amount FROM orders WHERE status='refunded' AND refunded_at >= ?${t}`, since);
  return { orders: paid.n, gross: paid.gross, fees: paid.fees, net: paid.net, refundedOrders: ref.n, refunded: ref.amount };
}

export function incomeSummary({ includeTest = false } = {}) {
  const tz = config.timezone;
  const periods = {};
  for (const k of ['day', 'week', 'month', 'all']) periods[k] = periodSums(startOfPeriod(k, tz), includeTest);
  const t = testCond(includeTest);
  const counts = Object.fromEntries(['paid', 'pending', 'cancelled', 'refunded', 'failed'].map((s) => [s, 0]));
  for (const r of q.all(`SELECT status, COUNT(*) n FROM orders WHERE 1=1${t} GROUP BY status`)) counts[r.status] = r.n;
  const delivery = Object.fromEntries(['queued', 'delivering', 'delivered', 'failed'].map((s) => [s, 0]));
  for (const r of q.all(`SELECT delivery_status s, COUNT(*) n FROM orders WHERE status='paid'${t} GROUP BY delivery_status`)) if (r.s in delivery) delivery[r.s] = r.n;

  // график за 30 дней в часовом поясе сайта
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: tz });
  const since = startOfPeriod('day', tz) - 29 * 86400_000;
  const days = new Map();
  for (let i = 0; i < 30; i++) days.set(fmt.format(new Date(since + i * 86400_000 + 12 * 3600_000)), { date: '', gross: 0, net: 0, orders: 0 });
  for (const o of q.all(`SELECT price_kop, net_kop, paid_at FROM orders WHERE status='paid' AND paid_at >= ?${t}`, since)) {
    const d = days.get(fmt.format(new Date(o.paid_at)));
    if (d) { d.gross += o.price_kop; d.net += o.net_kop; d.orders++; }
  }
  const chart = [...days.entries()].map(([date, v]) => ({ ...v, date }));

  const payouts = q.all('SELECT * FROM payouts ORDER BY paid_at DESC LIMIT 100');
  const paidOut = payouts.reduce((s, p) => s + p.amount_kop, 0);
  const byProvider = q.all(`SELECT provider, COUNT(*) n, COALESCE(SUM(price_kop),0) gross, COALESCE(SUM(fee_kop),0) fees, COALESCE(SUM(net_kop),0) net
                            FROM orders WHERE status='paid'${t} GROUP BY provider`);
  return {
    periods, counts, delivery, chart, byProvider, payouts,
    // Расчётная величина по данным заказов, НЕ баланс у провайдера. Реальный баланс и выплаты — в кабинете провайдера.
    estimatedAvailableKop: periods.all.net - paidOut,
    includeTest,
  };
}

export function listOrders({ status, search, limit = 50, offset = 0, includeTest = true } = {}) {
  const where = []; const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (search) { where.push('(mc_name LIKE ? OR id LIKE ? OR product_name LIKE ?)'); args.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (!includeTest) where.push('test = 0');
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = q.get(`SELECT COUNT(*) n FROM orders ${w}`, ...args).n;
  const rows = q.all(`SELECT id, mc_name, mc_uuid, product_id, product_name, price_kop, provider, currency, amount_minor, rate, status, test, fee_minor, fee_kop, net_kop,
                      paytype, delivery_status, delivery_attempt, delivery_message, created_at, paid_at, refunded_at, delivered_at
                      FROM orders ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...args, Math.min(limit, 200), offset);
  return { total, rows };
}

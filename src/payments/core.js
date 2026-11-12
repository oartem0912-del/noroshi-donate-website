// Ядро платежей: создание заказов и идемпотентная обработка событий провайдеров.
import { q, tx, log, allSettings } from '../db.js';
import { now, orderId, safeJson, HttpError } from '../util.js';
import { getRate, convertKop } from '../rates.js';
import { config } from '../config.js';
import { providers, enabledProviders } from './index.js';

export function productDelivery(p) {
  const d = safeJson(p.delivery, { commands: [], requireOnline: true });
  return { commands: Array.isArray(d.commands) ? d.commands.map(String).filter(Boolean) : [], requireOnline: d.requireOnline !== false };
}

/** Доступные способы оплаты с суммами для цены в копейках. */
export function paymentOptions(priceKop) {
  const s = allSettings();
  const out = [];
  for (const p of enabledProviders(s)) {
    const currencies = [];
    for (const cur of p.currencies) {
      if (!s.currencies.includes(cur)) continue;
      const r = getRate(cur);
      if (!r) continue;
      currencies.push({ code: cur, amountMinor: convertKop(priceKop, r.rate), rate: r.rate });
    }
    if (currencies.length) out.push({ id: p.id, title: p.title, methods: p.methods, test: !!p.test, currencies });
  }
  return out;
}

export function createOrder({ session, product, providerId, currency }) {
  if (!session?.mc_uuid) throw new HttpError(400, 'not_linked', 'Сначала привяжите Minecraft-аккаунт');
  if (!product || !product.active) throw new HttpError(404, 'no_product', 'Товар недоступен');
  const opts = paymentOptions(product.price_kop);
  const prov = opts.find((o) => o.id === providerId);
  const cur = prov?.currencies.find((c) => c.code === currency);
  if (!prov || !cur) throw new HttpError(400, 'bad_payment', 'Этот способ оплаты или валюта сейчас недоступны');
  const del = productDelivery(product);
  if (!del.commands.length) throw new HttpError(400, 'no_delivery', 'У товара не настроено действие выдачи — обратитесь к администратору');
  const acc = q.get('SELECT * FROM mc_accounts WHERE uuid = ?', session.mc_uuid);
  if (!acc) throw new HttpError(400, 'not_linked', 'Аккаунт не найден — привяжите заново');
  const id = orderId(); const t = now();
  q.run(`INSERT INTO orders(id, session_id, mc_uuid, mc_name, product_id, product_name, price_kop, provider, currency, amount_minor, rate,
          status, test, delivery_commands, require_online, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?)`,
  id, session.id, acc.uuid, acc.name, product.id, product.name, product.price_kop, providerId, cur.code, cur.amountMinor, cur.rate,
  providers[providerId].test || (providerId === 'liqpay' && config.payments.liqpay.sandbox) ? 1 : 0,
  JSON.stringify(del.commands), del.requireOnline ? 1 : 0, t, t);
  return q.get('SELECT * FROM orders WHERE id = ?', id);
}

/**
 * Единственная точка, где заказ становится оплаченным/возвращённым.
 * ev: { provider, eventId, orderId, kind: 'paid'|'failed'|'refunded', amountMinor, currency, feeMinor, paymentId, paytype, raw }
 * Идемпотентность: UNIQUE(provider, event_id) + проверка текущего состояния заказа.
 */
export function processPaymentEvent(ev) {
  return tx(() => {
    const o = q.get('SELECT * FROM orders WHERE id = ?', ev.orderId);
    if (!o) { log('warn', 'payments', 'Событие для неизвестного заказа', { orderId: ev.orderId, provider: ev.provider }); return { unknown: true }; }
    if (o.provider !== ev.provider) { log('error', 'payments', 'Провайдер события не совпадает с заказом', { orderId: o.id }); return { mismatch: true }; }
    if (ev.kind === 'paid' && (ev.currency !== o.currency || ev.amountMinor !== o.amount_minor)) {
      // событие не регистрируем как обработанное: корректное повторное уведомление всё ещё может прийти
      log('error', 'payments', 'Сумма/валюта оплаты не совпадает с заказом — выдача отклонена', { orderId: o.id, expected: [o.amount_minor, o.currency], got: [ev.amountMinor, ev.currency] });
      return { mismatch: true };
    }
    const ins = q.run('INSERT OR IGNORE INTO payment_events(provider, event_id, order_id, kind, payload, created_at) VALUES(?,?,?,?,?,?)',
      ev.provider, ev.eventId, ev.orderId, ev.kind, JSON.stringify(ev.raw ?? {}).slice(0, 8000), now());
    if (ins.changes === 0) return { duplicate: true };
    const t = now();

    if (ev.kind === 'paid') {
      if (['paid', 'refunded'].includes(o.status)) return { already: true };
      const feeMinor = Math.max(0, Math.round(ev.feeMinor || 0));
      const feeKop = Math.round(feeMinor * o.rate);
      q.run(`UPDATE orders SET status='paid', paid_at=?, fee_minor=?, fee_kop=?, net_kop=?, provider_payment_id=?, paytype=?,
             delivery_status='queued', updated_at=? WHERE id=?`,
      t, feeMinor, feeKop, o.price_kop - feeKop, ev.paymentId ?? null, ev.paytype ?? null, t, o.id);
      log('info', 'payments', 'Заказ оплачен', { orderId: o.id, provider: ev.provider });
      return { paid: true };
    }
    if (ev.kind === 'refunded') {
      if (o.status !== 'paid') return { ignored: true };
      q.run("UPDATE orders SET status='refunded', refunded_at=?, updated_at=? WHERE id=?", t, t, o.id);
      log('warn', 'payments', 'Возврат по заказу', { orderId: o.id, delivery: o.delivery_status });
      return { refunded: true };
    }
    if (ev.kind === 'failed') {
      if (o.status === 'pending') q.run("UPDATE orders SET status='failed', updated_at=? WHERE id=?", t, o.id);
      return { failed: true };
    }
    return { ignored: true };
  });
}

/** Просроченные неоплаченные заказы -> cancelled (поздняя оплата всё равно будет учтена). */
export function expirePendingOrders() {
  const limit = now() - config.orderPendingTtlHours * 3600_000;
  q.run("UPDATE orders SET status='cancelled', updated_at=? WHERE status='pending' AND created_at < ?", now(), limit);
}

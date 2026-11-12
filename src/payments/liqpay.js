// LiqPay (ПриватБанк): карты, Google Pay, Apple Pay (в зависимости от настроек вашего мерчанта).
// Документация: https://www.liqpay.ua/documentation/api/aquiring/checkout/
import crypto from 'node:crypto';
import { config } from '../config.js';
import { safeEqual, minorToStr, strToMinor } from '../util.js';

const sign = (data) => crypto.createHash('sha1').update(config.payments.liqpay.privateKey + data + config.payments.liqpay.privateKey).digest('base64');

export const liqpay = {
  id: 'liqpay',
  title: 'Карта / Google Pay / Apple Pay (LiqPay)',
  methods: ['Банковские карты', 'Google Pay', 'Apple Pay'],
  currencies: ['UAH', 'USD', 'EUR'], // валюты, которые LiqPay принимает по документации
  isConfigured: () => !!(config.payments.liqpay.publicKey && config.payments.liqpay.privateKey),

  /** Возвращает параметры формы для POST на LiqPay Checkout. */
  checkoutForm(order, product) {
    const params = {
      public_key: config.payments.liqpay.publicKey, version: 3, action: 'pay',
      amount: minorToStr(order.amount_minor), currency: order.currency,
      description: `Noroshi: ${product?.name || order.product_name} для ${order.mc_name}`.slice(0, 200),
      order_id: order.id, language: 'uk',
      result_url: `${config.baseUrl}/order/${order.id}`,
      server_url: `${config.baseUrl}/api/webhooks/liqpay`,
    };
    if (config.payments.liqpay.sandbox) params.sandbox = 1;
    const data = Buffer.from(JSON.stringify(params)).toString('base64');
    return { action: 'https://www.liqpay.ua/api/3/checkout', fields: { data, signature: sign(data) } };
  },

  /** Проверяет подпись и приводит уведомление к общему виду. Бросает ошибку при подделке. */
  parseWebhook(form) {
    const { data, signature } = form || {};
    if (!data || !signature || !safeEqual(sign(String(data)), String(signature))) throw new Error('bad signature');
    const p = JSON.parse(Buffer.from(String(data), 'base64').toString('utf8'));
    const status = String(p.status || '');
    let kind = 'ignored';
    if (status === 'success') kind = 'paid';
    else if (status === 'sandbox') kind = config.payments.liqpay.sandbox ? 'paid' : 'ignored'; // sandbox в боевом режиме не принимаем
    else if (['failure', 'error'].includes(status)) kind = 'failed';
    else if (['reversed', 'refund'].includes(status)) kind = 'refunded';
    const fee = Number(p.receiver_commission ?? 0);
    return {
      provider: 'liqpay',
      eventId: `${p.payment_id || p.transaction_id || p.order_id}:${status}`,
      orderId: String(p.order_id || ''), kind,
      amountMinor: strToMinor(p.amount), currency: String(p.currency || '').toUpperCase(),
      feeMinor: Math.round(fee * 100), paymentId: String(p.payment_id || ''), paytype: p.paytype || null, raw: p,
    };
  },
  _sign: sign,
};

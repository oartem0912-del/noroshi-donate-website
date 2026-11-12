// Публичные страницы, API игрока, вход владельца и вебхуки платёжных провайдеров.
import { q, log, getSetting, allSettings } from '../db.js';
import { config } from '../config.js';
import { esc, safeJson, safeUrl, HttpError, MC_NAME_RE, now } from '../util.js';
import { rateLimit } from '../http.js';
import { getOwner, playerSession, requestOwnerCode, verifyOwnerCode, destroySession } from '../auth.js';
import { startLink, startUnlink, linkStatus } from '../linking.js';
import { renderBlocks, pageContext, layout, productPage, orderPage, serverStatus, md, STARTER_HOME } from '../render.js';
import { paymentOptions, createOrder, processPaymentEvent } from '../payments/core.js';
import { providers } from '../payments/index.js';
import { liqpay } from '../payments/liqpay.js';

function rc(ctx) {
  ctx.session = playerSession(ctx, false);
  ctx.owner = getOwner(ctx);
  return pageContext(ctx);
}
const pageBlocks = (page, owner, preview) => safeJson(preview && owner && page.draft_blocks ? page.draft_blocks : page.blocks, []);

export function seedContent() {
  if (!q.get("SELECT id FROM pages WHERE slug = ''")) {
    q.run("INSERT INTO pages(slug, title, blocks, published, show_in_nav, nav_order, updated_at) VALUES('', 'Главная', ?, 1, 0, 0, ?)", JSON.stringify(STARTER_HOME), now());
  }
}

export function mountPublic(router) {
  // ---------- служебное ----------
  router.get('/healthz', (ctx) => { q.get('SELECT 1 x'); ctx.json_(200, { ok: true }); });

  router.get('/theme.css', (ctx) => {
    const a = String(allSettings().accent);
    const accent = /^#[0-9a-fA-F]{6}$/.test(a) ? a : '#14b8a6';
    ctx.send(200, `:root{--accent:${accent}}`, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
  });

  // ---------- страницы ----------
  router.get('/', (ctx) => {
    const c = rc(ctx);
    const page = q.get("SELECT * FROM pages WHERE slug = ''");
    const html = layout({ title: '', body: renderBlocks(pageBlocks(page, c.owner, ctx.query.preview), c), rc: c, pageSlug: '' });
    ctx.html(html);
  });

  router.get('/p/:slug', (ctx) => {
    const c = rc(ctx);
    const page = q.get('SELECT * FROM pages WHERE slug = ?', ctx.params.slug);
    if (!page || (!page.published && !c.owner)) throw new HttpError(404, 'not_found', 'Страница не найдена');
    ctx.html(layout({ title: page.title, body: renderBlocks(pageBlocks(page, c.owner, ctx.query.preview), c), rc: c, pageSlug: page.slug }));
  });

  router.get('/shop/:slug', (ctx) => {
    const c = rc(ctx);
    const p = q.get('SELECT * FROM products WHERE slug = ?', ctx.params.slug);
    if (!p || (!p.active && !c.owner)) throw new HttpError(404, 'not_found', 'Товар не найден');
    ctx.html(layout({ title: p.name, description: p.short_description, body: productPage(p, c, paymentOptions(p.price_kop)), rc: c, boot: { product: p.id } }));
  });

  // ---------- заказ и оплата ----------
  const myOrder = (ctx) => {
    const s = playerSession(ctx, false);
    const o = q.get('SELECT * FROM orders WHERE id = ?', ctx.params.id);
    if (!o || !((s && o.session_id === s.id) || getOwner(ctx))) throw new HttpError(404, 'not_found', 'Заказ не найден');
    return o;
  };

  router.get('/order/:id', (ctx) => {
    const o = myOrder(ctx);
    const c = rc(ctx);
    ctx.html(layout({ title: 'Заказ', body: orderPage(o, c), rc: c, boot: { order: o.id } }));
  });
  router.get('/api/orders/:id', (ctx) => {
    const o = myOrder(ctx);
    ctx.ok({ status: o.status, delivery: o.delivery_status, deliveryMessage: o.delivery_status === 'failed' ? 'Выдача не удалась — администратор уже видит ошибку' : '' });
  });

  router.get('/pay/go/:id', (ctx) => {
    const o = myOrder(ctx);
    if (o.provider !== 'liqpay' || o.status !== 'pending') return ctx.redirect(`/order/${o.id}`);
    const f = liqpay.checkoutForm(o, q.get('SELECT name FROM products WHERE id = ?', o.product_id));
    ctx.html(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Переход к оплате</title><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/css/site.css"></head><body class="errpage">
<main class="err"><p>Переходим на защищённую страницу оплаты LiqPay…</p>
<form method="post" action="${esc(f.action)}" id="payform">${Object.entries(f.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}<button class="btn" type="submit">Перейти к оплате</button></form></main>
<script src="/js/autosubmit.js"></script></body></html>`);
  });

  router.get('/pay/test/:id', (ctx) => {
    const o = myOrder(ctx);
    if (o.provider !== 'test' || !config.payments.testEnabled) throw new HttpError(404, 'not_found', 'Недоступно');
    const c = rc(ctx);
    ctx.html(layout({ title: 'Тестовая оплата', rc: c, boot: { testPay: o.id }, body: `<section class="block narrow"><div class="wrap"><div class="card pad">
      <div class="badge warn">ТЕСТОВЫЙ РЕЖИМ</div><h1>Тестовая оплата</h1><p class="muted">Реальные деньги не списываются. Кнопка имитирует подтверждение от платёжного провайдера и проходит тот же серверный путь обработки.</p>
      <p><strong>${esc(o.product_name)}</strong> для ${esc(o.mc_name)}</p>
      <div class="row"><button class="btn" data-testpay="paid">Подтвердить оплату</button><button class="btn ghost" data-testpay="failed">Отклонить</button></div><div class="lb-msg small" data-testpay-msg></div></div></div></section>` }));
  });
  router.post('/api/test-pay/:id', async (ctx) => {
    const o = myOrder(ctx);
    if (o.provider !== 'test' || !config.payments.testEnabled) throw new HttpError(404, 'not_found', 'Недоступно');
    const body = await ctx.json();
    const kind = body.result === 'failed' ? 'failed' : 'paid';
    const res = processPaymentEvent({
      provider: 'test', eventId: `${o.id}:${kind}`, orderId: o.id, kind, amountMinor: o.amount_minor, currency: o.currency,
      feeMinor: Math.round(o.amount_minor * 0.03), paymentId: 'test-' + o.id, paytype: 'test', raw: { simulated: true },
    });
    ctx.ok({ result: res });
  });

  // ---------- вебхуки провайдеров ----------
  router.post('/api/webhooks/liqpay', async (ctx) => {
    if (!liqpay.isConfigured()) throw new HttpError(404, 'not_found', 'Провайдер не настроен');
    rateLimit(`wh:${ctx.ip}`, 300, 60_000);
    let ev;
    try { ev = liqpay.parseWebhook(await ctx.form()); } catch (e) {
      log('warn', 'webhook', `LiqPay: отклонён вебхук (${e.message})`, { ip: ctx.ip });
      throw new HttpError(400, 'bad_signature', 'Bad signature');
    }
    if (ev.kind === 'ignored') return ctx.ok({ ignored: true });
    const res = processPaymentEvent(ev);
    ctx.ok({ result: res });
  }, { noCsrf: true });

  // ---------- API игрока ----------
  router.get('/api/status', (ctx) => ctx.ok({ status: serverStatus() }));

  router.get('/api/link/status', (ctx) => {
    const s = playerSession(ctx, false);
    ctx.ok(s ? linkStatus(s) : { linked: false, nickname: null, pending: null });
  });
  router.post('/api/link/start', async (ctx) => {
    rateLimit(`linkstart:${ctx.ip}`, 10, 10 * 60_000);
    const b = await ctx.json();
    const s = playerSession(ctx, true);
    ctx.ok(startLink(s, b.nickname));
  });
  router.post('/api/link/unlink', (ctx) => {
    rateLimit(`unlink:${ctx.ip}`, 10, 10 * 60_000);
    const s = playerSession(ctx, false);
    if (!s) throw new HttpError(400, 'not_linked', 'Аккаунт не привязан');
    ctx.ok(startUnlink(s));
  });

  router.get('/api/shop/options', (ctx) => {
    const p = q.get('SELECT price_kop, active FROM products WHERE id = ?', Number(ctx.query.product));
    if (!p || !p.active) throw new HttpError(404, 'not_found', 'Товар не найден');
    ctx.ok({ options: paymentOptions(p.price_kop) });
  });

  router.post('/api/checkout', async (ctx) => {
    rateLimit(`checkout:${ctx.ip}`, 20, 10 * 60_000);
    const b = await ctx.json();
    const session = playerSession(ctx, false);
    const product = q.get('SELECT * FROM products WHERE id = ?', Number(b.productId));
    const order = createOrder({ session, product, providerId: String(b.provider), currency: String(b.currency) });
    const url = order.provider === 'test' ? `/pay/test/${order.id}` : `/pay/go/${order.id}`;
    ctx.ok({ orderId: order.id, url });
  });

  // ---------- вход владельца ----------
  router.get('/api/auth/me', (ctx) => { const o = getOwner(ctx); ctx.ok({ owner: o ? { email: o.email } : null }); });
  router.post('/api/auth/owner/request', async (ctx) => {
    const b = await ctx.json();
    try { await requestOwnerCode(b.email, ctx.ip); } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, 'mail_failed', 'Не удалось отправить письмо. Проверьте настройки почты сервера.');
    }
    ctx.ok({ message: 'Если адрес входит в число владельцев, на него отправлен код.' });
  });
  router.post('/api/auth/owner/verify', async (ctx) => {
    const b = await ctx.json();
    const s = verifyOwnerCode(ctx, b.email, b.code);
    ctx.ok({ email: s.email });
  });
  router.post('/api/auth/logout', (ctx) => { destroySession(ctx, 'owner'); ctx.ok(); });

  // Мини-страница входа (если JS-окно недоступно)
  router.get('/admin/login', (ctx) => ctx.redirect('/?login=1'));
}

export { md, getSetting, safeUrl, MC_NAME_RE };

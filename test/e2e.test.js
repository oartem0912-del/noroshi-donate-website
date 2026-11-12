import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'noroshi-test-'));
process.env.NODE_ENV = 'test';
process.env.TEST_PAYMENTS = 'true';
process.env.LIQPAY_PUBLIC_KEY = 'i00000000';
process.env.LIQPAY_PRIVATE_KEY = 'private_test_key';
process.env.LIQPAY_SANDBOX = 'true';
process.env.PLUGIN_SECRET = 'x'.repeat(40);

const { init, buildApp } = await import('../src/server.js');
const { closeDb, q } = await import('../src/db.js');
const { outbox } = await import('../src/mail.js');
const { sign } = await import('../src/routes/plugin.js');
const { processPaymentEvent } = await import('../src/payments/core.js');
const { liqpay } = await import('../src/payments/liqpay.js');
const { verifyBackup, makeBackup } = await import('../src/backup.js');
const { sha256, hmacHex, startOfPeriod } = await import('../src/util.js');
const { md } = await import('../src/render.js');

let server; let base; const SECRET = process.env.PLUGIN_SECRET;

before(async () => {
  init(); server = buildApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); closeDb(); });

class Client {
  constructor() { this.jar = {}; }
  async req(method, url, body, headers = {}) {
    const cookie = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + url, { method, redirect: 'manual', headers: { Origin: base, ...(cookie ? { cookie } : {}), ...(body && !(body instanceof Buffer) && !(typeof body === 'string') ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : (body instanceof Buffer || typeof body === 'string') ? body : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); const v = kv.slice(i + 1); if (/Max-Age=0/.test(c)) delete this.jar[kv.slice(0, i)]; else this.jar[kv.slice(0, i)] = v; }
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text, headers: res.headers };
  }
}

// подписанный клиент плагина
let nonceN = 0;
async function plugin(method, url, bodyObj, { tamper = false, nonce } = {}) {
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const ts = String(Math.floor(Date.now() / 1000)); nonce = nonce || `n${Date.now()}${nonceN++}abcdef`;
  const sig = sign(SECRET, { ts, nonce, method, path: url, body });
  const res = await fetch(base + url, { method, body: body || undefined, headers: { 'Content-Type': 'application/json', 'X-Noroshi-Server': 't', 'X-Noroshi-Timestamp': ts, 'X-Noroshi-Nonce': nonce, 'X-Noroshi-Signature': tamper ? sig.replace(/.$/, 'x') : sig } });
  const text = await res.text();
  const rsig = res.headers.get('x-noroshi-response-signature');
  if (res.status === 200 && rsig) assert.equal(rsig, hmacHex(SECRET, `${nonce}\n${res.headers.get('x-noroshi-response-timestamp')}\n${sha256(text)}`), 'подпись ответа');
  return { status: res.status, json: JSON.parse(text) };
}

const owner = new Client(); const player = new Client(); let productId;
const UUID = '069a79f4-44e9-4726-a5be-fca90e38aaf5';

test('вход владельца по коду на почту; чужой адрес не получает письма', async () => {
  outbox.length = 0;
  await owner.req('POST', '/api/auth/owner/request', { email: 'stranger@example.com' });
  assert.equal(outbox.length, 0);
  assert.equal((await owner.req('GET', '/api/admin/bootstrap')).status, 401);
  assert.equal((await owner.req('POST', '/api/auth/owner/request', { email: 'amongtem151@gmail.com' })).status, 200);
  const code = /: (\d{6})/.exec(outbox.at(-1).text)[1];
  assert.equal((await owner.req('POST', '/api/auth/owner/verify', { email: 'amongtem151@gmail.com', code: '000000' })).status, 400);
  assert.equal((await owner.req('POST', '/api/auth/owner/verify', { email: 'amongtem151@gmail.com', code })).status, 200);
  const b = await owner.req('GET', '/api/admin/bootstrap');
  assert.equal(b.status, 200);
  assert.deepEqual(b.json.owners.map((o) => o.email).sort(), ['amongtem151@gmail.com', 'oartem0912@gmail.com']);
});

test('CSRF: запрос с чужого Origin отклоняется', async () => {
  const r = await owner.req('POST', '/api/admin/categories', { name: 'x' }, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('владелец создаёт категорию, товар, страницу и публикует', async () => {
  const c = await owner.req('POST', '/api/admin/categories', { name: 'Привилегии' });
  assert.equal(c.json.categories.length, 1);
  const p = await owner.req('POST', '/api/admin/products', { name: 'VIP', shortDescription: 'Крутой статус', description: 'Описание **VIP**', priceUah: 99.5, categoryId: c.json.categories[0].id, delivery: { commands: ['lp user %player% parent add vip', 'say Спасибо %player%!'], requireOnline: false } });
  assert.equal(p.status, 200); productId = p.json.product.id;
  const pg = await owner.req('POST', '/api/admin/pages', { title: 'Правила сервера' });
  const id = pg.json.page.id; const slug = pg.json.page.slug;
  await owner.req('PUT', `/api/admin/pages/${id}/draft`, { blocks: [{ type: 'text', title: 'Правила', body: '- Не грифить\n- <script>alert(1)</script>' }] });
  assert.equal((await new Client().req('GET', `/p/${slug}`)).status, 404);
  await owner.req('PUT', `/api/admin/pages/${id}`, { title: 'Правила сервера', showInNav: true });
  await owner.req('POST', `/api/admin/pages/${id}/publish`);
  const pub = await new Client().req('GET', `/p/${slug}`);
  assert.equal(pub.status, 200);
  assert.ok(!pub.text.includes('<script>alert'), 'XSS экранирован');
  assert.ok(pub.text.includes('Правила сервера'));
  const home = await new Client().req('GET', '/');
  assert.ok(home.text.includes('VIP') && home.text.includes('99,50'));
  assert.ok((await new Client().req('GET', '/shop/vip')).text.includes('Купить'));
});

test('покупка без привязки невозможна; привязка только через код в игре', async () => {
  const r = await player.req('POST', '/api/checkout', { productId, provider: 'test', currency: 'UAH' });
  assert.equal(r.json.error, 'not_linked');
  const s = await player.req('POST', '/api/link/start', { nickname: 'Steve_1' });
  assert.equal(s.status, 200); const code = s.json.code;
  assert.equal((await player.req('GET', '/api/link/status')).json.linked, false);
  // другой ник пытается подтвердить код
  const bad = await plugin('POST', '/api/plugin/link/confirm', { code, uuid: UUID, name: 'Alex' });
  assert.equal(bad.json.ok, false); assert.equal(bad.json.error, 'wrong_nick');
  const ok = await plugin('POST', '/api/plugin/link/confirm', { code, uuid: UUID, name: 'Steve_1' });
  assert.equal(ok.json.ok, true);
  assert.equal((await plugin('POST', '/api/plugin/link/confirm', { code, uuid: UUID, name: 'Steve_1' })).json.ok, false, 'код одноразовый');
  const st = await player.req('GET', '/api/link/status');
  assert.equal(st.json.linked, true); assert.equal(st.json.nickname, 'Steve_1');
});

test('API плагина: подписи, повтор, подмена', async () => {
  assert.equal((await plugin('GET', '/api/plugin/orders', null, { tamper: true })).status, 401);
  const n = 'fixednonce123456';
  assert.equal((await plugin('POST', '/api/plugin/heartbeat', { server: { version: '1.21' }, online: 3, max: 50, players: ['a'] }, { nonce: n })).status, 200);
  assert.equal((await plugin('POST', '/api/plugin/heartbeat', { server: {}, online: 3 }, { nonce: n })).status, 401, 'replay');
  const bad = await fetch(base + '/api/plugin/orders'); assert.equal(bad.status, 401);
  assert.ok((await new Client().req('GET', '/')).text.includes('3 / 50'));
});

let orderId;
test('тестовая оплата -> заказ оплачен -> выдача ровно один раз', async () => {
  const opts = await player.req('GET', `/api/shop/options?product=${productId}`);
  assert.ok(opts.json.options.find((o) => o.id === 'test'));
  const co = await player.req('POST', '/api/checkout', { productId, provider: 'test', currency: 'UAH' });
  assert.equal(co.status, 200); orderId = co.json.orderId;
  assert.equal((await plugin('GET', '/api/plugin/orders')).json.orders.length, 0, 'неоплаченное не выдаётся');
  assert.equal((await new Client().req('POST', `/api/test-pay/${orderId}`, { result: 'paid' })).status, 404, 'чужая сессия');
  assert.equal((await player.req('POST', `/api/test-pay/${orderId}`, { result: 'paid' })).status, 200);
  await player.req('POST', `/api/test-pay/${orderId}`, { result: 'paid' }); // повтор
  const got = await plugin('GET', '/api/plugin/orders');
  assert.equal(got.json.orders.length, 1);
  const o = got.json.orders[0];
  assert.equal(o.player.name, 'Steve_1'); assert.equal(o.commands[0], 'lp user %player% parent add vip'); assert.equal(o.requireOnline, false);
  assert.equal((await plugin('GET', '/api/plugin/orders')).json.orders.length, 0, 'аренда: второй запрос ничего не получает');
  assert.equal((await plugin('POST', `/api/plugin/orders/${orderId}/result`, { attempt: o.attempt, status: 'delivered', message: 'ok' })).status, 200);
  assert.equal((await plugin('POST', `/api/plugin/orders/${orderId}/result`, { attempt: o.attempt, status: 'delivered' })).json.duplicate, true);
  assert.equal((await plugin('GET', '/api/plugin/orders')).json.orders.length, 0);
  const row = q.get('SELECT * FROM orders WHERE id = ?', orderId);
  assert.equal(row.status, 'paid'); assert.equal(row.delivery_status, 'delivered'); assert.ok(row.fee_kop > 0); assert.equal(row.net_kop, row.price_kop - row.fee_kop);
  assert.equal((await player.req('GET', `/api/orders/${orderId}`)).json.delivery, 'delivered');
});

test('аренда истекает — заказ возвращается в очередь (сервер был недоступен)', async () => {
  const co = await player.req('POST', '/api/checkout', { productId, provider: 'test', currency: 'UAH' });
  await player.req('POST', `/api/test-pay/${co.json.orderId}`, { result: 'paid' });
  assert.equal((await plugin('GET', '/api/plugin/orders')).json.orders.length, 1);
  q.run('UPDATE orders SET delivery_lease_until = 1 WHERE id = ?', co.json.orderId);
  const again = await plugin('GET', '/api/plugin/orders');
  assert.equal(again.json.orders.length, 1); assert.equal(again.json.orders[0].id, co.json.orderId);
  await plugin('POST', `/api/plugin/orders/${co.json.orderId}/result`, { attempt: 1, status: 'failed', message: 'нет места' });
  assert.equal((await owner.req('POST', `/api/admin/orders/${co.json.orderId}/retry`)).status, 200);
  const retry = await plugin('GET', '/api/plugin/orders');
  assert.equal(retry.json.orders[0].attempt, 2);
  await plugin('POST', `/api/plugin/orders/${co.json.orderId}/result`, { attempt: 1, status: 'delivered' }); // устаревшая попытка игнорируется
  assert.equal(q.get('SELECT delivery_status s FROM orders WHERE id = ?', co.json.orderId).s, 'delivering');
});

test('LiqPay: подпись, сумма, идемпотентность, возврат', async () => {
  const co = await player.req('POST', '/api/checkout', { productId, provider: 'liqpay', currency: 'UAH' });
  assert.equal(co.status, 200); assert.ok(co.json.url.startsWith('/pay/go/'));
  const page = await player.req('GET', co.json.url);
  assert.ok(page.text.includes('liqpay.ua/api/3/checkout') && page.text.includes('name="signature"'));
  const o = q.get('SELECT * FROM orders WHERE id = ?', co.json.orderId);
  const mk = (extra = {}) => { const data = Buffer.from(JSON.stringify({ order_id: o.id, status: 'sandbox', amount: 99.5, currency: 'UAH', payment_id: 777, receiver_commission: 1.5, paytype: 'card', ...extra })).toString('base64'); return new URLSearchParams({ data, signature: liqpay._sign(data) }).toString(); };
  const post = (body) => fetch(base + '/api/webhooks/liqpay', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  assert.equal((await post(mk().replace(/signature=.{3}/, 'signature=AAA'))).status, 400, 'поддельная подпись');
  assert.equal(q.get('SELECT status s FROM orders WHERE id = ?', o.id).s, 'pending');
  await post(mk({ amount: 1 })); // сумма не совпала
  assert.equal(q.get('SELECT status s FROM orders WHERE id = ?', o.id).s, 'pending', 'заниженная сумма не принимается');
  assert.equal((await post(mk())).status, 200); assert.equal((await post(mk())).status, 200);
  const paid = q.get('SELECT * FROM orders WHERE id = ?', o.id);
  assert.equal(paid.status, 'paid'); assert.equal(paid.fee_kop, 150); assert.equal(paid.delivery_status, 'queued');
  assert.equal(q.get('SELECT COUNT(*) n FROM payment_events WHERE order_id = ?', o.id).n, 1 + 0, 'события не дублируются (отклонённые тоже учтены)');
  await post(mk({ status: 'reversed' }));
  assert.equal(q.get('SELECT status s FROM orders WHERE id = ?', o.id).s, 'refunded');
});

test('доходы: тестовые заказы исключены по умолчанию', async () => {
  const a = (await owner.req('GET', '/api/admin/stats')).json.stats;
  const b = (await owner.req('GET', '/api/admin/stats?test=1')).json.stats;
  assert.equal(a.periods.all.orders, 0); assert.ok(b.periods.all.orders >= 2);
  assert.equal(b.chart.length, 30);
  const list = await owner.req('GET', '/api/admin/orders');
  assert.ok(list.json.total >= 3);
});

test('отвязка требует подтверждения В ИГРЕ владельцем аккаунта', async () => {
  const u = await player.req('POST', '/api/link/unlink'); assert.equal(u.status, 200);
  const other = await plugin('POST', '/api/plugin/link/confirm', { code: u.json.code, uuid: '11111111-1111-1111-1111-111111111111', name: 'Steve_1' });
  assert.equal(other.json.error, 'wrong_owner');
  assert.equal((await plugin('POST', '/api/plugin/link/confirm', { code: u.json.code, uuid: UUID, name: 'Steve_1' })).json.ok, true);
  assert.equal((await player.req('GET', '/api/link/status')).json.linked, false);
});

test('критичные действия: замена владельца требует код на второй адрес', async () => {
  outbox.length = 0;
  const r = await owner.req('POST', '/api/admin/owners/replace', { role: 'secondary', email: 'new@example.com' });
  assert.equal(r.json.needConfirm, true);
  assert.equal(outbox.at(-1).to, 'oartem0912@gmail.com'); // запрашивал secondary -> код primary
  assert.equal((await owner.req('POST', '/api/admin/confirm', { id: r.json.id, code: '123456' })).status, 400);
  const code = /Код подтверждения: (\d{6})/.exec(outbox.at(-1).text)[1];
  assert.equal((await owner.req('POST', '/api/admin/confirm', { id: r.json.id, code })).status, 200);
  assert.equal(q.get("SELECT email FROM owners WHERE role='secondary'").email, 'new@example.com');
  assert.equal((await owner.req('GET', '/api/admin/bootstrap')).status, 401, 'сессии старого адреса закрыты');
});

test('резервная копия проходит проверку восстановления', () => {
  const f = makeBackup(); const v = verifyBackup(f);
  assert.equal(v.ok, true); assert.ok(v.orders >= 3);
});

test('утилиты: markdown не пропускает javascript: и разметку; границы периодов', () => {
  assert.ok(!md('[x](javascript:alert(1))').includes('href'));
  assert.ok(md('<b>x</b>').includes('&lt;b&gt;'));
  assert.ok(md('[ok](https://a.b/?x=1&y=2)').includes('href="https://a.b/?x=1&amp;y=2"'));
  const s = startOfPeriod('day', 'Europe/Kyiv', new Date('2026-11-08T22:30:00Z')); // уже 9 ноября по Киеву (UTC+2)
  assert.equal(new Date(s).toISOString(), '2026-11-08T22:00:00.000Z');
});

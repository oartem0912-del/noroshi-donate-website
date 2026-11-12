// Панель владельца: JSON API. Все маршруты требуют сессию владельца (вход по коду на почту).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { q, tx, log, allSettings, setSetting, DEFAULT_SETTINGS, raw } from '../db.js';
import { config } from '../config.js';
import { now, slugify, safeJson, safeUrl, HttpError, strToMinor } from '../util.js';
import { requireOwner, getOwner, listOwners, requestConfirmation, confirmAction, onConfirmed, isOwnerEmail } from '../auth.js';
import { BLOCK_SCHEMA, defaultBlock, renderBlocks, pageContext, listCategories } from '../render.js';
import { incomeSummary, listOrders } from '../stats.js';
import { refreshRates, listRates } from '../rates.js';
import { providers } from '../payments/index.js';
import { makeBackup, backupDir } from '../backup.js';

const UPLOAD_TYPES = [
  { ext: 'png', mime: 'image/png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', mime: 'image/gif', test: (b) => b.subarray(0, 4).toString() === 'GIF8' },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
]; // SVG намеренно запрещён: он может содержать скрипты

export const uploadsDir = () => path.join(config.dataDir, 'uploads');

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const bool = (v) => (v ? 1 : 0);

function cleanBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length > 60) throw new HttpError(400, 'bad_blocks', 'Некорректный список блоков');
  return blocks.map((b) => {
    const schema = BLOCK_SCHEMA[b?.type];
    if (!schema) throw new HttpError(400, 'bad_block', `Неизвестный тип блока: ${b?.type}`);
    const out = { type: b.type };
    for (const f of schema.fields) {
      if (f.t === 'items') {
        out[f.k] = (Array.isArray(b[f.k]) ? b[f.k] : []).slice(0, 30).map((it) => Object.fromEntries(f.sub.map((s) => [s.k, str(it?.[s.k], 2000)])));
      } else out[f.k] = str(b[f.k], f.t === 'textarea' ? 8000 : 500);
    }
    return out;
  });
}

function cleanDelivery(d) {
  const commands = (Array.isArray(d?.commands) ? d.commands : String(d?.commands || '').split('\n'))
    .map((c) => String(c).trim().replace(/^\//, '')).filter(Boolean).slice(0, 30);
  for (const c of commands) if (c.length > 300 || /[\r\n]/.test(c)) throw new HttpError(400, 'bad_command', 'Команда слишком длинная');
  return { commands, requireOnline: d?.requireOnline !== false };
}

function productRow(b, existing) {
  const name = str(b.name, 100);
  if (!name) throw new HttpError(400, 'bad_name', 'Укажите название');
  const kop = Math.round(Number(b.priceUah) * 100);
  if (!(kop > 0) || kop > 100_000_000) throw new HttpError(400, 'bad_price', 'Некорректная цена (₴)');
  return {
    name, kop, short: str(b.shortDescription, 300), description: str(b.description, 10000), image: safeUrl(b.image),
    category: b.categoryId ? Number(b.categoryId) : null, active: bool(b.active !== false),
    delivery: JSON.stringify(cleanDelivery(b.delivery)), slug: existing?.slug,
  };
}
function uniqueSlug(table, base, selfId = null) {
  let slug = slugify(base) || 'item'; let n = 1;
  while (q.get(`SELECT id FROM ${table} WHERE slug = ? AND id != ?`, slug, selfId ?? -1)) slug = `${slugify(base) || 'item'}-${++n}`;
  return slug;
}

const productOut = (p) => ({ id: p.id, slug: p.slug, name: p.name, shortDescription: p.short_description, description: p.description, image: p.image, priceUah: p.price_kop / 100, categoryId: p.category_id, active: !!p.active, sort: p.sort, delivery: safeJson(p.delivery, { commands: [], requireOnline: true }) });
const pageOut = (p) => ({ id: p.id, slug: p.slug, title: p.title, published: !!p.published, showInNav: !!p.show_in_nav, navOrder: p.nav_order, blocks: safeJson(p.blocks, []), draftBlocks: p.draft_blocks ? safeJson(p.draft_blocks, []) : null, hasDraft: p.draft_blocks !== null && p.draft_blocks !== p.blocks, updatedAt: p.updated_at });

// ---- критичные действия (код подтверждения уходит на второй адрес владельца) ----
onConfirmed('owners.replace', ({ role, email }) => {
  const other = q.get('SELECT email FROM owners WHERE role != ?', role);
  if (other?.email === email) throw new HttpError(400, 'dup', 'Этот адрес уже владелец');
  const old = q.get('SELECT email FROM owners WHERE role = ?', role);
  q.run('UPDATE owners SET email = ?, added_at = ?, verified_at = NULL WHERE role = ?', email, now(), role);
  if (old) q.run("DELETE FROM sessions WHERE kind='owner' AND email = ?", old.email);
  return { replaced: role };
});
onConfirmed('owners.swap', () => {
  tx(() => {
    const rows = q.all('SELECT email, role FROM owners');
    if (rows.length !== 2) throw new HttpError(400, 'bad_state', 'Нужны два владельца');
    // меняем роли местами (UNIQUE по email не мешает, роли не уникальны индексом)
    for (const r of rows) q.run('UPDATE owners SET role = ? WHERE email = ?', r.role === 'primary' ? 'secondary' : 'primary', r.email);
  });
  return { swapped: true };
});
onConfirmed('settings.payments', ({ currencies, providers: pv }) => {
  setSetting('currencies', currencies); setSetting('providers', pv); return { saved: true };
});

export function mountAdmin(router) {
  const A = (fn) => async (ctx) => { ctx.owner = requireOwner(ctx); await fn(ctx); };

  // Оболочка панели
  router.get('/admin', (ctx) => {
    if (!getOwner(ctx)) return ctx.redirect('/?login=1');
    ctx.html(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Панель владельца — Noroshi</title>
<link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/css/site.css"><link rel="stylesheet" href="/css/admin.css"></head>
<body class="admin"><div id="app"><div class="boot">Загрузка…</div></div><div id="toast" class="toast" role="status"></div><script src="/js/admin.js" defer></script></body></html>`);
  });

  router.get('/api/admin/bootstrap', A((ctx) => {
    const status = q.get('SELECT * FROM servers ORDER BY last_seen DESC LIMIT 1');
    ctx.ok({
      me: { email: ctx.owner.email }, settings: allSettings(), schema: BLOCK_SCHEMA, owners: listOwners(), categories: listCategories(),
      providers: Object.values(providers).map((p) => ({ id: p.id, title: p.title, configured: p.isConfigured(), currencies: p.currencies, test: !!p.test })),
      server: status ? { name: status.name, version: status.version, online: status.online, max: status.max_players, lastSeen: status.last_seen } : null,
      urls: { liqpayWebhook: `${config.baseUrl}/api/webhooks/liqpay`, base: config.baseUrl },
      rates: listRates(), testPayments: config.payments.testEnabled, liqpaySandbox: config.payments.liqpay.sandbox, timezone: config.timezone,
    });
  }));

  // ---------- настройки ----------
  router.put('/api/admin/settings', A(async (ctx) => {
    const b = await ctx.json();
    const s = {
      siteName: str(b.siteName, 60) || DEFAULT_SETTINGS.siteName, tagline: str(b.tagline, 160), serverAddress: str(b.serverAddress, 100),
      banner: safeUrl(b.banner), logo: safeUrl(b.logo), discord: safeUrl(b.discord), footerText: str(b.footerText, 300),
      accent: /^#[0-9a-fA-F]{6}$/.test(b.accent) ? b.accent : DEFAULT_SETTINGS.accent,
      nav: (Array.isArray(b.nav) ? b.nav : []).slice(0, 12).map((n) => ({ title: str(n.title, 40), url: safeUrl(n.url) })).filter((n) => n.title && n.url),
    };
    const rates = {};
    for (const cur of ['USD', 'EUR']) { const v = Number(b.manualRates?.[cur]); if (v > 0 && v < 1000) rates[cur] = v; }
    s.manualRates = rates;
    for (const [k, v] of Object.entries(s)) setSetting(k, v);
    log('info', 'admin', 'Настройки сайта обновлены', { by: ctx.owner.email });
    ctx.ok();
  }));

  router.put('/api/admin/settings/payments', A(async (ctx) => {
    const b = await ctx.json();
    const currencies = (Array.isArray(b.currencies) ? b.currencies : []).filter((c) => ['UAH', 'EUR', 'USD'].includes(c));
    if (!currencies.includes('UAH')) currencies.unshift('UAH');
    const pv = {}; for (const id of Object.keys(providers)) pv[id] = b.providers?.[id] !== false;
    const r = await requestConfirmation('settings.payments', { currencies, providers: pv }, ctx.owner.email,
      `Изменение платёжных настроек сайта.\nВалюты: ${currencies.join(', ')}\nПровайдеры: ${Object.entries(pv).map(([k, v]) => `${k}=${v ? 'вкл' : 'выкл'}`).join(', ')}`);
    ctx.ok({ needConfirm: true, ...r });
  }));

  router.post('/api/admin/rates/refresh', A(async (ctx) => { await refreshRates(); ctx.ok({ rates: listRates() }); }));

  // ---------- владельцы ----------
  router.post('/api/admin/owners/replace', A(async (ctx) => {
    const b = await ctx.json();
    const email = str(b.email, 120).toLowerCase();
    if (!['primary', 'secondary'].includes(b.role) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'bad_input', 'Укажите роль и корректный email');
    const r = await requestConfirmation('owners.replace', { role: b.role, email }, ctx.owner.email, `Замена адреса владельца (${b.role}) на ${email}.\nНовый адрес получит доступ только после входа по коду из письма.`);
    ctx.ok({ needConfirm: true, ...r });
  }));
  router.post('/api/admin/owners/swap', A(async (ctx) => {
    const r = await requestConfirmation('owners.swap', {}, ctx.owner.email, 'Передача основной роли владельца второму адресу (роли меняются местами).');
    ctx.ok({ needConfirm: true, ...r });
  }));
  router.post('/api/admin/confirm', A(async (ctx) => {
    const b = await ctx.json();
    ctx.ok({ result: confirmAction(b.id, b.code, ctx.owner.email) });
  }));

  // ---------- категории ----------
  router.get('/api/admin/categories', A((ctx) => ctx.ok({ categories: listCategories() })));
  router.post('/api/admin/categories', A(async (ctx) => {
    const b = await ctx.json(); const name = str(b.name, 60);
    if (!name) throw new HttpError(400, 'bad_name', 'Укажите название');
    const max = q.get('SELECT COALESCE(MAX(sort),0) m FROM categories').m;
    q.run('INSERT INTO categories(slug, name, sort) VALUES(?,?,?)', uniqueSlug('categories', name), name, max + 1);
    ctx.ok({ categories: listCategories() });
  }));
  router.put('/api/admin/categories/:id', A(async (ctx) => {
    const b = await ctx.json(); const name = str(b.name, 60);
    if (!name) throw new HttpError(400, 'bad_name', 'Укажите название');
    q.run('UPDATE categories SET name = ? WHERE id = ?', name, Number(ctx.params.id));
    ctx.ok({ categories: listCategories() });
  }));
  router.del('/api/admin/categories/:id', A((ctx) => { q.run('DELETE FROM categories WHERE id = ?', Number(ctx.params.id)); ctx.ok({ categories: listCategories() }); }));
  router.post('/api/admin/categories/reorder', A(async (ctx) => {
    const b = await ctx.json();
    tx(() => (b.ids || []).forEach((id, i) => q.run('UPDATE categories SET sort = ? WHERE id = ?', i, Number(id))));
    ctx.ok({ categories: listCategories() });
  }));

  // ---------- товары ----------
  router.get('/api/admin/products', A((ctx) => ctx.ok({ products: q.all('SELECT * FROM products ORDER BY sort, id').map(productOut) })));
  router.post('/api/admin/products', A(async (ctx) => {
    const r = productRow(await ctx.json());
    const b = await ctx.json();
    const slug = uniqueSlug('products', b.slug || r.name);
    const max = q.get('SELECT COALESCE(MAX(sort),0) m FROM products').m;
    const res = q.run(`INSERT INTO products(slug, category_id, name, short_description, description, image, price_kop, active, sort, delivery, created_at, updated_at)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, slug, r.category, r.name, r.short, r.description, r.image, r.kop, r.active, max + 1, r.delivery, now(), now());
    log('info', 'admin', `Создан товар ${r.name}`, { by: ctx.owner.email });
    ctx.ok({ product: productOut(q.get('SELECT * FROM products WHERE id = ?', Number(res.lastInsertRowid))) });
  }));
  router.put('/api/admin/products/:id', A(async (ctx) => {
    const id = Number(ctx.params.id); const cur = q.get('SELECT * FROM products WHERE id = ?', id);
    if (!cur) throw new HttpError(404, 'not_found', 'Товар не найден');
    const b = await ctx.json(); const r = productRow(b, cur);
    q.run(`UPDATE products SET category_id=?, name=?, short_description=?, description=?, image=?, price_kop=?, active=?, delivery=?, updated_at=? WHERE id=?`,
      r.category, r.name, r.short, r.description, r.image, r.kop, r.active, r.delivery, now(), id);
    log('info', 'admin', `Изменён товар ${r.name}`, { by: ctx.owner.email });
    ctx.ok({ product: productOut(q.get('SELECT * FROM products WHERE id = ?', id)) });
  }));
  router.del('/api/admin/products/:id', A((ctx) => {
    // заказы хранят снимок названия/цены, поэтому товар можно удалить без потери истории
    q.run('DELETE FROM products WHERE id = ?', Number(ctx.params.id)); ctx.ok();
  }));
  router.post('/api/admin/products/reorder', A(async (ctx) => {
    const b = await ctx.json();
    tx(() => (b.ids || []).forEach((id, i) => q.run('UPDATE products SET sort = ? WHERE id = ?', i, Number(id))));
    ctx.ok();
  }));

  // ---------- страницы ----------
  router.get('/api/admin/pages', A((ctx) => ctx.ok({ pages: q.all('SELECT * FROM pages ORDER BY CASE WHEN slug = \'\' THEN 0 ELSE 1 END, nav_order, id').map(pageOut) })));
  router.post('/api/admin/pages', A(async (ctx) => {
    const b = await ctx.json(); const title = str(b.title, 80);
    if (!title) throw new HttpError(400, 'bad_title', 'Укажите название');
    const slug = uniqueSlug('pages', b.slug || title);
    const max = q.get('SELECT COALESCE(MAX(nav_order),0) m FROM pages').m;
    const blocks = JSON.stringify([defaultBlock('text')]);
    const res = q.run('INSERT INTO pages(slug, title, blocks, draft_blocks, published, show_in_nav, nav_order, updated_at) VALUES(?,?,?,?,0,0,?,?)', slug, title, blocks, blocks, max + 1, now());
    ctx.ok({ page: pageOut(q.get('SELECT * FROM pages WHERE id = ?', Number(res.lastInsertRowid))) });
  }));
  router.put('/api/admin/pages/:id', A(async (ctx) => {
    const id = Number(ctx.params.id); const cur = q.get('SELECT * FROM pages WHERE id = ?', id);
    if (!cur) throw new HttpError(404, 'not_found', 'Страница не найдена');
    const b = await ctx.json();
    const title = str(b.title, 80) || cur.title;
    const slug = cur.slug === '' ? '' : uniqueSlug('pages', b.slug || cur.slug, id);
    q.run('UPDATE pages SET title=?, slug=?, show_in_nav=?, updated_at=? WHERE id=?', title, slug, cur.slug === '' ? 0 : bool(b.showInNav), now(), id);
    ctx.ok({ page: pageOut(q.get('SELECT * FROM pages WHERE id = ?', id)) });
  }));
  router.put('/api/admin/pages/:id/draft', A(async (ctx) => {
    const id = Number(ctx.params.id); const b = await ctx.json();
    const blocks = cleanBlocks(b.blocks);
    q.run('UPDATE pages SET draft_blocks = ?, updated_at = ? WHERE id = ?', JSON.stringify(blocks), now(), id);
    ctx.ok({ page: pageOut(q.get('SELECT * FROM pages WHERE id = ?', id)) });
  }));
  router.post('/api/admin/pages/:id/publish', A(async (ctx) => {
    const id = Number(ctx.params.id); const cur = q.get('SELECT * FROM pages WHERE id = ?', id);
    if (!cur) throw new HttpError(404, 'not_found', 'Страница не найдена');
    q.run('UPDATE pages SET blocks = COALESCE(draft_blocks, blocks), draft_blocks = COALESCE(draft_blocks, blocks), published = 1, updated_at = ? WHERE id = ?', now(), id);
    log('info', 'admin', `Опубликована страница /${cur.slug}`, { by: ctx.owner.email });
    ctx.ok({ page: pageOut(q.get('SELECT * FROM pages WHERE id = ?', id)) });
  }));
  router.post('/api/admin/pages/:id/unpublish', A((ctx) => {
    const id = Number(ctx.params.id); const cur = q.get('SELECT * FROM pages WHERE id = ?', id);
    if (!cur) throw new HttpError(404, 'not_found', 'Страница не найдена');
    if (cur.slug === '') throw new HttpError(400, 'home', 'Главную страницу нельзя снять с публикации');
    q.run('UPDATE pages SET published = 0, updated_at = ? WHERE id = ?', now(), id);
    ctx.ok({ page: pageOut(q.get('SELECT * FROM pages WHERE id = ?', id)) });
  }));
  router.del('/api/admin/pages/:id', A((ctx) => {
    const cur = q.get('SELECT slug FROM pages WHERE id = ?', Number(ctx.params.id));
    if (cur?.slug === '') throw new HttpError(400, 'home', 'Главную страницу нельзя удалить');
    q.run('DELETE FROM pages WHERE id = ?', Number(ctx.params.id)); ctx.ok();
  }));
  router.post('/api/admin/pages/reorder', A(async (ctx) => {
    const b = await ctx.json();
    tx(() => (b.ids || []).forEach((id, i) => q.run('UPDATE pages SET nav_order = ? WHERE id = ?', i, Number(id))));
    ctx.ok();
  }));
  // Предпросмотр: сервер рендерит черновик теми же функциями, что и публичный сайт
  router.post('/api/admin/preview', A(async (ctx) => {
    const b = await ctx.json();
    ctx.session = null;
    ctx.ok({ html: renderBlocks(cleanBlocks(b.blocks), pageContext(ctx)) });
  }));

  // ---------- загрузка изображений ----------
  router.post('/api/admin/upload', A(async (ctx) => {
    const buf = await ctx.raw(5 * 1024 * 1024);
    const t = UPLOAD_TYPES.find((x) => x.test(buf));
    if (!t) throw new HttpError(400, 'bad_image', 'Допустимы PNG, JPG, GIF и WebP до 5 МБ');
    fs.mkdirSync(uploadsDir(), { recursive: true });
    const name = `${crypto.randomBytes(10).toString('hex')}.${t.ext}`;
    fs.writeFileSync(path.join(uploadsDir(), name), buf);
    ctx.ok({ url: `/uploads/${name}` });
  }));

  // ---------- заказы, доходы, журнал ----------
  router.get('/api/admin/orders', A((ctx) => {
    ctx.ok(listOrders({ status: ctx.query.status || undefined, search: str(ctx.query.search, 50) || undefined, offset: Number(ctx.query.offset) || 0, limit: Number(ctx.query.limit) || 50 }));
  }));
  router.get('/api/admin/orders/:id', A((ctx) => {
    const o = q.get('SELECT * FROM orders WHERE id = ?', ctx.params.id);
    if (!o) throw new HttpError(404, 'not_found', 'Заказ не найден');
    const events = q.all('SELECT provider, event_id, kind, created_at FROM payment_events WHERE order_id = ? ORDER BY id', o.id);
    const logs = q.all("SELECT level, source, message, created_at FROM logs WHERE ctx LIKE ? ORDER BY id DESC LIMIT 30", `%${o.id}%`);
    ctx.ok({ order: { ...o, delivery_commands: safeJson(o.delivery_commands, []) }, events, logs });
  }));
  router.post('/api/admin/orders/:id/retry', A((ctx) => {
    const o = q.get('SELECT * FROM orders WHERE id = ?', ctx.params.id);
    if (!o || o.status !== 'paid') throw new HttpError(400, 'bad_state', 'Повторить можно только оплаченный заказ');
    if (o.delivery_status === 'delivered') throw new HttpError(400, 'delivered', 'Заказ уже выдан');
    // новая «попытка»: плагин ведёт учёт по связке заказ+попытка, поэтому дубль в рамках одной попытки невозможен
    q.run("UPDATE orders SET delivery_status='queued', delivery_attempt = delivery_attempt + 1, delivery_lease_until=NULL, delivery_message=NULL, updated_at=? WHERE id=?", now(), o.id);
    log('warn', 'admin', `Повтор выдачи заказа ${o.id}`, { by: ctx.owner.email });
    ctx.ok();
  }));
  router.get('/api/admin/stats', A((ctx) => ctx.ok({ stats: incomeSummary({ includeTest: ctx.query.test === '1' }), timezone: config.timezone })));
  router.get('/api/admin/logs', A((ctx) => {
    const level = ['info', 'warn', 'error'].includes(ctx.query.level) ? ctx.query.level : null;
    ctx.ok({ logs: level ? q.all('SELECT * FROM logs WHERE level = ? ORDER BY id DESC LIMIT 200', level) : q.all('SELECT * FROM logs ORDER BY id DESC LIMIT 200') });
  }));

  // ---------- резервные копии ----------
  router.post('/api/admin/backup', A((ctx) => ctx.ok({ file: path.basename(makeBackup()) })));
  router.get('/api/admin/backups', A((ctx) => {
    const dir = backupDir();
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sqlite')).sort().reverse().slice(0, 30) : [];
    ctx.ok({ files: files.map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size })) });
  }));
}
export { isOwnerEmail, strToMinor, raw };

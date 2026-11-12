// Серверный рендеринг: каркас страницы, блоки визуального редактора, карточки товаров.
// Весь пользовательский текст экранируется; «разметка» — безопасный мини-markdown.
import { q, allSettings } from './db.js';
import { esc, safeUrl, safeJson, fmtMoney, now } from './util.js';

// ---------- мини-markdown ----------
export function md(src) {
  const text = esc(String(src ?? '').replace(/\r\n/g, '\n'));
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
      const url = safeUrl(u.replace(/&amp;/g, '&'));
      return url ? `<a href="${esc(url)}" rel="noopener noreferrer"${/^https?:/i.test(url) ? ' target="_blank"' : ''}>${t}</a>` : t;
    });
  const out = [];
  for (const chunk of text.split(/\n{2,}/)) {
    const lines = chunk.split('\n');
    if (lines.every((l) => /^\s*[-*] /.test(l))) { out.push('<ul>' + lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('') + '</ul>'); continue; }
    if (/^#{1,3} /.test(lines[0])) {
      const lvl = lines[0].match(/^#+/)[0].length + 2;
      out.push(`<h${lvl}>${inline(lines[0].replace(/^#+ /, ''))}</h${lvl}>`);
      if (lines.length > 1) out.push(`<p>${inline(lines.slice(1).join('<br>'))}</p>`);
      continue;
    }
    out.push(`<p>${inline(lines.join('<br>'))}</p>`);
  }
  return out.join('\n');
}

// ---------- схема блоков (используется и редактором) ----------
export const BLOCK_SCHEMA = {
  hero: { label: 'Заставка', fields: [
    { k: 'title', t: 'text', l: 'Заголовок' }, { k: 'subtitle', t: 'textarea', l: 'Подзаголовок' }, { k: 'image', t: 'image', l: 'Баннер / фон' },
    { k: 'ctaText', t: 'text', l: 'Текст кнопки' }, { k: 'ctaLink', t: 'text', l: 'Ссылка кнопки' }] },
  text: { label: 'Текст', fields: [{ k: 'title', t: 'text', l: 'Заголовок' }, { k: 'body', t: 'textarea', l: 'Текст (**жирный**, *курсив*, - списки, [ссылка](url))' }] },
  image: { label: 'Изображение', fields: [{ k: 'src', t: 'image', l: 'Изображение' }, { k: 'alt', t: 'text', l: 'Описание (alt)' }, { k: 'caption', t: 'text', l: 'Подпись' }] },
  features: { label: 'Преимущества', fields: [{ k: 'title', t: 'text', l: 'Заголовок' },
    { k: 'items', t: 'items', l: 'Пункты', sub: [{ k: 'icon', t: 'text', l: 'Иконка (эмодзи)' }, { k: 'title', t: 'text', l: 'Название' }, { k: 'text', t: 'textarea', l: 'Описание' }] }] },
  status: { label: 'Статус сервера', fields: [{ k: 'title', t: 'text', l: 'Заголовок' }] },
  link: { label: 'Привязка аккаунта', fields: [{ k: 'title', t: 'text', l: 'Заголовок' }, { k: 'text', t: 'textarea', l: 'Пояснение' }] },
  catalog: { label: 'Каталог товаров', fields: [{ k: 'title', t: 'text', l: 'Заголовок' }, { k: 'category', t: 'category', l: 'Категория (пусто — все)' }] },
  faq: { label: 'FAQ', fields: [{ k: 'title', t: 'text', l: 'Заголовок' },
    { k: 'items', t: 'items', l: 'Вопросы', sub: [{ k: 'q', t: 'text', l: 'Вопрос' }, { k: 'a', t: 'textarea', l: 'Ответ' }] }] },
  cta: { label: 'Призыв к действию', fields: [{ k: 'text', t: 'textarea', l: 'Текст' }, { k: 'button', t: 'text', l: 'Кнопка' }, { k: 'link', t: 'text', l: 'Ссылка' }] },
};
export const defaultBlock = (type) => ({
  hero: { type, title: 'Добро пожаловать на Noroshi', subtitle: 'Ванильное выживание с дружным сообществом.', image: '', ctaText: 'В магазин', ctaLink: '#shop' },
  text: { type, title: 'О сервере', body: 'Расскажите о сервере.' },
  image: { type, src: '', alt: '', caption: '' },
  features: { type, title: 'Почему Noroshi', items: [{ icon: '🌿', title: 'Ваниль', text: 'Честная игра без лишнего.' }] },
  status: { type, title: 'Сервер' }, link: { type, title: 'Привязка аккаунта', text: 'Покупки выдаются только на подтверждённый аккаунт.' },
  catalog: { type, title: 'Магазин', category: '' }, faq: { type, title: 'Вопросы и ответы', items: [{ q: 'Как получить покупку?', a: 'После оплаты она выдаётся автоматически.' }] },
  cta: { type, text: 'Присоединяйтесь к Noroshi', button: 'Играть', link: '/' },
}[type]);

export const STARTER_HOME = [
  defaultBlock('hero'), defaultBlock('status'), defaultBlock('link'), defaultBlock('catalog'),
];

// ---------- данные для рендера ----------
export function serverStatus() {
  const s = q.get('SELECT * FROM servers ORDER BY last_seen DESC LIMIT 1');
  if (!s || now() - s.last_seen > 90_000) return { online: false, players: 0, max: 0, version: s?.version || '' };
  return { online: true, players: s.online, max: s.max_players, version: s.version };
}
export const listCategories = () => q.all('SELECT * FROM categories ORDER BY sort, id');
export const listActiveProducts = () => q.all('SELECT p.*, c.slug AS category_slug FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.active = 1 ORDER BY p.sort, p.id');

export function pageContext(ctx0) {
  return { settings: allSettings(), categories: listCategories(), products: listActiveProducts(), status: serverStatus(), session: ctx0.session || null, owner: ctx0.owner || null };
}

// ---------- карточки ----------
export const priceStr = (kop) => fmtMoney(kop, 'UAH');
function productCard(p) {
  const img = p.image ? `<img src="${esc(safeUrl(p.image))}" alt="" loading="lazy">` : '<div class="ph" aria-hidden="true">✦</div>';
  return `<a class="card product reveal" href="/shop/${esc(p.slug)}" data-category="${esc(p.category_slug || '')}">
    <div class="product-img">${img}</div>
    <div class="product-body"><h3>${esc(p.name)}</h3><p>${esc(p.short_description)}</p>
    <div class="product-foot"><span class="price">${priceStr(p.price_kop)}</span><span class="more">Подробнее →</span></div></div></a>`;
}

export function linkWidget(session) {
  const linked = !!session?.mc_uuid;
  return `<div class="linkbox" data-linkbox data-state="${linked ? 'linked' : 'unlinked'}">
    <div class="lb-linked"${linked ? '' : ' hidden'}>
      <div class="lb-who"><img class="lb-head" alt="" src="${linked ? `https://mc-heads.net/avatar/${esc(session.mc_uuid)}/40` : ''}"><div><div class="muted small">Привязан аккаунт</div><strong data-lb-name>${esc(session?.mc_name || '')}</strong></div></div>
      <button class="btn ghost small" type="button" data-lb-unlink>Отвязать</button>
    </div>
    <form class="lb-form" data-lb-form${linked ? ' hidden' : ''}>
      <label class="small muted" for="nick-${Math.random().toString(36).slice(2, 7)}">Minecraft-ник</label>
      <div class="row"><input class="input" name="nick" placeholder="Ваш ник" maxlength="16" autocomplete="off" spellcheck="false" required><button class="btn" type="submit">Привязать</button></div>
    </form>
    <div class="lb-code" data-lb-code hidden>
      <div class="muted small" data-lb-codehint></div>
      <div class="code-big" data-lb-codevalue></div>
      <div class="muted small">Зайдите на сервер и выполните: <code data-lb-cmd></code></div>
      <div class="row"><button class="btn ghost small" type="button" data-lb-copy>Скопировать команду</button><button class="btn ghost small" type="button" data-lb-cancel>Отмена</button></div>
    </div>
    <div class="lb-msg small" data-lb-msg role="status"></div>
  </div>`;
}

// ---------- блоки ----------
const sect = (inner, cls = '') => `<section class="block ${cls}"><div class="wrap">${inner}</div></section>`;
const heading = (t) => (t ? `<h2 class="sec-title reveal">${esc(t)}</h2>` : '');

export const RENDERERS = {
  hero: (b, rc) => {
    const img = safeUrl(b.image);
    const s = rc.settings;
    return `<section class="block hero${img ? ' has-img' : ''}">${img ? `<img class="hero-bg" src="${esc(img)}" alt="">` : '<div class="hero-mesh" aria-hidden="true"></div>'}
      <div class="wrap hero-inner"><h1 class="reveal">${esc(b.title || s.siteName)}</h1>${b.subtitle ? `<p class="lead reveal">${esc(b.subtitle)}</p>` : ''}
      ${b.ctaText ? `<a class="btn big reveal" href="${esc(safeUrl(b.ctaLink) || '#')}">${esc(b.ctaText)}</a>` : ''}</div></section>`;
  },
  text: (b) => sect(`${heading(b.title)}<div class="prose reveal">${md(b.body)}</div>`),
  image: (b) => (safeUrl(b.src) ? sect(`<figure class="figure reveal"><img src="${esc(safeUrl(b.src))}" alt="${esc(b.alt)}" loading="lazy">${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ''}</figure>`) : ''),
  features: (b) => sect(`${heading(b.title)}<div class="grid feats">${(b.items || []).map((i) => `<div class="card feat reveal"><div class="feat-ic">${esc(i.icon || '✦')}</div><h3>${esc(i.title)}</h3><p>${esc(i.text)}</p></div>`).join('')}</div>`),
  status: (b, rc) => {
    const st = rc.status;
    return sect(`${heading(b.title)}<div class="card status reveal" data-status>
      <div class="st-dot ${st.online ? 'on' : 'off'}" data-st-dot></div>
      <div><div class="st-line"><strong data-st-text>${st.online ? `${st.players} / ${st.max} онлайн` : 'Сервер недоступен'}</strong></div>
      <div class="muted small">${esc(rc.settings.serverAddress)}${st.version ? ' · ' + esc(st.version) : ''}</div></div>
      <button class="btn ghost small" type="button" data-copy="${esc(rc.settings.serverAddress)}">Скопировать IP</button></div>`);
  },
  link: (b, rc) => sect(`${heading(b.title)}<div class="card pad reveal">${b.text ? `<p class="muted">${esc(b.text)}</p>` : ''}${linkWidget(rc.session)}</div>`, 'narrow'),
  catalog: (b, rc) => {
    const cats = rc.categories;
    const list = rc.products.filter((p) => !b.category || p.category_slug === b.category);
    const tabs = !b.category && cats.length > 1 ? `<div class="tabs reveal" data-tabs><button class="tab active" data-cat="">Все</button>${cats.map((c) => `<button class="tab" data-cat="${esc(c.slug)}">${esc(c.name)}</button>`).join('')}</div>` : '';
    return `<section class="block" id="shop"><div class="wrap">${heading(b.title)}${tabs}${list.length ? `<div class="grid products" data-products>${list.map(productCard).join('')}</div>` : '<div class="empty card pad">Товары пока не добавлены.</div>'}</div></section>`;
  },
  faq: (b) => sect(`${heading(b.title)}<div class="faq">${(b.items || []).map((i) => `<details class="card reveal"><summary>${esc(i.q)}</summary><div class="prose">${md(i.a)}</div></details>`).join('')}</div>`, 'narrow'),
  cta: (b) => sect(`<div class="cta reveal"><p>${esc(b.text)}</p>${b.button ? `<a class="btn big" href="${esc(safeUrl(b.link) || '#')}">${esc(b.button)}</a>` : ''}</div>`),
};

export function renderBlocks(blocks, rc) {
  return (Array.isArray(blocks) ? blocks : []).map((b, i) => {
    const fn = RENDERERS[b?.type];
    if (!fn) return '';
    return `<div class="blk" data-block-index="${i}">${fn(b, rc)}</div>`;
  }).join('\n');
}

// ---------- каркас ----------
const PENCIL = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

export function layout({ title, description, body, rc, pageSlug, boot = {}, extraHead = '' }) {
  const s = rc.settings;
  const pages = q.all('SELECT slug, title FROM pages WHERE published = 1 AND show_in_nav = 1 AND slug != \'\' ORDER BY nav_order, id');
  const nav = [...pages.map((p) => ({ title: p.title, url: `/p/${p.slug}` })), ...(s.nav || []).filter((n) => safeUrl(n.url) && n.title)];
  const bootJson = JSON.stringify({ owner: !!rc.owner, page: pageSlug ?? null, ...boot }).replace(/</g, '\\u003c');
  const linked = !!rc.session?.mc_uuid;
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title ? `${title} — ${s.siteName}` : `${s.siteName} — ${s.tagline}`)}</title>
<meta name="description" content="${esc(description || s.tagline)}"><meta name="theme-color" content="${esc(s.accent)}">
<link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/css/site.css">${rc.owner ? '<link rel="stylesheet" href="/css/editor.css">' : ''}${extraHead}
<link rel="icon" href="${esc(safeUrl(s.logo) || '/favicon.svg')}">
</head><body>
<header class="topbar"><div class="wrap bar">
  <a class="brand" href="/">${s.logo ? `<img src="${esc(safeUrl(s.logo))}" alt="">` : '<span class="brand-mark">N</span>'}<span>${esc(s.siteName)}</span></a>
  <nav class="nav" id="nav">${nav.map((n) => `<a href="${esc(n.url)}"${pageSlug && n.url === `/p/${pageSlug}` ? ' class="active"' : ''}>${esc(n.title)}</a>`).join('')}</nav>
  <button class="chip" type="button" data-open-account>${linked ? `<span class="chip-dot"></span>${esc(rc.session.mc_name)}` : 'Привязать аккаунт'}</button>
  <button class="burger" type="button" aria-label="Меню" data-burger><span></span><span></span></button>
</div></header>
<main id="blocks">${body}</main>
<footer class="footer"><div class="wrap"><span>${esc(s.footerText)}</span>${s.discord && safeUrl(s.discord) ? `<a href="${esc(safeUrl(s.discord))}" target="_blank" rel="noopener noreferrer">Discord</a>` : ''}</div></footer>
<dialog class="modal" id="account-dialog"><div class="modal-head"><h3>Minecraft-аккаунт</h3><button class="icon-btn" type="button" data-close-dialog aria-label="Закрыть">✕</button></div>${linkWidget(rc.session)}</dialog>
<button class="pencil" type="button" id="pencil" aria-label="Редактировать сайт" title="Редактировать сайт">${PENCIL}</button>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script type="application/json" id="boot">${bootJson}</script>
<script src="/js/app.js" defer></script>${rc.owner ? '<script src="/js/editor.js" defer></script>' : '<script src="/js/login.js" defer></script>'}
</body></html>`;
}

export const productPage = (p, rc, options) => {
  const img = p.image ? `<img src="${esc(safeUrl(p.image))}" alt="${esc(p.name)}">` : '<div class="ph big" aria-hidden="true">✦</div>';
  return `<section class="block"><div class="wrap product-page">
    <a class="back" href="/#shop">← Каталог</a>
    <div class="pp-grid"><div class="pp-img card">${img}</div>
    <div class="pp-info"><h1>${esc(p.name)}</h1><div class="price big">${priceStr(p.price_kop)}</div>
      <div class="prose">${md(p.description || p.short_description)}</div>
      <div class="buybox card pad" data-buybox data-product="${p.id}" data-price="${p.price_kop}">
        ${p.active ? `<div class="pay-opts" data-pay-opts>${(options || []).length ? '' : '<p class="muted">Способы оплаты временно недоступны.</p>'}</div>
          <div class="small muted" data-buy-for>${rc.session?.mc_uuid ? `Покупка для: <strong>${esc(rc.session.mc_name)}</strong>` : 'Для покупки привяжите Minecraft-аккаунт.'}</div>
          <button class="btn big full" type="button" data-buy ${(options || []).length ? '' : 'disabled'}>Купить</button>`
    : '<p class="muted">Товар сейчас недоступен.</p>'}
        <div class="lb-msg small" data-buy-msg role="status"></div>
      </div></div></div></div></section>`;
};

export function orderPage(o, rc) {
  return `<section class="block narrow"><div class="wrap"><div class="card pad order" data-order="${esc(o.id)}">
    <div class="order-state" data-order-state>…</div><h1 data-order-title>Заказ</h1>
    <p class="muted" data-order-text></p>
    <dl class="kv"><dt>Товар</dt><dd>${esc(o.product_name)}</dd><dt>Аккаунт</dt><dd>${esc(o.mc_name)}</dd><dt>Сумма</dt><dd>${esc(fmtMoney(o.amount_minor, o.currency))}</dd><dt>Заказ</dt><dd><code>${esc(o.id)}</code></dd></dl>
    <div class="row"><a class="btn ghost" href="/">На главную</a></div></div></div></section>`;
}

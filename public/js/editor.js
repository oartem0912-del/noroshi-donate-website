// Визуальный редактор владельца: кнопка-карандаш открывает панель. Правки сразу видны на странице (черновик),
// публикуются кнопкой «Опубликовать». Рендер предпросмотра делает сервер — результат идентичен боевому сайту.
(() => {
  'use strict';
  const { api, toast } = window.noroshi;
  const boot = JSON.parse(document.getElementById('boot').textContent);
  const h = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (v === false || v == null) continue; if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v); }
    for (const k of kids.flat()) e.append(k instanceof Node ? k : document.createTextNode(k ?? ''));
    return e;
  };

  let schema = {}; let categories = []; let pages = []; let page = null; let blocks = []; let selected = -1; let dirty = false; let panel; let timer; let seq = 0;
  const main = document.getElementById('blocks');

  const summary = (b) => b.title || b.text || b.src || b.ctaText || b.button || '';
  const newBlock = (type) => {
    const defaults = { hero: { title: 'Заголовок', subtitle: '', image: '', ctaText: '', ctaLink: '' }, text: { title: '', body: '' }, image: { src: '', alt: '', caption: '' }, features: { title: '', items: [{ icon: '✦', title: '', text: '' }] }, status: { title: 'Сервер' }, link: { title: 'Привязка аккаунта', text: '' }, catalog: { title: 'Магазин', category: '' }, faq: { title: 'Вопросы и ответы', items: [{ q: '', a: '' }] }, cta: { text: '', button: '', link: '' } };
    return { type, ...defaults[type] };
  };

  // ---------- сохранение и предпросмотр ----------
  function changed() {
    dirty = true; setStatus('Не сохранено…'); clearTimeout(timer);
    timer = setTimeout(sync, 500);
  }
  async function sync() {
    const my = ++seq;
    try {
      const [pre] = await Promise.all([api('POST', '/api/admin/preview', { blocks }), api('PUT', `/api/admin/pages/${page.id}/draft`, { blocks })]);
      if (my !== seq) return;
      if (isCurrentPage()) { main.innerHTML = pre.html; decorate(); window.noroshi.observe(main); window.noroshi.refreshLink?.(); }
      setStatus('Черновик сохранён');
    } catch (e) { setStatus('Ошибка: ' + e.message, true); }
  }
  const isCurrentPage = () => page && boot.page === page.slug;
  function decorate() {
    main.querySelectorAll('.blk').forEach((el) => { el.classList.toggle('blk-selected', Number(el.dataset.blockIndex) === selected); });
    main.querySelectorAll('.reveal').forEach((el) => el.classList.add('in'));
  }
  const setStatus = (t, err) => { const s = panel?.querySelector('[data-ed-status]'); if (s) { s.textContent = t; s.className = 'ed-status' + (err ? ' err' : ''); } };

  async function publish() {
    clearTimeout(timer); await sync();
    try { const r = await api('POST', `/api/admin/pages/${page.id}/publish`); page = r.page; dirty = false; setStatus('Опубликовано'); toast('Страница опубликована'); render(); }
    catch (e) { toast(e.message); }
  }

  // ---------- загрузка ----------
  async function load() {
    const [b, p] = await Promise.all([api('GET', '/api/admin/bootstrap'), api('GET', '/api/admin/pages')]);
    schema = b.schema; categories = b.categories; pages = p.pages;
    pickPage(pages.find((x) => x.slug === boot.page) || pages[0]);
  }
  function pickPage(p) {
    page = p; blocks = structuredClone(p.draftBlocks ?? p.blocks); selected = -1; render();
    if (isCurrentPage() && p.draftBlocks) sync();
  }

  // ---------- интерфейс панели ----------
  function field(f, obj, onChange) {
    const id = 'f' + Math.random().toString(36).slice(2, 8);
    const set = (v) => { obj[f.k] = v; onChange(); };
    let input;
    if (f.t === 'textarea') input = h('textarea', { class: 'input', id, oninput: (e) => set(e.target.value) }, obj[f.k] ?? '');
    else if (f.t === 'category') input = h('select', { class: 'input', id, onchange: (e) => set(e.target.value) }, h('option', { value: '' }, 'Все категории'), categories.map((c) => h('option', { value: c.slug, selected: obj[f.k] === c.slug }, c.name)));
    else if (f.t === 'image') {
      const url = h('input', { class: 'input', id, value: obj[f.k] ?? '', placeholder: 'https://… или загрузите файл', oninput: (e) => set(e.target.value) });
      const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true, onchange: async (e) => {
        const fl = e.target.files[0]; if (!fl) return;
        try { const res = await fetch('/api/admin/upload', { method: 'POST', body: fl, credentials: 'same-origin' }); const d = await res.json(); if (!d.ok) throw new Error(d.message); url.value = d.url; set(d.url); } catch (err) { toast(err.message); }
      } });
      input = h('div', { class: 'row' }, url, h('button', { class: 'btn ghost small', type: 'button', onclick: () => file.click() }, 'Загрузить'), file);
    } else if (f.t === 'items') {
      const list = h('div', { class: 'items' });
      const draw = () => {
        list.textContent = '';
        (obj[f.k] ||= []).forEach((it, i) => {
          list.append(h('div', { class: 'item' }, f.sub.map((s) => field(s, it, onChange)),
            h('div', { class: 'row' },
              h('button', { class: 'btn ghost small', type: 'button', disabled: i === 0, onclick: () => { [obj[f.k][i - 1], obj[f.k][i]] = [obj[f.k][i], obj[f.k][i - 1]]; draw(); onChange(); } }, '↑'),
              h('button', { class: 'btn ghost small', type: 'button', disabled: i === obj[f.k].length - 1, onclick: () => { [obj[f.k][i + 1], obj[f.k][i]] = [obj[f.k][i], obj[f.k][i + 1]]; draw(); onChange(); } }, '↓'),
              h('button', { class: 'btn ghost small danger', type: 'button', onclick: () => { obj[f.k].splice(i, 1); draw(); onChange(); } }, 'Удалить'))));
        });
        list.append(h('button', { class: 'btn ghost small', type: 'button', onclick: () => { obj[f.k].push(Object.fromEntries(f.sub.map((s) => [s.k, '']))); draw(); onChange(); } }, '+ Добавить пункт'));
      };
      draw(); input = list;
    } else input = h('input', { class: 'input', id, value: obj[f.k] ?? '', oninput: (e) => set(e.target.value) });
    return h('div', { class: 'ed-field' }, h('label', { for: id, class: 'small muted' }, f.l), input);
  }

  function blockList() {
    const list = h('div', { class: 'ed-blocks' });
    blocks.forEach((b, i) => {
      const s = schema[b.type];
      const item = h('div', { class: 'ed-block' + (i === selected ? ' sel' : ''), draggable: true },
        h('div', { class: 'ed-block-head', onclick: () => { selected = selected === i ? -1 : i; render(); scrollToBlock(i); } },
          h('span', { class: 'grip', title: 'Перетащите' }, '⠿'), h('div', { class: 'ed-title' }, h('strong', {}, s?.label || b.type), h('span', { class: 'muted small' }, ' ' + summary(b).slice(0, 40))),
          h('div', { class: 'ed-acts' },
            h('button', { class: 'icon-btn', type: 'button', title: 'Вверх', disabled: i === 0, onclick: (e) => { e.stopPropagation(); move(i, i - 1); } }, '↑'),
            h('button', { class: 'icon-btn', type: 'button', title: 'Вниз', disabled: i === blocks.length - 1, onclick: (e) => { e.stopPropagation(); move(i, i + 1); } }, '↓'),
            h('button', { class: 'icon-btn', type: 'button', title: 'Удалить', onclick: (e) => { e.stopPropagation(); if (confirm('Удалить блок?')) { blocks.splice(i, 1); selected = -1; render(); changed(); } } }, '🗑'))));
      if (i === selected) item.append(h('div', { class: 'ed-form' }, s.fields.map((f) => field(f, b, () => { changed(); }))));
      item.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); item.classList.add('drag'); });
      item.addEventListener('dragend', () => item.classList.remove('drag'));
      item.addEventListener('dragover', (e) => { e.preventDefault(); item.classList.add('over'); });
      item.addEventListener('dragleave', () => item.classList.remove('over'));
      item.addEventListener('drop', (e) => { e.preventDefault(); const from = Number(e.dataTransfer.getData('text/plain')); if (!Number.isNaN(from)) move(from, i); });
      list.append(item);
    });
    return list;
  }
  function move(from, to) {
    if (to < 0 || to >= blocks.length || from === to) return;
    const [b] = blocks.splice(from, 1); blocks.splice(to, 0, b); selected = to; render(); changed();
  }
  function scrollToBlock(i) { main.querySelector(`.blk[data-block-index="${i}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }

  function pagesTab() {
    const wrap = h('div', { class: 'ed-pages' });
    pages.forEach((p, i) => {
      const row = h('div', { class: 'ed-page' + (page.id === p.id ? ' sel' : '') },
        h('div', { class: 'ed-title' }, h('strong', {}, p.title), h('div', { class: 'muted small' }, (p.slug ? '/p/' + p.slug : 'Главная') + (p.published ? ' · опубликована' : ' · черновик'))),
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => { if (p.slug === boot.page || (p.slug === '' && boot.page === '')) { pickPage(p); tab = 'blocks'; render(); } else { location.href = (p.slug ? `/p/${p.slug}` : '/') + '?edit=1'; } } }, 'Править'),
          p.slug !== '' && h('label', { class: 'small' }, h('input', { type: 'checkbox', checked: p.showInNav, onchange: async (e) => { await api('PUT', `/api/admin/pages/${p.id}`, { title: p.title, slug: p.slug, showInNav: e.target.checked }); p.showInNav = e.target.checked; toast('Меню обновлено'); } }), ' в меню'),
          p.slug !== '' && h('button', { class: 'icon-btn', type: 'button', title: 'Вверх', disabled: i < 2, onclick: () => reorder(i, -1) }, '↑'),
          p.slug !== '' && h('button', { class: 'icon-btn', type: 'button', title: 'Вниз', disabled: i === pages.length - 1, onclick: () => reorder(i, 1) }, '↓'),
          p.slug !== '' && h('button', { class: 'btn ghost small', type: 'button', onclick: async () => { await api('POST', `/api/admin/pages/${p.id}/${p.published ? 'unpublish' : 'publish'}`); await reloadPages(); } }, p.published ? 'Снять' : 'Опубликовать'),
          p.slug !== '' && h('button', { class: 'icon-btn', type: 'button', title: 'Удалить', onclick: async () => { if (confirm(`Удалить страницу «${p.title}»?`)) { await api('DELETE', `/api/admin/pages/${p.id}`); if (p.id === page.id) location.href = '/?edit=1'; else await reloadPages(); } } }, '🗑')));
      wrap.append(row);
    });
    const title = h('input', { class: 'input', placeholder: 'Название новой страницы (например, Правила)' });
    wrap.append(h('div', { class: 'row' }, title, h('button', { class: 'btn small', type: 'button', onclick: async () => { if (!title.value.trim()) return; const r = await api('POST', '/api/admin/pages', { title: title.value }); location.href = `/p/${r.page.slug}?edit=1`; } }, 'Создать')));
    wrap.append(h('p', { class: 'muted small' }, 'Название и адрес страницы меняются в разделе «Страницы» полной панели.'));
    return wrap;
  }
  async function reorder(i, d) {
    const arr = pages.filter((p) => p.slug !== ''); const idx = arr.findIndex((p) => p.id === pages[i].id); const j = idx + d;
    if (j < 0 || j >= arr.length) return; [arr[idx], arr[j]] = [arr[j], arr[idx]];
    await api('POST', '/api/admin/pages/reorder', { ids: arr.map((p) => p.id) }); await reloadPages();
  }
  async function reloadPages() { pages = (await api('GET', '/api/admin/pages')).pages; page = pages.find((p) => p.id === page.id) || pages[0]; render(); }

  // полная панель во вложенном окне
  function openAdmin(section) {
    const fr = h('iframe', { src: `/admin#${section}`, class: 'admin-frame', title: 'Панель владельца' });
    const box = h('div', { class: 'admin-overlay' }, h('div', { class: 'admin-overlay-bar' }, h('strong', {}, 'Панель владельца'), h('button', { class: 'btn ghost small', type: 'button', onclick: () => { box.remove(); location.reload(); } }, 'Закрыть')), fr);
    document.body.append(box);
  }

  let tab = 'blocks';
  function render() {
    if (!panel) return;
    const body = panel.querySelector('.ed-body'); body.textContent = '';
    panel.querySelectorAll('.ed-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    if (tab === 'blocks') {
      body.append(h('div', { class: 'ed-pagebar' }, h('span', { class: 'muted small' }, 'Страница: '), h('strong', {}, page?.title || ''),
        !isCurrentPage() && h('div', { class: 'small muted' }, 'Эта страница не открыта на экране — изменения сохранятся, но живой предпросмотр недоступен. Откройте её через вкладку «Страницы».')),
      blockList());
      const sel = h('select', { class: 'input' }, Object.entries(schema).map(([k, v]) => h('option', { value: k }, v.label)));
      body.append(h('div', { class: 'row ed-add' }, sel, h('button', { class: 'btn small', type: 'button', onclick: () => { blocks.push(newBlock(sel.value)); selected = blocks.length - 1; render(); changed(); setTimeout(() => scrollToBlock(selected), 700); } }, '+ Добавить блок')));
    } else if (tab === 'pages') body.append(pagesTab());
    else body.append(h('div', { class: 'ed-links' },
      h('button', { class: 'btn ghost', type: 'button', onclick: () => openAdmin('products') }, '🛍 Товары и категории'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => openAdmin('settings') }, '⚙️ Сайт, меню, оформление'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => openAdmin('income') }, '💰 Доходы'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => openAdmin('orders') }, '📦 Заказы и выдача'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => openAdmin('owners') }, '🔐 Владельцы и безопасность')));
  }

  function build() {
    panel = h('aside', { class: 'ed-panel', 'aria-label': 'Редактор сайта' },
      h('div', { class: 'ed-head' }, h('strong', {}, '✎ Редактор'), h('span', { class: 'ed-status', 'data-ed-status': true }, ''),
        h('button', { class: 'icon-btn', type: 'button', title: 'Свернуть', onclick: () => close() }, '✕')),
      h('div', { class: 'ed-tabs' }, [['blocks', 'Блоки'], ['pages', 'Страницы'], ['more', 'Ещё']].map(([k, l]) => h('button', { class: 'ed-tab', 'data-tab': k, type: 'button', onclick: () => { tab = k; render(); } }, l))),
      h('div', { class: 'ed-body' }),
      h('div', { class: 'ed-foot' },
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => { document.body.classList.toggle('ed-peek'); } }, '👁 Предпросмотр'),
        h('button', { class: 'btn ghost small', type: 'button', onclick: async () => { await api('POST', '/api/auth/logout'); location.href = '/'; } }, 'Выйти'),
        h('button', { class: 'btn small', type: 'button', onclick: publish }, 'Опубликовать')));
    document.body.append(panel);
  }
  function open() { if (!panel) { build(); load().catch((e) => toast(e.message)); } document.body.classList.add('ed-open'); document.body.classList.remove('ed-peek'); }
  function close() { document.body.classList.remove('ed-open', 'ed-peek'); }

  document.getElementById('pencil').addEventListener('click', () => (document.body.classList.contains('ed-open') ? close() : open()));
  // клик по блоку на странице выбирает его в панели
  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('ed-open') || document.body.classList.contains('ed-peek') || !isCurrentPage()) return;
    const blk = e.target.closest('#blocks .blk'); if (!blk) return;
    if (e.target.closest('a, button, summary, input')) e.preventDefault();
    selected = Number(blk.dataset.blockIndex); tab = 'blocks'; render(); decorate();
  }, true);
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); } });
  if (new URLSearchParams(location.search).get('edit')) open();
})();

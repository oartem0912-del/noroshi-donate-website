// Панель владельца: доходы, заказы, товары, настройки, владельцы, журнал.
(() => {
  'use strict';
  const h = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (v === false || v == null) continue; if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'value') e.value = v; else e.setAttribute(k, v === true ? '' : v); }
    for (const k of kids.flat()) if (k !== false && k != null) e.append(k instanceof Node ? k : document.createTextNode(k));
    return e;
  };
  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    let d = {}; try { d = await res.json(); } catch { /* */ }
    if (res.status === 401) { location.href = '/?login=1'; throw new Error('Нужен вход'); }
    if (!res.ok || d.ok === false) throw new Error(d.message || 'Ошибка');
    return d;
  }
  let tt; const toast = (m) => { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 3200); };
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };
  const CUR = { UAH: '₴', USD: '$', EUR: '€' };
  const kop = (v) => `${(v / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₴`;
  const minor = (v, c) => `${(v / 100).toFixed(2).replace('.', ',')} ${CUR[c] || c}`;
  const dt = (t) => (t ? new Date(t).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const STATUS = { pending: 'Ожидает', paid: 'Оплачен', cancelled: 'Отменён', refunded: 'Возврат', failed: 'Неудача' };
  const DELIV = { none: '—', queued: 'В очереди', delivering: 'Выдаётся', delivered: 'Выдан', failed: 'Ошибка' };

  let boot; const root = document.getElementById('app');
  const sections = [['income', '💰 Доходы'], ['orders', '📦 Заказы'], ['products', '🛍 Товары'], ['settings', '⚙️ Настройки'], ['owners', '🔐 Владельцы'], ['logs', '🧾 Журнал']];

  const field = (label, input, hint) => h('label', { class: 'af' }, h('span', { class: 'small muted' }, label), input, hint && h('span', { class: 'small muted' }, hint));
  const inp = (v, attrs = {}) => h('input', { class: 'input', value: v ?? '', ...attrs });

  function askCode(res, onDone) {
    const code = inp('', { placeholder: '6 цифр', inputmode: 'numeric', maxlength: 6 });
    const msg = h('div', { class: 'lb-msg small' });
    const dlg = h('dialog', { class: 'modal' }, h('div', { class: 'modal-head' }, h('h3', {}, 'Подтверждение')),
      h('p', { class: 'muted small' }, `Код отправлен на ${res.sentTo}. Введите его, чтобы выполнить действие.`), code, msg,
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'btn', onclick: async () => { try { await api('POST', '/api/admin/confirm', { id: res.id, code: code.value }); dlg.close(); dlg.remove(); toast('Подтверждено'); onDone?.(); } catch (e) { msg.textContent = e.message; msg.className = 'lb-msg small err'; } } }, 'Подтвердить'),
        h('button', { class: 'btn ghost', onclick: () => { dlg.close(); dlg.remove(); } }, 'Отмена')));
    document.body.append(dlg); dlg.showModal();
  }

  async function start() {
    boot = await api('GET', '/api/admin/bootstrap');
    window.addEventListener('hashchange', route); route();
  }
  function shell(active, content) {
    root.textContent = '';
    root.append(h('div', { class: 'ad-wrap' },
      h('aside', { class: 'ad-side' }, h('a', { class: 'brand', href: '/' }, h('span', { class: 'brand-mark' }, 'N'), h('span', {}, 'Noroshi')),
        h('nav', {}, sections.map(([k, l]) => h('a', { href: '#' + k, class: k === active ? 'active' : '' }, l))),
        h('div', { class: 'muted small ad-me' }, boot.me.email)),
      h('main', { class: 'ad-main' }, content)));
  }
  const views = { income, orders, products, settings, owners, logs };
  async function route() {
    const k = location.hash.slice(1) || 'income';
    const v = views[k] || income;
    try { shell(k, await v()); } catch (e) { toast(e.message); }
  }
  const rerender = () => route();

  // ---------- доходы ----------
  async function income(includeTest = false) {
    const { stats: s } = await api('GET', `/api/admin/stats${includeTest ? '?test=1' : ''}`);
    const per = [['day', 'Сегодня'], ['week', 'Неделя'], ['month', 'Месяц'], ['all', 'Весь период']];
    const max = Math.max(1, ...s.chart.map((d) => d.net));
    const tx = await api('GET', '/api/admin/orders?limit=20');
    const el = h('div', {},
      h('div', { class: 'ad-head' }, h('h1', {}, 'Доходы'),
        h('label', { class: 'small' }, h('input', { type: 'checkbox', checked: includeTest, onchange: guard(async (e) => { shell('income', await income(e.target.checked)); }) }), ' включать тестовые заказы')),
      h('div', { class: 'ad-cards' }, per.map(([k, l]) => h('div', { class: 'card pad stat' }, h('div', { class: 'muted small' }, l), h('div', { class: 'stat-v' }, kop(s.periods[k].net)),
        h('div', { class: 'small muted' }, `оплачено ${kop(s.periods[k].gross)} · комиссии ${kop(s.periods[k].fees)}`), h('div', { class: 'small muted' }, `заказов: ${s.periods[k].orders} · возвраты: ${kop(s.periods[k].refunded)}`)))),
      h('p', { class: 'muted small' }, 'Крупная цифра — сумма к получению (оплачено минус комиссии провайдера) в гривнах. Учитываются только заказы, подтверждённые платёжным провайдером. Расчётный остаток к выводу: ',
        h('strong', {}, kop(s.estimatedAvailableKop)), ' — это расчёт по заказам, а не баланс у провайдера; реальный баланс и выплаты смотрите в кабинете провайдера.'),
      h('div', { class: 'card pad' }, h('h3', {}, 'Последние 30 дней (к получению, ₴)'),
        h('div', { class: 'chart' }, s.chart.map((d) => h('div', { class: 'bar', title: `${d.date}: ${kop(d.net)} · заказов ${d.orders}` }, h('i', { style: `height:${Math.max(2, (d.net / max) * 100)}%` }))))),
      h('div', { class: 'ad-grid2' },
        h('div', { class: 'card pad' }, h('h3', {}, 'Заказы'), table(['Статус', 'Кол-во'], Object.entries(s.counts).map(([k, v]) => [STATUS[k], v])),
          h('h3', { style: 'margin-top:16px' }, 'Выдача оплаченных'), table(['Статус', 'Кол-во'], Object.entries(s.delivery).map(([k, v]) => [DELIV[k], v]))),
        h('div', { class: 'card pad' }, h('h3', {}, 'По провайдерам'), s.byProvider.length ? table(['Провайдер', 'Заказов', 'Оплачено', 'Комиссии', 'К получению'], s.byProvider.map((p) => [p.provider, p.n, kop(p.gross), kop(p.fees), kop(p.net)])) : h('p', { class: 'muted' }, 'Пока нет оплат.'),
          h('h3', { style: 'margin-top:16px' }, 'Выводы средств'), h('p', { class: 'muted small' }, 'Сайт не имитирует вывод: история выплат доступна только если её отдаёт провайдер. Сейчас выплаты (в т.ч. на карту в гривнах) оформляются в кабинете провайдера.'))),
      h('div', { class: 'card pad' }, h('h3', {}, 'История транзакций'), ordersTable(tx.rows)));
    return el;
  }
  const table = (head, rows) => h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, head.map((c) => h('th', {}, c)))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c)))))));
  function ordersTable(rows) {
    return table(['Дата', 'Игрок', 'Товар', 'Сумма', 'Валюта/курс', 'Комиссия', 'К получению', 'Статус', 'Выдача', ''], rows.map((o) => [
      dt(o.paid_at || o.created_at), o.mc_name, o.product_name, minor(o.amount_minor, o.currency) + (o.currency !== 'UAH' ? ` (${kop(o.price_kop)})` : ''),
      `${o.currency}${o.currency !== 'UAH' ? ' @ ' + o.rate.toFixed(2) : ''}${o.test ? ' · тест' : ''}`, o.status === 'paid' || o.status === 'refunded' ? `${minor(o.fee_minor, o.currency)}` : '—', o.status === 'paid' ? kop(o.net_kop) : '—',
      h('span', { class: 'pill ' + o.status }, STATUS[o.status]), h('span', { class: 'pill d-' + o.delivery_status }, DELIV[o.delivery_status]),
      h('button', { class: 'btn ghost small', onclick: () => orderDetail(o.id) }, 'Открыть')]));
  }
  async function orderDetail(id) {
    const { order: o, events, logs } = await api('GET', `/api/admin/orders/${id}`);
    const dlg = h('dialog', { class: 'modal wide' }, h('div', { class: 'modal-head' }, h('h3', {}, 'Заказ'), h('button', { class: 'icon-btn', onclick: () => { dlg.close(); dlg.remove(); } }, '✕')),
      h('dl', { class: 'kv' }, ...[['ID', o.id], ['Игрок', `${o.mc_name} (${o.mc_uuid})`], ['Товар', o.product_name], ['Цена', kop(o.price_kop)], ['Оплата', `${minor(o.amount_minor, o.currency)}, курс ${o.rate}`], ['Провайдер', `${o.provider}${o.paytype ? ' / ' + o.paytype : ''}${o.test ? ' (тест)' : ''}`],
        ['Комиссия', minor(o.fee_minor, o.currency)], ['Статус', STATUS[o.status]], ['Выдача', `${DELIV[o.delivery_status]} (попытка ${o.delivery_attempt})${o.delivery_message ? ' — ' + o.delivery_message : ''}`], ['Создан', dt(o.created_at)], ['Оплачен', dt(o.paid_at)], ['Команды', o.delivery_commands.join('  |  ')]].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      events.length ? h('p', { class: 'small muted' }, 'События провайдера: ' + events.map((e) => `${e.kind} (${dt(e.created_at)})`).join(', ')) : null,
      logs.length ? h('div', { class: 'small' }, h('strong', {}, 'Журнал:'), logs.map((l) => h('div', { class: 'muted' }, `${dt(l.created_at)} [${l.level}] ${l.message}`))) : null,
      o.status === 'paid' && o.delivery_status !== 'delivered' ? h('button', { class: 'btn', style: 'margin-top:12px', onclick: guard(async () => { if (confirm('Повторить выдачу? Если часть команд уже выполнилась, они выполнятся снова.')) { await api('POST', `/api/admin/orders/${o.id}/retry`); toast('Заказ поставлен в очередь'); dlg.close(); dlg.remove(); rerender(); } }) }, 'Повторить выдачу') : null);
    document.body.append(dlg); dlg.showModal();
  }

  async function orders() {
    let status = ''; let search = '';
    const box = h('div', { class: 'card pad' });
    const load = guard(async () => { const r = await api('GET', `/api/admin/orders?status=${status}&search=${encodeURIComponent(search)}&limit=100`); box.textContent = ''; box.append(h('p', { class: 'muted small' }, `Найдено: ${r.total}`), ordersTable(r.rows)); });
    const el = h('div', {}, h('div', { class: 'ad-head' }, h('h1', {}, 'Заказы и выдача')),
      h('div', { class: 'row', style: 'margin-bottom:12px' }, h('select', { class: 'input', onchange: (e) => { status = e.target.value; load(); } }, h('option', { value: '' }, 'Все статусы'), Object.entries(STATUS).map(([k, v]) => h('option', { value: k }, v))),
        h('input', { class: 'input', placeholder: 'Поиск: ник, товар, ID', oninput: (e) => { search = e.target.value; clearTimeout(orders.t); orders.t = setTimeout(load, 300); } })), box);
    load(); return el;
  }

  // ---------- товары ----------
  async function products() {
    const [{ products: list }, { categories }] = await Promise.all([api('GET', '/api/admin/products'), api('GET', '/api/admin/categories')]);
    boot.categories = categories;
    const catBox = h('div', { class: 'card pad' }, h('h3', {}, 'Категории'),
      categories.map((c, i) => h('div', { class: 'row', style: 'margin-bottom:6px' }, h('input', { class: 'input', value: c.name, onchange: guard(async (e) => { await api('PUT', `/api/admin/categories/${c.id}`, { name: e.target.value }); toast('Сохранено'); }) }),
        h('button', { class: 'icon-btn', disabled: i === 0, onclick: guard(async () => { await swap(categories, i, i - 1, '/api/admin/categories/reorder'); }) }, '↑'),
        h('button', { class: 'icon-btn', disabled: i === categories.length - 1, onclick: guard(async () => { await swap(categories, i, i + 1, '/api/admin/categories/reorder'); }) }, '↓'),
        h('button', { class: 'icon-btn', onclick: guard(async () => { if (confirm('Удалить категорию? Товары останутся без категории.')) { await api('DELETE', `/api/admin/categories/${c.id}`); rerender(); } }) }, '🗑'))),
      (() => { const n = inp('', { placeholder: 'Новая категория' }); return h('div', { class: 'row' }, n, h('button', { class: 'btn small', onclick: guard(async () => { if (n.value.trim()) { await api('POST', '/api/admin/categories', { name: n.value }); rerender(); } }) }, 'Добавить')); })());
    const rows = h('div', { class: 'card pad' }, h('div', { class: 'ad-head' }, h('h3', {}, 'Товары'), h('button', { class: 'btn small', onclick: () => productForm(null) }, '+ Новый товар')),
      list.length ? table(['', 'Название', 'Цена', 'Категория', 'Статус', ''], list.map((p, i) => [
        h('span', {}, h('button', { class: 'icon-btn', disabled: i === 0, onclick: guard(async () => swap(list, i, i - 1, '/api/admin/products/reorder')) }, '↑'), h('button', { class: 'icon-btn', disabled: i === list.length - 1, onclick: guard(async () => swap(list, i, i + 1, '/api/admin/products/reorder')) }, '↓')),
        p.name, `${p.priceUah.toFixed(2)} ₴`, categories.find((c) => c.id === p.categoryId)?.name || '—', h('span', { class: 'pill ' + (p.active ? 'paid' : 'cancelled') }, p.active ? 'Активен' : 'Отключён'),
        h('span', { class: 'row' }, h('button', { class: 'btn ghost small', onclick: () => productForm(p) }, 'Изменить'), h('button', { class: 'btn ghost small', onclick: guard(async () => { await api('PUT', `/api/admin/products/${p.id}`, { ...p, active: !p.active }); rerender(); }) }, p.active ? 'Отключить' : 'Включить'),
          h('button', { class: 'icon-btn', onclick: guard(async () => { if (confirm(`Удалить «${p.name}»? История заказов сохранится.`)) { await api('DELETE', `/api/admin/products/${p.id}`); rerender(); } }) }, '🗑'))])) : h('p', { class: 'muted' }, 'Товаров пока нет.'));
    return h('div', {}, h('div', { class: 'ad-head' }, h('h1', {}, 'Товары')), h('div', { class: 'ad-grid2 wide-left' }, rows, catBox));
  }
  async function swap(arr, i, j, url) { const a = arr.map((x) => x.id); [a[i], a[j]] = [a[j], a[i]]; await api('POST', url, { ids: a }); rerender(); }
  function productForm(p) {
    const v = p || { name: '', shortDescription: '', description: '', image: '', priceUah: '', categoryId: null, active: true, delivery: { commands: [], requireOnline: true } };
    const f = { name: inp(v.name, { maxlength: 100 }), short: inp(v.shortDescription, { maxlength: 300 }), desc: h('textarea', { class: 'input', rows: 6 }, v.description), image: inp(v.image, { placeholder: 'https://… или загрузите' }),
      price: inp(v.priceUah, { type: 'number', step: '0.01', min: '0.01' }), cat: h('select', { class: 'input' }, h('option', { value: '' }, '— без категории —'), boot.categories.map((c) => h('option', { value: c.id, selected: c.id === v.categoryId }, c.name))),
      cmds: h('textarea', { class: 'input mono', rows: 5, placeholder: 'lp user %player% parent add vip\nsay %player% купил VIP!' }, v.delivery.commands.join('\n')),
      online: h('input', { type: 'checkbox', checked: v.delivery.requireOnline }), active: h('input', { type: 'checkbox', checked: v.active }) };
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true, onchange: guard(async (e) => { const r = await fetch('/api/admin/upload', { method: 'POST', body: e.target.files[0], credentials: 'same-origin' }); const d = await r.json(); if (!d.ok) throw new Error(d.message); f.image.value = d.url; }) });
    const dlg = h('dialog', { class: 'modal wide' }, h('div', { class: 'modal-head' }, h('h3', {}, p ? 'Изменить товар' : 'Новый товар'), h('button', { class: 'icon-btn', onclick: () => { dlg.close(); dlg.remove(); } }, '✕')),
      h('div', { class: 'af-grid' }, field('Название', f.name), field('Цена, ₴', f.price), field('Категория', f.cat), field('Краткое описание (на карточке)', f.short), field('Изображение', h('div', { class: 'row' }, f.image, h('button', { class: 'btn ghost small', type: 'button', onclick: () => file.click() }, 'Загрузить'), file))),
      field('Подробное описание (**жирный**, - списки, [ссылка](url))', f.desc),
      field('Действие после оплаты — команды консоли, по одной в строке', f.cmds, 'Плейсхолдеры: %player% — ник, %uuid% — UUID, %order% — номер заказа. Слэш в начале не нужен. Плагин выполнит их только для заказов с подтверждённой оплатой.'),
      h('label', { class: 'small' }, f.online, ' Выдавать только когда игрок онлайн'), h('label', { class: 'small' }, f.active, ' Товар доступен для покупки'),
      h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { class: 'btn', onclick: guard(async () => {
        const body = { name: f.name.value, shortDescription: f.short.value, description: f.desc.value, image: f.image.value, priceUah: Number(f.price.value), categoryId: f.cat.value || null, active: f.active.checked, delivery: { commands: f.cmds.value.split('\n'), requireOnline: f.online.checked } };
        await api(p ? 'PUT' : 'POST', p ? `/api/admin/products/${p.id}` : '/api/admin/products', body); dlg.close(); dlg.remove(); toast('Сохранено'); rerender();
      }) }, 'Сохранить'), h('button', { class: 'btn ghost', onclick: () => { dlg.close(); dlg.remove(); } }, 'Отмена')));
    document.body.append(dlg); dlg.showModal();
  }

  // ---------- настройки и интеграции ----------
  async function settings() {
    boot = await api('GET', '/api/admin/bootstrap'); const s = boot.settings;
    const f = { name: inp(s.siteName), tag: inp(s.tagline), addr: inp(s.serverAddress), banner: inp(s.banner), logo: inp(s.logo), accent: inp(s.accent, { type: 'color' }), discord: inp(s.discord), footer: inp(s.footerText),
      usd: inp(s.manualRates.USD ?? '', { type: 'number', step: '0.01', placeholder: boot.rates.USD ? `НБУ: ${boot.rates.USD.rate}` : 'авто' }), eur: inp(s.manualRates.EUR ?? '', { type: 'number', step: '0.01', placeholder: boot.rates.EUR ? `НБУ: ${boot.rates.EUR.rate}` : 'авто' }) };
    let nav = structuredClone(s.nav); const navBox = h('div', {});
    const drawNav = () => { navBox.textContent = ''; nav.forEach((n, i) => navBox.append(h('div', { class: 'row', style: 'margin-bottom:6px' }, h('input', { class: 'input', value: n.title, placeholder: 'Название', oninput: (e) => { n.title = e.target.value; } }), h('input', { class: 'input', value: n.url, placeholder: 'https://… или /p/страница', oninput: (e) => { n.url = e.target.value; } }), h('button', { class: 'icon-btn', onclick: () => { nav.splice(i, 1); drawNav(); } }, '🗑')))); navBox.append(h('button', { class: 'btn ghost small', onclick: () => { nav.push({ title: '', url: '' }); drawNav(); } }, '+ Пункт меню')); };
    drawNav();
    const curBoxes = ['UAH', 'EUR', 'USD'].map((c) => h('label', { class: 'small' }, h('input', { type: 'checkbox', checked: s.currencies.includes(c), disabled: c === 'UAH', 'data-cur': c }), ` ${c} `));
    const provBoxes = boot.providers.map((p) => h('label', { class: 'small prov' }, h('input', { type: 'checkbox', checked: s.providers[p.id] !== false && p.configured, disabled: !p.configured, 'data-prov': p.id }), ` ${p.title} `, h('span', { class: 'pill ' + (p.configured ? 'paid' : 'cancelled') }, p.configured ? 'ключи заданы' : 'не настроен')));
    const srv = boot.server;
    return h('div', {}, h('div', { class: 'ad-head' }, h('h1', {}, 'Настройки')),
      h('div', { class: 'card pad' }, h('h3', {}, 'Сайт'), h('div', { class: 'af-grid' }, field('Название', f.name), field('Слоган', f.tag), field('Адрес сервера (IP)', f.addr), field('Баннер по умолчанию (URL)', f.banner), field('Логотип (URL)', f.logo), field('Акцентный цвет', f.accent), field('Discord (ссылка)', f.discord), field('Подвал', f.footer)),
        h('h3', {}, 'Дополнительные пункты меню'), h('p', { class: 'small muted' }, 'Опубликованные страницы с флагом «в меню» добавляются автоматически.'), navBox,
        h('h3', { style: 'margin-top:16px' }, 'Ручной курс'), h('p', { class: 'small muted' }, 'Гривен за 1 единицу. Пусто — берётся официальный курс НБУ (обновляется автоматически). Курс фиксируется в заказе.'), h('div', { class: 'af-grid' }, field('USD', f.usd), field('EUR', f.eur)),
        h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { class: 'btn', onclick: guard(async () => {
          await api('PUT', '/api/admin/settings', { siteName: f.name.value, tagline: f.tag.value, serverAddress: f.addr.value, banner: f.banner.value, logo: f.logo.value, accent: f.accent.value, discord: f.discord.value, footerText: f.footer.value, nav, manualRates: { USD: f.usd.value, EUR: f.eur.value } }); toast('Сохранено');
        }) }, 'Сохранить'), h('button', { class: 'btn ghost', onclick: guard(async () => { await api('POST', '/api/admin/rates/refresh'); toast('Курсы обновлены'); rerender(); }) }, 'Обновить курсы НБУ'))),
      h('div', { class: 'card pad' }, h('h3', {}, 'Платежи'), h('p', { class: 'small muted' }, 'Ключи провайдеров задаются переменными окружения на сервере (не в панели и не в репозитории). Изменение платёжных настроек подтверждается кодом, отправленным на второй адрес владельца.'),
        h('div', { class: 'row' }, provBoxes), h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Валюты покупателя:'), curBoxes),
        boot.testPayments ? h('p', { class: 'small', style: 'color:var(--warn)' }, '⚠ Включена тестовая оплата (TEST_PAYMENTS=true). Тестовые заказы не попадают в «Доходы».') : null,
        boot.liqpaySandbox ? h('p', { class: 'small', style: 'color:var(--warn)' }, '⚠ LiqPay работает в песочнице (LIQPAY_SANDBOX=true).') : null,
        h('p', { class: 'small muted' }, 'Адрес для уведомлений LiqPay (Server URL): ', h('code', {}, boot.urls.liqpayWebhook)),
        h('button', { class: 'btn', onclick: guard(async () => {
          const currencies = ['UAH', ...curBoxes.map((l) => l.firstChild).filter((i) => i.checked && i.dataset.cur !== 'UAH').map((i) => i.dataset.cur)];
          const providers = Object.fromEntries(provBoxes.map((l) => [l.firstChild.dataset.prov, l.firstChild.checked || l.firstChild.disabled]));
          askCode(await api('PUT', '/api/admin/settings/payments', { currencies, providers }), rerender);
        }) }, 'Сохранить платёжные настройки')),
      h('div', { class: 'card pad' }, h('h3', {}, 'Плагин и сервер'), srv ? h('p', {}, h('span', { class: 'pill ' + (Date.now() - srv.lastSeen < 90000 ? 'paid' : 'cancelled') }, Date.now() - srv.lastSeen < 90000 ? 'на связи' : 'нет связи'), ` ${srv.name} · ${srv.version || '?'} · онлайн ${srv.online}/${srv.max} · последний сигнал ${dt(srv.lastSeen)}`) : h('p', { class: 'muted' }, 'Плагин ещё не подключался. Установите Noroshi Donate Plugin и укажите адрес сайта и секрет (см. README).'),
        h('p', { class: 'small muted' }, 'Адрес сайта для плагина: ', h('code', {}, boot.urls.base))),
      h('div', { class: 'card pad' }, h('h3', {}, 'Резервные копии'), h('p', { class: 'small muted' }, 'Копии создаются автоматически и проверяются на целостность. Восстановление: остановить сайт, заменить data/noroshi.sqlite нужной копией из data/backups (см. README).'),
        h('button', { class: 'btn ghost', onclick: guard(async () => { const r = await api('POST', '/api/admin/backup'); toast('Создана копия ' + r.file); }) }, 'Создать копию сейчас')));
  }

  // ---------- владельцы ----------
  async function owners() {
    boot = await api('GET', '/api/admin/bootstrap');
    const mk = (o) => { const n = inp('', { type: 'email', placeholder: 'Новая почта' }); return h('div', { class: 'row' }, n, h('button', { class: 'btn ghost small', onclick: guard(async () => askCode(await api('POST', '/api/admin/owners/replace', { role: o.role, email: n.value }), () => { if (o.email === boot.me.email) location.href = '/?login=1'; else rerender(); })) }, 'Заменить адрес')); };
    return h('div', {}, h('div', { class: 'ad-head' }, h('h1', {}, 'Владельцы')),
      h('div', { class: 'card pad' }, h('p', { class: 'muted small' }, 'Оба адреса имеют полные права. Вход — только по одноразовому коду на почту (так подтверждается владение ящиком). Замена адреса и передача основной роли требуют кода, отправленного на второй адрес.'),
        boot.owners.map((o) => h('div', { class: 'card pad', style: 'margin-bottom:10px;box-shadow:none' }, h('div', {}, h('strong', {}, o.email), ' ', h('span', { class: 'pill paid' }, o.role === 'primary' ? 'основной' : 'дополнительный')), h('div', { class: 'small muted' }, `добавлен ${dt(o.added_at)} · ${o.verified_at ? 'почта подтверждена ' + dt(o.verified_at) : 'ещё не входил'}`), mk(o))),
        h('button', { class: 'btn ghost', onclick: guard(async () => askCode(await api('POST', '/api/admin/owners/swap'), rerender)) }, 'Передать основную роль второму адресу'),
        h('div', { style: 'margin-top:14px' }, h('button', { class: 'btn ghost', onclick: guard(async () => { await api('POST', '/api/auth/logout'); location.href = '/'; }) }, 'Выйти'))));
  }

  async function logs() {
    let level = '';
    const box = h('div', { class: 'card pad' });
    const load = guard(async () => { const r = await api('GET', `/api/admin/logs?level=${level}`); box.textContent = ''; box.append(table(['Время', 'Уровень', 'Источник', 'Сообщение'], r.logs.map((l) => [dt(l.created_at), h('span', { class: 'pill lv-' + l.level }, l.level), l.source, l.message + (l.ctx ? ' ' + l.ctx : '')]))); });
    const el = h('div', {}, h('div', { class: 'ad-head' }, h('h1', {}, 'Журнал'), h('select', { class: 'input', style: 'width:auto', onchange: (e) => { level = e.target.value; load(); } }, h('option', { value: '' }, 'Все'), h('option', { value: 'error' }, 'Ошибки'), h('option', { value: 'warn' }, 'Предупреждения'), h('option', { value: 'info' }, 'Инфо'))), box);
    load(); return el;
  }

  start().catch((e) => { root.textContent = e.message; });
})();

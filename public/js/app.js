// Публичный сайт: привязка аккаунта, покупка, статус сервера, анимации. Без зависимостей.
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const boot = (() => { try { return JSON.parse($('#boot').textContent); } catch { return {}; } })();

  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    let data = {}; try { data = await res.json(); } catch { /* не JSON */ }
    if (!res.ok || data.ok === false) { const e = new Error(data.message || 'Ошибка запроса'); e.code = data.error; throw e; }
    return data;
  }
  window.noroshi = { api, $, $$ };

  let toastTimer;
  function toast(msg) { const t = $('#toast'); if (!t) return; t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200); }
  window.noroshi.toast = toast;

  // ---------- меню, анимации, копирование ----------
  const burger = $('[data-burger]'); const nav = $('#nav');
  burger?.addEventListener('click', () => { const o = nav.classList.toggle('open'); burger.setAttribute('aria-expanded', o); });

  const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .08 }) : null;
  window.noroshi.observe = (root = document) => $$('.reveal:not(.in)', root).forEach((el) => (io ? io.observe(el) : el.classList.add('in')));
  window.noroshi.observe();

  document.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) { try { await navigator.clipboard.writeText(c.dataset.copy); toast('Скопировано'); } catch { toast(c.dataset.copy); } }
    const tab = e.target.closest('[data-tabs] .tab');
    if (tab) {
      $$('.tab', tab.parentElement).forEach((t) => t.classList.toggle('active', t === tab));
      $$('[data-products] .product').forEach((p) => { p.hidden = !!tab.dataset.cat && p.dataset.category !== tab.dataset.cat; });
    }
  });

  // ---------- статус сервера ----------
  async function refreshStatus() {
    const box = $('[data-status]'); if (!box) return;
    try {
      const { status } = await api('GET', '/api/status');
      $('[data-st-dot]', box).className = 'st-dot ' + (status.online ? 'on' : 'off');
      $('[data-st-text]', box).textContent = status.online ? `${status.players} / ${status.max} онлайн` : 'Сервер недоступен';
    } catch { /* сеть */ }
  }
  setInterval(refreshStatus, 30000);

  // ---------- диалог аккаунта ----------
  const dlg = $('#account-dialog');
  $('[data-open-account]')?.addEventListener('click', () => dlg?.showModal());
  $('[data-close-dialog]')?.addEventListener('click', () => dlg?.close());
  dlg?.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  window.noroshi.openAccount = () => { if (dlg && !dlg.open) dlg.showModal(); };

  // ---------- виджет привязки ----------
  let pollTimer; let current = { linked: false };
  function setLinked(st) {
    current = st;
    $$('[data-linkbox]').forEach((box) => {
      box.dataset.state = st.linked ? 'linked' : 'unlinked';
      $('.lb-linked', box).hidden = !st.linked; $('[data-lb-form]', box).hidden = st.linked;
      $('[data-lb-code]', box).hidden = true;
      if (st.linked) {
        $('[data-lb-name]', box).textContent = st.nickname;
        const h = $('.lb-head', box); h.src = `https://mc-heads.net/avatar/${encodeURIComponent(st.uuid)}/40`;
      }
    });
    const chip = $('[data-open-account]');
    if (chip) chip.innerHTML = st.linked ? '' : 'Привязать аккаунт';
    if (chip && st.linked) { const d = document.createElement('span'); d.className = 'chip-dot'; chip.append(d, document.createTextNode(st.nickname)); }
    const bf = $('[data-buy-for]'); if (bf) bf.textContent = st.linked ? `Покупка для: ${st.nickname}` : 'Для покупки привяжите Minecraft-аккаунт.';
  }
  function showCode(info, purpose) {
    $$('[data-linkbox]').forEach((box) => {
      $('[data-lb-form]', box).hidden = true; $('.lb-linked', box).hidden = true; $('[data-lb-code]', box).hidden = false;
      $('[data-lb-codehint]', box).textContent = purpose === 'unlink' ? `Подтвердите отвязку аккаунта ${info.nickname} — командой в игре:` : `Подтвердите, что вы — ${info.nickname}. Ваш код (10 минут):`;
      $('[data-lb-codevalue]', box).textContent = info.code;
      const cmd = `/donate confirm ${info.code}`; $('[data-lb-cmd]', box).textContent = cmd; $('[data-lb-copy]', box).dataset.copy = cmd;
    });
    poll(purpose);
  }
  function poll(purpose) {
    clearInterval(pollTimer); let n = 0;
    pollTimer = setInterval(async () => {
      if (++n > 200) return clearInterval(pollTimer);
      try {
        const st = await api('GET', '/api/link/status');
        if (!st.pending) {
          clearInterval(pollTimer); setLinked(st);
          const done = purpose === 'unlink' ? !st.linked : st.linked;
          msg(done ? (purpose === 'unlink' ? 'Аккаунт отвязан' : `Готово! Аккаунт ${st.nickname} привязан`) : 'Время подтверждения истекло — попробуйте снова', done ? 'ok' : 'err');
          if (done) toast(purpose === 'unlink' ? 'Аккаунт отвязан' : 'Аккаунт привязан');
          if (done && boot.product) location.reload();
        }
      } catch { /* повторим */ }
    }, 2500);
  }
  function msg(text, kind = '') { $$('[data-lb-msg]').forEach((m) => { m.textContent = text; m.className = 'lb-msg small ' + kind; }); }

  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('[data-lb-form]'); if (!f) return;
    e.preventDefault(); msg('');
    try { const info = await api('POST', '/api/link/start', { nickname: new FormData(f).get('nick') }); showCode(info, 'link'); } catch (err) { msg(err.message, 'err'); }
  });
  document.addEventListener('click', async (e) => {
    if (e.target.closest('[data-lb-unlink]')) {
      try { const info = await api('POST', '/api/link/unlink'); showCode(info, 'unlink'); } catch (err) { msg(err.message, 'err'); }
    }
    if (e.target.closest('[data-lb-cancel]')) { clearInterval(pollTimer); setLinked({ ...current, pending: null }); msg(''); }
  });
  // код хранится на сервере только в виде хэша, поэтому после перезагрузки выдаётся новый (форма снова доступна)
  const refreshLink = () => api('GET', '/api/link/status').then(setLinked).catch(() => {});
  window.noroshi.refreshLink = refreshLink; refreshLink();

  // ---------- покупка ----------
  const buybox = $('[data-buybox]');
  if (buybox) initBuy(buybox);
  async function initBuy(box) {
    const optsEl = $('[data-pay-opts]', box); const btn = $('[data-buy]', box); const out = $('[data-buy-msg]', box);
    if (!optsEl || !btn) return;
    let options = []; let sel = { provider: null, currency: null };
    try { options = (await api('GET', `/api/shop/options?product=${box.dataset.product}`)).options; } catch { /* */ }
    const money = (minor, cur) => `${(minor / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ${({ UAH: '₴', EUR: '€', USD: '$' })[cur] || cur}`;
    function draw() {
      optsEl.textContent = '';
      options.forEach((o) => {
        const label = document.createElement('label'); label.className = 'pay-opt';
        const r = document.createElement('input'); r.type = 'radio'; r.name = 'prov'; r.value = o.id; r.checked = sel.provider === o.id;
        r.addEventListener('change', () => { sel = { provider: o.id, currency: o.currencies.find((c) => c.code === 'UAH')?.code || o.currencies[0].code }; draw(); });
        const wrap = document.createElement('div');
        const t = document.createElement('div'); t.className = 't'; t.textContent = o.title;
        wrap.append(t);
        if (sel.provider === o.id) {
          const curs = document.createElement('div'); curs.className = 'pay-cur';
          o.currencies.forEach((c) => {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'cur' + (sel.currency === c.code ? ' active' : ''); b.textContent = money(c.amountMinor, c.code);
            b.addEventListener('click', (ev) => { ev.preventDefault(); sel.currency = c.code; draw(); }); curs.append(b);
          });
          const note = document.createElement('div'); note.className = 'small muted';
          const cur = o.currencies.find((c) => c.code === sel.currency);
          note.textContent = cur && cur.code !== 'UAH' ? `Курс зафиксирован при оформлении: 1 ${cur.code} = ${cur.rate.toFixed(2)} ₴` : (o.test ? 'Реальные деньги не списываются' : '');
          wrap.append(curs, note);
        }
        label.append(r, wrap); optsEl.append(label);
      });
    }
    if (options.length) { sel = { provider: options[0].id, currency: options[0].currencies.find((c) => c.code === 'UAH')?.code || options[0].currencies[0].code }; draw(); btn.disabled = false; }
    btn.addEventListener('click', async () => {
      out.textContent = ''; out.className = 'lb-msg small';
      if (!current.linked) { window.noroshi.openAccount(); return; }
      btn.disabled = true; btn.textContent = 'Создаём заказ…';
      try {
        const r = await api('POST', '/api/checkout', { productId: Number(box.dataset.product), provider: sel.provider, currency: sel.currency });
        location.href = r.url;
      } catch (err) {
        out.textContent = err.message; out.classList.add('err'); btn.disabled = false; btn.textContent = 'Купить';
        if (err.code === 'not_linked') window.noroshi.openAccount();
      }
    });
  }

  // ---------- страница заказа ----------
  const orderEl = $('[data-order]');
  if (orderEl) {
    const id = orderEl.dataset.order; const st = $('[data-order-state]'); const title = $('[data-order-title]'); const text = $('[data-order-text]');
    const view = {
      pending: ['⏳', 'Ожидаем подтверждение оплаты', 'Как только платёжная система подтвердит платёж, товар будет выдан автоматически. Страницу можно не закрывать.'],
      paid: ['✅', 'Оплата подтверждена', 'Передаём товар на сервер…'],
      delivered: ['🎉', 'Товар выдан!', 'Загляните в игру — всё уже на вашем аккаунте.'],
      failed: ['⚠️', 'Платёж не прошёл', 'Деньги не списаны либо будут возвращены банком. Попробуйте оформить заказ ещё раз.'],
      cancelled: ['⌛', 'Заказ отменён', 'Время ожидания оплаты истекло.'],
      refunded: ['↩️', 'Платёж возвращён', 'Средства возвращены покупателю.'],
      deliveryFailed: ['🛠️', 'Оплата получена, выдача задерживается', 'Администратор уже видит ошибку и выдаст товар вручную. Ничего оплачивать повторно не нужно.'],
    };
    let stopped = false;
    async function tick() {
      try {
        const r = await api('GET', `/api/orders/${id}`);
        const key = r.status === 'paid' ? (r.delivery === 'delivered' ? 'delivered' : r.delivery === 'failed' ? 'deliveryFailed' : 'paid') : r.status;
        const [i, t, d] = view[key] || view.pending; st.textContent = i; title.textContent = t; text.textContent = d;
        if (['delivered', 'failed', 'cancelled', 'refunded', 'deliveryFailed'].includes(key)) stopped = true;
      } catch { /* */ }
      if (!stopped) setTimeout(tick, 3000);
    }
    tick();
  }

  // ---------- тестовая оплата ----------
  $$('[data-testpay]').forEach((b) => b.addEventListener('click', async () => {
    const out = $('[data-testpay-msg]');
    try { await api('POST', `/api/test-pay/${boot.testPay}`, { result: b.dataset.testpay }); location.href = `/order/${boot.testPay}`; } catch (err) { out.textContent = err.message; out.classList.add('err'); }
  }));
})();

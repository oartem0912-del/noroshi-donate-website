// Вход владельца: кнопка-карандаш для неавторизованных открывает окно «почта → код».
(() => {
  'use strict';
  const { api } = window.noroshi;
  const h = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } e.append(...kids); return e; };
  let dlg;
  function build() {
    const msg = h('div', { class: 'lb-msg small', role: 'status' });
    const email = h('input', { class: 'input', type: 'email', placeholder: 'Почта владельца', autocomplete: 'email', required: '' });
    const code = h('input', { class: 'input', inputmode: 'numeric', placeholder: 'Код из письма', maxlength: '6', autocomplete: 'one-time-code' });
    const step2 = h('div', { class: 'row', hidden: '' }, code, h('button', { class: 'btn', type: 'submit' }, 'Войти'));
    const send = h('button', { class: 'btn', type: 'submit' }, 'Получить код');
    const step1 = h('div', { class: 'row' }, email, send);
    let stage = 1;
    const form = h('form', {}, h('p', { class: 'muted small' }, 'Вход только для владельцев сайта. Мы отправим одноразовый код на вашу почту.'), step1, step2, msg);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); msg.textContent = ''; msg.className = 'lb-msg small';
      try {
        if (stage === 1) {
          send.disabled = true; await api('POST', '/api/auth/owner/request', { email: email.value });
          stage = 2; step1.hidden = true; step2.hidden = false; code.focus(); msg.textContent = 'Если адрес входит в число владельцев, код отправлен.';
        } else {
          await api('POST', '/api/auth/owner/verify', { email: email.value, code: code.value });
          location.href = '/?edit=1';
        }
      } catch (err) { msg.textContent = err.message; msg.className = 'lb-msg small err'; send.disabled = false; }
    });
    dlg = h('dialog', { class: 'modal' }, h('div', { class: 'modal-head' }, h('h3', {}, 'Вход в панель'), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Закрыть', onclick: () => dlg.close() }, '✕')), form);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    document.body.append(dlg);
  }
  const open = () => { if (!dlg) build(); dlg.showModal(); };
  document.getElementById('pencil')?.addEventListener('click', open);
  if (new URLSearchParams(location.search).get('login')) open();
})();

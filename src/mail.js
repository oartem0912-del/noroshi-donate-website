// Минимальный SMTP-клиент без зависимостей (SMTPS :465 или STARTTLS :587, AUTH PLAIN/LOGIN).
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { config } from './config.js';
import { log } from './db.js';

/** Последние отправленные письма — используется только в тестах и dev-режиме. */
export const outbox = [];

class Conn {
  constructor(sock) { this.setSock(sock); }
  setSock(sock) {
    this.sock = sock; this.buf = ''; this.waiters = [];
    sock.setEncoding('utf8');
    sock.on('data', (d) => { this.buf += d; this.flush(); });
    sock.on('error', (e) => { this.err = e; this.flush(); });
    sock.on('close', () => { this.closed = true; this.flush(); });
  }
  flush() {
    while (this.waiters.length) {
      const res = this.tryParse();
      if (res) { this.waiters.shift().resolve(res); continue; }
      if (this.err || this.closed) { this.waiters.shift().reject(this.err || new Error('SMTP: соединение закрыто')); continue; }
      break;
    }
  }
  tryParse() {
    const lines = this.buf.split('\r\n');
    if (lines.length < 2) return null;
    const out = [];
    for (let i = 0; i < lines.length - 1; i++) {
      out.push(lines[i]);
      if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
        this.buf = lines.slice(i + 1).join('\r\n');
        return { code: parseInt(lines[i].slice(0, 3), 10), lines: out };
      }
    }
    return null;
  }
  read() { return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); this.flush(); }); }
  async cmd(line, expect) {
    if (line !== null) this.sock.write(line + '\r\n');
    const r = await this.read();
    if (expect && !expect.includes(r.code)) throw new Error(`SMTP ${r.code}: ${r.lines.join(' | ')}`);
    return r;
  }
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const wrap76 = (s) => s.replace(/(.{76})/g, '$1\r\n');
const bareAddr = (s) => (/<([^>]+)>/.exec(s) || [null, s])[1].trim();

export function buildMessage({ from, to, subject, text }) {
  const id = `<${crypto.randomUUID()}@${bareAddr(from).split('@')[1] || 'localhost'}>`;
  return [
    `From: ${from}`, `To: ${to}`, `Subject: =?UTF-8?B?${b64(subject)}?=`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${id}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
    wrap76(b64(text)), '',
  ].join('\r\n');
}

async function smtpSend({ to, subject, text }) {
  const c = config.smtp;
  const timeout = 20_000;
  const connect = () => new Promise((resolve, reject) => {
    const s = c.secure ? tls.connect({ host: c.host, port: c.port, servername: c.host }, () => resolve(s)) : net.connect({ host: c.host, port: c.port }, () => resolve(s));
    s.setTimeout(timeout, () => s.destroy(new Error('SMTP: таймаут')));
    s.once('error', reject);
  });
  const sock = await connect();
  const conn = new Conn(sock);
  try {
    await conn.cmd(null, [220]);
    let ehlo = await conn.cmd('EHLO noroshi-donate', [250]);
    if (!c.secure) {
      await conn.cmd('STARTTLS', [220]);
      const secured = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket: sock, servername: c.host }, () => resolve(t));
        t.once('error', reject);
      });
      conn.setSock(secured);
      ehlo = await conn.cmd('EHLO noroshi-donate', [250]);
    }
    if (c.user) {
      const caps = ehlo.lines.join(' ').toUpperCase();
      if (caps.includes('AUTH') && caps.includes('PLAIN')) {
        await conn.cmd('AUTH PLAIN ' + Buffer.from(`\0${c.user}\0${c.pass}`).toString('base64'), [235]);
      } else {
        await conn.cmd('AUTH LOGIN', [334]);
        await conn.cmd(b64(c.user), [334]);
        await conn.cmd(b64(c.pass), [235]);
      }
    }
    await conn.cmd(`MAIL FROM:<${bareAddr(c.from)}>`, [250]);
    await conn.cmd(`RCPT TO:<${to}>`, [250, 251]);
    await conn.cmd('DATA', [354]);
    await conn.cmd(buildMessage({ from: c.from, to, subject, text }) + '\r\n.', [250]);
    await conn.cmd('QUIT').catch(() => {});
  } finally { conn.sock.destroy(); }
}

export async function sendMail({ to, subject, text }) {
  outbox.push({ to, subject, text, at: Date.now() });
  if (outbox.length > 50) outbox.shift();
  if (!config.smtp.host) {
    if (config.production) throw new Error('SMTP не настроен');
    console.log(`\n[mail:dev] → ${to}\n  ${subject}\n  ${text.split('\n').join('\n  ')}\n`);
    return;
  }
  try { await smtpSend({ to, subject, text }); } catch (e) {
    log('error', 'mail', `Не удалось отправить письмо: ${e.message}`, { to });
    throw e;
  }
}

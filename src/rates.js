// Курсы валют: НБУ (официальный курс) или ручной курс владельца. Применённый курс фиксируется в заказе.
import { q, getSetting, log } from './db.js';
import { now } from './util.js';

const MAX_AGE_MS = 72 * 3600_000;
const NBU_URL = 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json';

export async function refreshRates() {
  try {
    const res = await fetch(NBU_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const list = await res.json();
    let n = 0;
    for (const it of list) {
      if (!['USD', 'EUR', 'PLN', 'GBP'].includes(it.cc) || !(it.rate > 0)) continue;
      q.run('INSERT INTO rates(currency, uah_per_unit, source, updated_at) VALUES(?,?,?,?) ON CONFLICT(currency) DO UPDATE SET uah_per_unit=excluded.uah_per_unit, source=excluded.source, updated_at=excluded.updated_at', it.cc, it.rate, 'NBU', now());
      n++;
    }
    log('info', 'rates', `Курсы НБУ обновлены (${n})`);
  } catch (e) { log('warn', 'rates', `Не удалось обновить курсы НБУ: ${e.message}`); }
}

/** Курс «гривен за 1 единицу валюты» или null, если курс недоступен/устарел. */
export function getRate(currency) {
  if (currency === 'UAH') return { rate: 1, source: 'fixed' };
  const manual = getSetting('manualRates', {})[currency];
  if (manual > 0) return { rate: Number(manual), source: 'manual' };
  const row = q.get('SELECT * FROM rates WHERE currency = ?', currency);
  if (row && now() - row.updated_at < MAX_AGE_MS) return { rate: row.uah_per_unit, source: row.source };
  return null;
}

/** Сумма в минимальных единицах валюты для цены в копейках; округление вверх до цента. */
export const convertKop = (kop, rate) => Math.ceil(kop / rate - 1e-9);

export const listRates = () => ({
  USD: getRate('USD'), EUR: getRate('EUR'),
});

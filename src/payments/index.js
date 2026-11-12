import { config } from '../config.js';
import { liqpay } from './liqpay.js';

/** Тестовый провайдер: оплата подтверждается кнопкой на /pay/test/:id (идёт через тот же путь обработки событий). */
export const testProvider = {
  id: 'test', title: 'Тестовая оплата (без реальных денег)', methods: ['Тест'], currencies: ['UAH', 'USD', 'EUR'], test: true,
  isConfigured: () => config.payments.testEnabled,
};

export const providers = { liqpay, test: testProvider };

/** Провайдеры, включённые и в окружении (ключи), и в настройках владельца. */
export function enabledProviders(settings) {
  return Object.values(providers).filter((p) => p.isConfigured() && settings.providers?.[p.id] !== false);
}

/*
 * Как добавить провайдера (например, криптоплатежи):
 *  1. создайте src/payments/<name>.js с полями id, title, methods, currencies, isConfigured();
 *  2. реализуйте checkoutForm()/redirect и parseWebhook() с проверкой подписи;
 *  3. зарегистрируйте его в объекте providers выше и добавьте маршрут /api/webhooks/<name>
 *     (см. src/routes/webhooks.js) — вызывайте processPaymentEvent().
 * Не включайте провайдера и валюту, пока их доступность не подтверждена провайдером (раздел 9–10 ТЗ).
 */

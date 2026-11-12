# API сайт ↔ плагин

Все запросы плагина подписываются общим секретом `PLUGIN_SECRET` (HMAC-SHA256). Используйте HTTPS.

## Заголовки запроса
| Заголовок | Значение |
|---|---|
| `X-Noroshi-Server` | имя сервера (произвольное, для журнала) |
| `X-Noroshi-Timestamp` | Unix-время, секунды (допустимое расхождение 60 с) |
| `X-Noroshi-Nonce` | случайная строка 12–64 символа, **уникальная** для каждого запроса |
| `X-Noroshi-Signature` | hex(HMAC-SHA256(secret, canonical)) |

```
canonical = timestamp + "\n" + nonce + "\n" + METHOD + "\n" + path_with_query + "\n" + hex(sha256(body))
```
`body` — точные байты тела (для GET — пустая строка).

## Подпись ответа
Заголовки `X-Noroshi-Response-Timestamp` и `X-Noroshi-Response-Signature`:
`hex(HMAC-SHA256(secret, nonce + "\n" + response_timestamp + "\n" + hex(sha256(response_body))))`.
Плагин **обязан** проверять её: ответ с командами выдачи от неподлинного сервера недопустим.

## Эндпоинты
### `POST /api/plugin/heartbeat`
`{"server":{"version":"1.21.8"},"online":3,"max":100,"players":["Steve"]}` → `{"ok":true,"pending":N}`.
Сайт показывает онлайн из этого сигнала.

### `GET /api/plugin/orders?limit=20`
Возвращает оплаченные заказы в очереди и берёт их в аренду на 120 с (если плагин не ответил — заказ вернётся в очередь):
```json
{"ok":true,"orders":[{"id":"ord_…","attempt":1,"productName":"VIP","player":{"uuid":"…","name":"Steve"},
  "commands":["lp user %player% parent add vip"],"requireOnline":true}]}
```
### `POST /api/plugin/orders/{id}/result`
`{"attempt":1,"status":"delivered|failed","message":"…"}`. Идемпотентно: повтор для выданного заказа → `{"ok":true,"duplicate":true}`;
устаревшая `attempt` игнорируется. Ключ идемпотентности выдачи на стороне плагина — `id + attempt`.
Повтор выдачи владельцем увеличивает `attempt`.

### `POST /api/plugin/link/confirm`
`{"code":"AB12CD34","uuid":"…","name":"Steve"}` — игрок ввёл `/donate confirm КОД`. Ответ: `{"ok":true,"purpose":"link|unlink"}` либо
`{"ok":false,"error":"bad_code|wrong_nick|wrong_owner","message":"…"}`.

## Платёжные уведомления
`POST /api/webhooks/liqpay` (form-urlencoded `data`, `signature`): подпись `base64(sha1(private + data + private))`, проверка суммы и валюты
заказа, идемпотентность по `payment_id:status`.

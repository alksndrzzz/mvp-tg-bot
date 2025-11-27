# Интеграция уведомлений о новом маршруте в боте

## Обзор

Когда администратор создает новый маршрут для водителя через админ-панель, бот автоматически отправляет уведомление водителю в Telegram через **webhook endpoint**. Админ-панель отправляет POST запрос на `/api/bot/notify` после создания нового маршрута.

## Что происходит в админ-панели

При создании нового маршрута через админ-панель:
1. Вызывается функция `createNewRoute(driverId, reminderStartDate, reminderEndDate)`
2. В БД обновляется запись водителя:
   - `route_status` устанавливается в `'not-started-yet'`
   - `is_active` устанавливается в `false`
   - `reminder_start_date` устанавливается в новую дату начала
   - `reminder_end_date` устанавливается в новую дату окончания
   - `last_reminded_date` сбрасывается в `null`
3. **Автоматически отправляется webhook в бот** для немедленного уведомления водителя

## Реализация в админ-панели

Админ-панель автоматически отправляет webhook в бот после создания нового маршрута:

```typescript
// app/api/drivers/[id]/route.ts
const driver = await db.createNewRoute(driverId, reminderStartDate, reminderEndDate);

// Отправляем уведомление водителю через webhook бота
notifyBotAboutNewRoute({
  type: 'new_route',
  driverId: driver.id,
  telegramChatId: driver.telegram_chat_id,
  reminderStartDate: driver.reminder_start_date,
  reminderEndDate: driver.reminder_end_date,
  driverName: driver.name,
});
```

Функция `notifyBotAboutNewRoute()` находится в `lib/bot-webhook.js` и отправляет POST запрос на URL, указанный в переменной окружения `BOT_WEBHOOK_URL`.

**Примечание:** Функция также поддерживает обратную совместимость - можно передать объект `driver` напрямую, и функция автоматически извлечет нужные поля.

## Реализация в боте

### Webhook endpoint

Бот уже имеет реализованный endpoint `/api/bot/notify` для получения уведомлений от админ-панели.

**Формат запроса от админ-панели:**

```json
POST /api/bot/notify
Content-Type: application/json

{
  "type": "new_route",
  "driverId": "uuid-водителя",
  "telegramChatId": 123456789,
  "reminderStartDate": "2024-12-15",
  "reminderEndDate": "2024-12-25",
  "driverName": "Имя Водителя"
}
```

**Ответ бота:**

```json
{
  "success": true,
  "message": "Notification sent"
}
```

**Обработка ошибок:**

- `400` - Неверный тип уведомления или отсутствуют обязательные поля
- `403` - Пользователь заблокировал бота
- `404` - Водитель не найден
- `500` - Внутренняя ошибка сервера

### Настройка переменных окружения

В админ-панели нужно добавить переменную окружения:

```bash
# .env.local или .env
BOT_WEBHOOK_URL=http://localhost:3000/api/bot/notify
# Или для продакшена (Railway):
# BOT_WEBHOOK_URL=https://your-bot-service.railway.app/api/bot/notify
```

**Важно:** URL должен быть доступен из админ-панели. В Railway порт определяется автоматически через переменную `PORT`.

### Логика определения нового маршрута

Функция `isNewRoute(driver)` проверяет следующие условия:

1. `route_status === 'not-started-yet'`
2. Установлены даты:
   - `reminder_start_date` и `reminder_end_date` (основные, используются админ-панелью)
   - ИЛИ `journey_start_date` и `journey_end_date` (fallback для обратной совместимости)
3. `telegram_chat_id` установлен (водитель был активирован ранее)
4. `last_reminded_date === null` (сброшен при создании нового маршрута)

Если все условия выполнены, бот отправляет уведомление и обновляет `last_reminded_date`, чтобы не отправлять повторно.

## Реализация webhook endpoint в боте

Бот использует Express.js для создания HTTP сервера с endpoint `/api/bot/notify`:

```javascript
// В bot.js
const express = require('express');

function setupWebhookServer() {
  const app = express();
  app.use(express.json());
  
  app.post('/api/bot/notify', async (req, res) => {
    const { type, driverId, telegramChatId, reminderStartDate, reminderEndDate, driverName } = req.body;
    
    // Проверка типа уведомления
    if (type !== 'new_route') {
      return res.status(400).json({ error: 'Invalid notification type' });
    }
    
    // Получение данных водителя и отправка уведомления
    const driver = await db.getDriver(driverId);
    if (db.isNewRoute(driver)) {
      await sendNewRouteNotification(driver);
      await db.markRemindedToday(telegramChatId);
    }
    
    res.json({ success: true });
  });
  
  const PORT = process.env.PORT || 3000;
  app.listen(PORT);
}
```

**Преимущества:**
- Мгновенное уведомление при создании нового маршрута
- Надежная доставка через HTTP
- Простая интеграция с админ-панелью
- Не требует постоянного подключения к Realtime

## Рекомендации

1. **Использовать webhook для мгновенных уведомлений** - админ-панель отправляет webhook сразу после создания маршрута
2. **Отправлять уведомление только один раз** - использовать `last_reminded_date` для отслеживания
3. **Обрабатывать ошибки** - если водитель заблокировал бота (код 403), не пытаться отправлять повторно
4. **Форматировать даты понятно** - использовать формат ДД.ММ.ГГГГ для русскоязычных пользователей
5. **Проверять валидность данных** - убедиться, что все обязательные поля присутствуют в запросе

## Текущая реализация

Бот уже имеет полную реализацию webhook endpoint в функции `setupWebhookServer()` в файле `bot.js`:

- ✅ HTTP сервер на Express.js
- ✅ Endpoint `/api/bot/notify` для получения уведомлений
- ✅ Проверка типа уведомления и обязательных полей
- ✅ Валидация данных водителя через `isNewRoute()`
- ✅ Отправка уведомления водителю через Telegram
- ✅ Обновление `last_reminded_date` для предотвращения повторных уведомлений
- ✅ Обработка ошибок (403, 404, 500)
- ✅ Health check endpoint `/health`

## Что нужно сделать в админ-панели

1. После создания нового маршрута вызвать функцию `notifyBotAboutNewRoute()` из `lib/bot-webhook.js`
2. Убедиться, что переменная окружения `BOT_WEBHOOK_URL` установлена и указывает на правильный URL бота
3. Отправить POST запрос с данными о новом маршруте

**Пример вызова из админ-панели:**

```typescript
// После создания нового маршрута
const driver = await db.createNewRoute(driverId, reminderStartDate, reminderEndDate);

// Отправляем webhook в бот
await notifyBotAboutNewRoute({
  type: 'new_route',
  driverId: driver.id,
  telegramChatId: driver.telegram_chat_id,
  reminderStartDate: driver.reminder_start_date,
  reminderEndDate: driver.reminder_end_date,
  driverName: driver.name
});
```


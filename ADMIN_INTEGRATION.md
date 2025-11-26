# Интеграция с админ-панелью: Управление датами поездок и уведомлениями

## Обзор изменений

Бот был обновлен для упрощения управления датами поездок. Вместо `reminder_start_date` и `reminder_end_date` теперь используются `journey_start_date` и `journey_end_date`. Добавлена автоматическая остановка маршрутов при истечении даты и механизм отслеживания поездок, которые заканчиваются скоро.

**Новое:** Система автоматических email уведомлений через Resend и поддержка адаптивного часового пояса админа.

## Изменения в структуре базы данных

### Таблица `drivers`

Добавлены новые поля:
- `journey_start_date` (DATE, nullable) - дата начала поездки
- `journey_end_date` (DATE, nullable) - дата окончания поездки

**Важно:** Старые поля `reminder_start_date` и `reminder_end_date` сохранены для обратной совместимости, но рекомендуется использовать новые поля.

### Таблица `users`

Добавлено новое поле:
- `timezone` (TEXT, nullable, default: 'Europe/Vilnius') - часовой пояс администратора для корректного отображения дат и времени

### Таблица `journey_notifications`

Новая таблица для отслеживания отправленных уведомлений:

```sql
CREATE TABLE journey_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL CHECK (notification_type IN ('ending_soon', 'ended')),
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
```

**Поля:**
- `id` - уникальный идентификатор
- `driver_id` - ID водителя
- `notification_type` - тип уведомления: `'ending_soon'` (заканчивается скоро) или `'ended'` (закончилась)
- `sent_at` - когда уведомление было создано (для админки - когда отправлено email)
- `created_at` - когда запись была создана

**Индексы:**
- `idx_journey_notifications_driver_id` - на `driver_id`
- `idx_journey_notifications_type` - на `notification_type`
- `idx_journey_notifications_driver_type` - составной на `(driver_id, notification_type)`

## Логика работы

### Определение "ending soon"

Поездка считается "заканчивающейся скоро", если:
- `journey_end_date` наступает **через 1 день** от текущей даты **в часовом поясе админа**
- `route_status != 'stopped'`

**Важно:** Все даты и время теперь учитывают часовой пояс администратора, указанный в поле `timezone` таблицы `users`.

### Автоматическая остановка маршрутов

Маршрут автоматически останавливается, если:
- `journey_end_date < CURRENT_DATE` (дата прошла)
- `route_status != 'stopped'` (маршрут еще не остановлен)

При остановке:
- `route_status` устанавливается в `'stopped'`
- `is_active` устанавливается в `false`
- Создается запись в `journey_notifications` с типом `'ended'`

## Автоматические email уведомления через Resend

### Настройка

1. **Установите переменные окружения:**
   - `RESEND_API_KEY` - API ключ Resend (получите на https://resend.com)
   - `ADMIN_EMAIL` - email адрес администратора для получения уведомлений
   - `RESEND_FROM_EMAIL` - email адрес отправителя (опционально, по умолчанию используется 'onboarding@resend.dev')
   - `NEXT_PUBLIC_APP_URL` - URL админ-панели для ссылок в email (опционально)

2. **Настройте часовой пояс админа:**
   - Откройте страницу настроек в админ-панели: `/dashboard/settings`
   - Выберите часовой пояс из списка
   - Нажмите "Сохранить настройки"
   - Или обновите поле `timezone` в таблице `users` для пользователя с ролью `admin` напрямую в БД
   - Используйте формат IANA timezone (например, 'Europe/Moscow', 'America/New_York', 'Asia/Tokyo')
   - По умолчанию используется 'Europe/Vilnius'

### Автоматическая отправка уведомлений

Система автоматически отправляет email уведомления админу о поездках, которые заканчиваются скоро:

1. **Cron job** (настроен в `vercel.json`) вызывает `/api/notifications/check` ежедневно в 08:00 по UTC
2. **API endpoint** проверяет водителей с `journey_end_date = завтра` (в часовом поясе админа)
3. **Для каждого водителя** без отправленного уведомления:
   - Отправляется email через Resend
   - Создается запись в `journey_notifications` с типом `'ending_soon'`

### Формат email уведомления

Email содержит:
- Имя водителя
- Номер телефона (если указан)
- Дата окончания поездки
- Статус маршрута
- Количество дней до окончания
- Прямая ссылка на страницу водителя в админ-панели

### Ручная проверка уведомлений

Вы можете вручную вызвать проверку уведомлений:

```bash
curl -X GET https://your-app-url.com/api/notifications/check \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Или через браузер (требуется авторизация):
```
GET /api/notifications/check
```

## API для админки

### Получение поездок, которые заканчиваются скоро

**Через Supabase Client (JavaScript/TypeScript):**

```javascript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Получить водителей, у которых поездка заканчивается через 1 день
async function getJourneysEndingSoon() {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .eq('journey_end_date', tomorrowStr)
    .neq('route_status', 'stopped');
  
  if (error) {
    console.error('Error:', error);
    return [];
  }
  
  return data || [];
}
```

**Через SQL (если используете прямой доступ к БД):**

```sql
SELECT 
  d.*,
  (d.journey_end_date - CURRENT_DATE)::integer as days_remaining
FROM drivers d
WHERE d.journey_end_date = CURRENT_DATE + INTERVAL '1 day'
  AND d.route_status != 'stopped';
```

### Получение непрочитанных уведомлений "ending soon"

```javascript
async function getUnreadEndingSoonNotifications() {
  // Получаем водителей с ending soon
  const endingSoonDrivers = await getJourneysEndingSoon();
  
  // Фильтруем тех, для кого еще не отправлено уведомление
  const unread = [];
  
  for (const driver of endingSoonDrivers) {
    const { data } = await supabase
      .from('journey_notifications')
      .select('*')
      .eq('driver_id', driver.id)
      .eq('notification_type', 'ending_soon')
      .maybeSingle();
    
    if (!data) {
      unread.push(driver);
    }
  }
  
  return unread;
}
```

### Получение непрочитанных уведомлений "ended"

```javascript
async function getUnreadEndedNotifications() {
  const today = new Date().toISOString().slice(0, 10);
  
  // Получаем водителей с истекшей датой
  const { data: expiredDrivers } = await supabase
    .from('drivers')
    .select('*')
    .not('journey_end_date', 'is', null)
    .lt('journey_end_date', today)
    .neq('route_status', 'stopped');
  
  if (!expiredDrivers) return [];
  
  // Фильтруем тех, для кого еще не отправлено уведомление
  const unread = [];
  
  for (const driver of expiredDrivers) {
    const { data } = await supabase
      .from('journey_notifications')
      .select('*')
      .eq('driver_id', driver.id)
      .eq('notification_type', 'ended')
      .maybeSingle();
    
    if (!data) {
      unread.push(driver);
    }
  }
  
  return unread;
}
```

### Отметить уведомление как отправленное

После отправки email уведомления админу, обновите запись в `journey_notifications`:

```javascript
async function markNotificationSent(driverId, notificationType) {
  // Проверяем, существует ли запись
  const { data: existing } = await supabase
    .from('journey_notifications')
    .select('*')
    .eq('driver_id', driverId)
    .eq('notification_type', notificationType)
    .maybeSingle();
  
  if (existing) {
    // Обновляем sent_at
    const { error } = await supabase
      .from('journey_notifications')
      .update({ sent_at: new Date().toISOString() })
      .eq('id', existing.id);
    
    if (error) {
      console.error('Error updating notification:', error);
    }
  } else {
    // Создаем новую запись
    const { error } = await supabase
      .from('journey_notifications')
      .insert({
        driver_id: driverId,
        notification_type: notificationType,
        sent_at: new Date().toISOString()
      });
    
    if (error) {
      console.error('Error creating notification:', error);
    }
  }
}
```

## Рекомендуемый workflow для админки

### 1. Создание водителя

При создании водителя в админке:
- Установите `journey_start_date` - дата начала поездки
- Установите `journey_end_date` - дата окончания поездки
- `route_status` по умолчанию: `'not-started-yet'`
- `is_active` по умолчанию: `false`

**Пример:**

```javascript
const { data, error } = await supabase
  .from('drivers')
  .insert({
    name: 'Иван Иванов',
    token: generateToken(), // сгенерируйте уникальный токен
    journey_start_date: '2024-12-01',
    journey_end_date: '2024-12-10',
    route_status: 'not-started-yet',
    is_active: false
  });
```

### 2. Автоматическая проверка уведомлений

**Настроено автоматически через Vercel Cron Jobs:**

- Cron job настроен в `vercel.json` и вызывает `/api/notifications/check` ежедневно в 08:00 UTC
- API endpoint автоматически:
  - Получает часовой пояс админа из БД
  - Вычисляет завтрашнюю дату в часовом поясе админа
  - Находит водителей с `journey_end_date = завтра`
  - Отправляет email уведомления через Resend для тех, кому еще не отправляли
  - Создает записи в `journey_notifications`

**Если не используете Vercel:**

Настройте внешний cron сервис (например, cron-job.org) для вызова:
```
GET https://your-app-url.com/api/notifications/check
```

**Важно:** Бот автоматически создает записи в `journey_notifications` для завершенных маршрутов, но email уведомления отправляются только через админку.

### 3. Часовой пояс админа

Все даты и время в админ-панели отображаются в часовом поясе администратора:

- **Настройка:** Обновите поле `timezone` в таблице `users` для пользователя с ролью `admin`
- **Формат:** Используйте IANA timezone (например, 'Europe/Moscow', 'America/New_York')
- **По умолчанию:** 'Europe/Vilnius'
- **Применение:** 
  - Отображение дат в интерфейсе
  - Проверка уведомлений (завтрашняя дата вычисляется в часовом поясе админа)
  - Форматирование времени локаций

**Пример обновления часового пояса:**

```sql
UPDATE users 
SET timezone = 'Europe/Moscow' 
WHERE role = 'admin' 
LIMIT 1;
```

### 4. Отправка email уведомлений (устаревший способ)

**Примечание:** Email уведомления теперь отправляются автоматически через `/api/notifications/check`. Этот раздел оставлен для справки.

Пример функции для отправки email (используется внутри системы):

```javascript
async function sendJourneyNotificationEmail(driver, notificationType) {
  let subject, body;
  
  if (notificationType === 'ending_soon') {
    const daysRemaining = Math.ceil(
      (new Date(driver.journey_end_date) - new Date()) / (1000 * 60 * 60 * 24)
    );
    
    subject = `Поездка водителя ${driver.name} заканчивается скоро`;
    body = `
      Поездка водителя ${driver.name} заканчивается через ${daysRemaining} день(дней).
      Дата окончания: ${driver.journey_end_date}
    `;
  } else if (notificationType === 'ended') {
    subject = `Поездка водителя ${driver.name} завершена`;
    body = `
      Поездка водителя ${driver.name} автоматически завершена.
      Дата окончания: ${driver.journey_end_date}
      Маршрут был автоматически остановлен ботом.
    `;
  }
  
  // Отправьте email через ваш email сервис (SendGrid, AWS SES, и т.д.)
  await sendEmail(ADMIN_EMAIL, subject, body);
  
  // Отметьте уведомление как отправленное
  await markNotificationSent(driver.id, notificationType);
}
```

## Примеры SQL запросов

### Получить все активные поездки с информацией о днях до окончания

```sql
SELECT 
  d.id,
  d.name,
  d.journey_start_date,
  d.journey_end_date,
  (d.journey_end_date - CURRENT_DATE)::integer as days_remaining,
  d.route_status,
  d.is_active,
  CASE 
    WHEN d.journey_end_date = CURRENT_DATE + INTERVAL '1 day' THEN true
    ELSE false
  END as is_ending_soon
FROM drivers d
WHERE d.journey_end_date IS NOT NULL
  AND d.journey_end_date >= CURRENT_DATE
  AND d.route_status != 'stopped'
ORDER BY d.journey_end_date ASC;
```

### Получить поездки, которые заканчиваются скоро (для уведомлений)

```sql
SELECT 
  d.*,
  (d.journey_end_date - CURRENT_DATE)::integer as days_remaining
FROM drivers d
LEFT JOIN journey_notifications jn ON 
  jn.driver_id = d.id 
  AND jn.notification_type = 'ending_soon'
WHERE d.journey_end_date = CURRENT_DATE + INTERVAL '1 day'
  AND d.route_status != 'stopped'
  AND jn.id IS NULL; -- только те, для которых еще не отправлено уведомление
```

### Получить поездки, которые уже закончились (для уведомлений)

```sql
SELECT 
  d.*,
  (CURRENT_DATE - d.journey_end_date)::integer as days_passed
FROM drivers d
LEFT JOIN journey_notifications jn ON 
  jn.driver_id = d.id 
  AND jn.notification_type = 'ended'
WHERE d.journey_end_date < CURRENT_DATE
  AND d.route_status != 'stopped'
  AND jn.id IS NULL; -- только те, для которых еще не отправлено уведомление
```

## Важные замечания

1. **Автоматическая остановка:** Бот автоматически останавливает маршруты с истекшей `journey_end_date` каждый день в 00:00. Вам не нужно делать это вручную в админке.

2. **Уведомления:** Бот создает записи в `journey_notifications`, но не отправляет email. Админка должна проверять эту таблицу и отправлять email уведомления.

3. **Обратная совместимость:** Старые поля `reminder_start_date` и `reminder_end_date` сохранены. Бот использует `journey_start_date`/`journey_end_date`, если они есть, иначе fallback на старые поля.

4. **RLS (Row Level Security):** Убедитесь, что в админке используется `service_role` ключ Supabase для доступа к таблицам, или настройте соответствующие RLS политики.

5. **Часовой пояс:** Все даты хранятся в формате DATE (без времени). Система автоматически учитывает часовой пояс администратора из поля `timezone` таблицы `users`. Все даты и время отображаются в этом часовом поясе.

6. **Resend:** Для работы email уведомлений требуется настройка Resend API ключа и email адресов (см. раздел "Автоматические email уведомления через Resend").

## Тестирование

После интеграции проверьте:

1. ✅ Создание водителя с `journey_start_date` и `journey_end_date`
2. ✅ Получение списка поездок, которые заканчиваются скоро
3. ✅ Автоматическая отправка email уведомлений через Resend
4. ✅ Автоматическая остановка маршрутов при истечении даты
5. ✅ Отслеживание отправленных уведомлений в `journey_notifications`
6. ✅ Корректное отображение дат и времени в часовом поясе админа
7. ✅ Настройка часового пояса админа в таблице `users`
8. ✅ Работа cron job для автоматической проверки уведомлений

## Переменные окружения

Необходимые переменные окружения для работы системы:

```bash
# Resend для email уведомлений
RESEND_API_KEY=re_xxxxxxxxxxxxx
ADMIN_EMAIL=admin@example.com
RESEND_FROM_EMAIL=noreply@example.com  # Опционально

# URL админ-панели для ссылок в email
NEXT_PUBLIC_APP_URL=https://your-app-url.com  # Опционально

# Supabase (уже должны быть настроены)
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=xxxxx
```

## Структура файлов

Новые файлы, добавленные для системы уведомлений:

- `lib/email.js` - утилита для отправки email через Resend
- `lib/timezone.js` - серверные утилиты для работы с часовыми поясами
- `lib/timezone-client.js` - клиентские утилиты для работы с часовыми поясами
- `app/api/notifications/check/route.ts` - API endpoint для проверки и отправки уведомлений
- `app/api/timezone/route.ts` - API endpoint для получения часового пояса админа
- `app/api/settings/timezone/route.ts` - API endpoint для обновления часового пояса админа
- `app/dashboard/settings/page.tsx` - страница настроек админа
- `components/SettingsClient.tsx` - компонент настроек с выбором часового пояса
- `vercel.json` - конфигурация cron job для автоматической проверки

## Инструкции для доработки бота

### Важные изменения в админ-панели

1. **Статус маршрута меняется автоматически**
   - В админ-панели убрана секция "Управление маршрутом" с кнопкой "Возобновить маршрут"
   - Статус маршрута (`route_status`) должен меняться автоматически в зависимости от действий водителя:
     - `'not-started-yet'` - водитель еще не начал маршрут (не отправил ни одной локации)
     - `'in-progress'` - водитель в поездке (отправляет локации)
     - `'stopped'` - водитель завершил маршрут (нажал кнопку "✅ Маршрут завершён" в боте)
   - **Бот должен обновлять `route_status` автоматически**, не требуется ручное управление из админки

2. **Поле `is_active` больше не используется в интерфейсе**
   - Поле `is_active` скрыто из интерфейса админ-панели
   - Бот может продолжать использовать это поле для внутренней логики, но оно не отображается админу
   - Рекомендуется синхронизировать `is_active` с `route_status`:
     - `is_active = true` когда `route_status = 'in-progress'`
     - `is_active = false` когда `route_status = 'not-started-yet'` или `route_status = 'stopped'`

3. **Использование `journey_start_date` и `journey_end_date`**
   - Админ-панель теперь использует `journey_start_date` и `journey_end_date` вместо `reminder_start_date` и `reminder_end_date`
   - **Бот должен использовать `journey_start_date` и `journey_end_date`** для определения дат поездки
   - Старые поля `reminder_start_date` и `reminder_end_date` сохранены для обратной совместимости, но не используются в новом интерфейсе
   - При создании водителя в админке устанавливаются `journey_start_date` и `journey_end_date`
   - Админ может изменять эти даты вручную или продлевать маршрут на 7/14/30 дней

4. **Настройка часового пояса**
   - Часовой пояс настраивается через страницу настроек в админ-панели (`/dashboard/settings`)
   - Бот должен учитывать часовой пояс админа при работе с датами
   - Для получения часового пояса админа используйте SQL запрос:
     ```sql
     SELECT timezone FROM users WHERE role = 'admin' LIMIT 1;
     ```
   - По умолчанию используется 'Europe/Vilnius'

### Что нужно обновить в боте

1. **Обновить логику изменения статуса маршрута:**
   ```javascript
   // При первой отправке локации водителем
   if (firstLocation) {
     await updateDriver(driverId, {
       route_status: 'in-progress',
       is_active: true
     });
   }
   
   // При нажатии кнопки "✅ Маршрут завершён"
   await updateDriver(driverId, {
     route_status: 'stopped',
     is_active: false
   });
   ```

2. **Использовать `journey_start_date` и `journey_end_date`:**
   ```javascript
   // Проверка даты окончания маршрута
   const driver = await getDriver(driverId);
   if (driver.journey_end_date && new Date(driver.journey_end_date) < new Date()) {
     // Маршрут истек, автоматически остановить
     await updateDriver(driverId, {
       route_status: 'stopped',
       is_active: false
     });
   }
   ```

3. **Убрать логику ручного возобновления маршрута:**
   - Удалите обработку команды или кнопки для возобновления маршрута из админки
   - Статус должен меняться только автоматически на основе действий водителя

4. **Учесть часовой пояс админа:**
   ```javascript
   // Получить часовой пояс админа
   const adminTimezone = await getAdminTimezone(); // 'Europe/Moscow' и т.д.
   
   // Использовать для работы с датами
   const today = new Date().toLocaleDateString('en-CA', { timeZone: adminTimezone });
   ```

### API endpoints для работы с датами маршрута

Админ-панель использует следующие endpoints:

- `PUT /api/drivers/[id]` с телом:
  ```json
  {
    "journeyStartDate": "2024-12-01",
    "journeyEndDate": "2024-12-10"
  }
  ```
  
- `PUT /api/drivers/[id]` с телом для продления:
  ```json
  {
    "extendRoute": 7  // продлить на 7 дней
  }
  ```

Бот должен читать эти поля из таблицы `drivers` напрямую через Supabase.


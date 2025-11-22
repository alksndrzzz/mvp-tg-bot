# Инструкция по деплою бота на Railway

## Подготовка

1. **Убедитесь, что код закоммичен в Git**
   ```bash
   cd mvp-tg-bot
   git add .
   git commit -m "Prepare for deployment"
   git push
   ```

2. **Создайте репозиторий на GitHub** (если еще нет)
   - Зайдите на [github.com](https://github.com)
   - Создайте новый репозиторий `mvp-tg-bot`
   - Запушьте код

## Деплой на Railway

### Шаг 1: Регистрация

1. Зайдите на [railway.app](https://railway.app)
2. Нажмите "Start a New Project"
3. Войдите через GitHub

### Шаг 2: Создание проекта

1. Нажмите "New Project"
2. Выберите "Deploy from GitHub repo"
3. Выберите репозиторий `mvp-tg-bot`

### Шаг 3: Настройка переменных окружения

1. В настройках проекта найдите раздел "Variables"
2. Добавьте все переменные из `.env.example`:

   ```
   BOT_TOKEN=your_telegram_bot_token
   ADMIN_CHAT_ID=your_admin_chat_id
   SUPABASE_URL=https://fbyjqfsqpwyjkzhscpkg.supabase.co
   SUPABASE_ANON_KEY=your_supabase_anon_key
   TZ=Europe/Vilnius
   ```

   **Где взять значения:**
   - `BOT_TOKEN` - получите у [@BotFather](https://t.me/BotFather) в Telegram
   - `ADMIN_CHAT_ID` - ваш chat.id (получите через команду `/whoami` после первого запуска)
   - `SUPABASE_URL` и `SUPABASE_ANON_KEY` - из Supabase Dashboard → Settings → API (те же, что в админке)

### Шаг 4: Настройка запуска

1. В настройках проекта найдите "Settings" → "Deploy"
2. Убедитесь, что:
   - **Start Command**: `npm start` (или оставьте по умолчанию)
   - Railway автоматически определит Node.js проект

### Шаг 5: Деплой

1. Railway автоматически задеплоит проект после добавления переменных
2. Проверьте логи в разделе "Deployments"
3. Должно появиться: `Bot started (long polling)…`

## Проверка работы

1. Отправьте боту команду `/whoami` - он должен вернуть ваш chat.id
2. Отправьте команду `/testadmin` - если настроен ADMIN_CHAT_ID, должно прийти сообщение
3. Попробуйте перейти по ссылке с токеном водителя - должно прийти приветственное сообщение

## Мониторинг

- **Логи**: Доступны в разделе "Deployments" → выберите последний деплой → "View Logs"
- **Метрики**: Railway показывает использование CPU, памяти, сети

## Обновление бота

1. Внесите изменения в код
2. Закоммитьте и запушьте в репозиторий:
   ```bash
   git add .
   git commit -m "Your changes"
   git push
   ```
3. Railway автоматически задеплоит обновления

## Важные замечания

- ⚠️ **Используется та же база данных Supabase**, что и в админке
- Бот работает 24/7 на Railway (не serverless)
- Cron задачи выполняются автоматически каждый день в 9:00 по указанному часовому поясу
- При изменении переменных окружения Railway автоматически перезапустит бота

## Troubleshooting

### Бот не запускается

- Проверьте логи в Railway
- Убедитесь, что все переменные окружения установлены
- Проверьте, что `BOT_TOKEN` правильный

### Cron задачи не работают

- Проверьте переменную `TZ` (должна быть правильная таймзона)
- Проверьте логи в Railway в момент выполнения (9:00 по TZ)

### Ошибки подключения к Supabase

- Проверьте `SUPABASE_URL` и `SUPABASE_ANON_KEY`
- Убедитесь, что они совпадают с теми, что используются в админке

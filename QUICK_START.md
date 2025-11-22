# Быстрый старт

## 1. Установка

```bash
cd mvp-tg-bot
npm install
```

## 2. Настройка

Скопируйте `.env.example` в `.env` и заполните:

```bash
cp .env.example .env
nano .env  # или используйте любой редактор
```

Заполните переменные:
- `BOT_TOKEN` - токен бота от @BotFather
- `ADMIN_CHAT_ID` - ваш chat.id (получите через `/whoami` после первого запуска)
- `SUPABASE_URL` и `SUPABASE_ANON_KEY` - из Supabase Dashboard

## 3. Запуск локально

```bash
npm start
```

Должно появиться: `Bot started (long polling)…`

## 4. Проверка

Отправьте боту `/whoami` - он вернет ваш chat.id.

## 5. Деплой

См. [DEPLOY.md](./DEPLOY.md) для подробных инструкций.

**Рекомендуется:** Railway (самый простой способ)


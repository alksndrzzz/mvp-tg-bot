// Загружаем .env только если файл существует (для локальной разработки)
// В Railway переменные окружения уже доступны через process.env
require('dotenv').config({ override: false });

const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const db = require('./lib/db');

// Логируем для диагностики
console.log('[BOOT] BOT_TOKEN установлен:', !!process.env.BOT_TOKEN);
console.log('[BOOT] BOT_TOKEN длина:', process.env.BOT_TOKEN ? process.env.BOT_TOKEN.length : 0);
console.log('[BOOT] ADMIN_CHAT_ID =', process.env.ADMIN_CHAT_ID || '(not set)');
console.log('[BOOT] SUPABASE_URL установлен:', !!process.env.SUPABASE_URL);

// Проверяем наличие BOT_TOKEN
if (!process.env.BOT_TOKEN) {
  console.error('[ERROR] BOT_TOKEN не установлен! Проверьте переменные окружения в Railway.');
  console.error('[ERROR] Убедитесь, что переменная BOT_TOKEN добавлена в разделе Variables в Railway.');
  process.exit(1);
}

const BOT = new Telegraf(process.env.BOT_TOKEN);

// Тестовая команда: проверить, долетают ли сообщения в админ-чат
BOT.command('testadmin', async (ctx) => {
  const id = process.env.ADMIN_CHAT_ID;
  if (!id) return ctx.reply('ADMIN_CHAT_ID не задан в .env');
  await BOT.telegram.sendMessage(id, '✅ Test: админ-чат получает сообщения.');
  return ctx.reply('Отправил тест в ADMIN_CHAT_ID.');
});

// Сбросить свой статус водителя (если случайно активировался)
BOT.command('resetme', async (ctx) => {
  const user = await db.getUser(ctx.chat.id);
  if (user) {
    await db.setUserPaused(ctx.chat.id);
    return ctx.reply('Ваш статус сброшен. Вы больше не отмечены как водитель.');
  }
  return ctx.reply('У вас не было статуса водителя.');
});

const TZ = process.env.TZ || 'Europe/Vilnius';

const keyboard = Markup.keyboard([
  [Markup.button.locationRequest('📍 Отправить местоположение')],
  ['✅ Маршрут завершён']
]).resize();

// /start <token>
BOT.start(async (ctx) => {
  try {
    // В Telegraf токен из deep link доступен через ctx.startPayload
    // Также проверяем ctx.message.text на случай, если токен передан как аргумент команды
    let token = ctx.startPayload || '';
    
    // Если startPayload пустой, пробуем извлечь из текста сообщения
    if (!token && ctx.message?.text) {
      // Убираем команду /start и берем остальное
      const text = ctx.message.text.trim();
      if (text.startsWith('/start')) {
        const afterStart = text.substring(6).trim(); // Убираем "/start"
        if (afterStart) {
          token = afterStart;
        }
      }
    }
    
    token = (token || '').trim();
    
    console.log('[START] Получена команда /start');
    console.log('[START] ctx.startPayload:', ctx.startPayload);
    console.log('[START] ctx.message.text:', ctx.message?.text);
    console.log('[START] ctx.message.entities:', JSON.stringify(ctx.message?.entities));
    console.log('[START] Извлеченный token:', token);
    console.log('[START] chat_id:', ctx.chat.id);
    console.log('[START] Проверка Supabase - URL:', process.env.SUPABASE_URL ? 'установлен' : 'НЕ установлен');
    console.log('[START] Проверка Supabase - KEY:', process.env.SUPABASE_ANON_KEY ? 'установлен' : 'НЕ установлен');
    
    // Проверяем наличие токена ДО обращения к БД
    if (!token || token.trim() === '') {
      console.log('[START] Токен не предоставлен');
      return ctx.reply('Нужна персональная ссылка. Попросите диспетчера.', keyboard);
    }

    console.log('[START] Поиск водителя по токену:', token);
    const driver = await db.getDriverByToken(token.trim());
    if (!driver) {
      console.log('[START] Водитель не найден для токена:', token);
      console.log('[START] Проверьте, что токен существует в таблице drivers в Supabase');
      return ctx.reply('Ссылка недействительна. Попросите новую у диспетчера.');
    }

    console.log('[START] Найден водитель:', driver.name, 'ID:', driver.id, 'Token:', driver.token);

    // Проверяем, не используется ли токен другим пользователем
    const existingUser = await db.getUserByDriverId(driver.id);
    if (existingUser && existingUser.chat_id !== ctx.chat.id && existingUser.active) {
      console.log('[START] Токен уже используется другим пользователем:', existingUser.chat_id);
      return ctx.reply('Эта ссылка уже использована другим пользователем. Попросите новую у диспетчера.');
    }

    // Активируем пользователя
    await db.setUserActive(ctx.chat.id, driver.id);
    console.log('[START] Пользователь активирован, chat_id:', ctx.chat.id, 'driver_id:', driver.id);
    
    // Отправляем приветственное сообщение с именем водителя
    try {
      await ctx.reply(
        `Привет, ${driver.name}! 👋\n\nМы рады, что вы везёте груз Infobeta. Нам важно знать ваше месторасположение. Поэтому будем присылать вам запросы каждый день в 9 утра.`,
        keyboard
      );
      
      // Сразу запрашиваем первую локацию
      await ctx.reply('📍 Пожалуйста, отправьте вашу текущую геопозицию, нажав кнопку ниже:', keyboard);
      console.log('[START] Приветственное сообщение отправлено, запрос локации отправлен');
    } catch (replyError) {
      // Обрабатываем случай, когда пользователь заблокировал бота
      if (replyError.response?.error_code === 403) {
        console.log('[START] Пользователь заблокировал бота, но активация прошла успешно');
        // Пользователь активирован в БД, но не может получить сообщение - это нормально
        return;
      }
      throw replyError; // Пробрасываем другие ошибки
    }
  } catch (error) {
    console.error('[START] Ошибка при обработке /start:');
    console.error('[START] Сообщение:', error.message);
    console.error('[START] Stack:', error.stack);
    console.error('[START] Полная ошибка:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
    
    // Извлекаем токен для проверки
    let token = ctx.startPayload || '';
    if (!token && ctx.message?.text) {
      const textParts = ctx.message.text.split(' ');
      if (textParts.length > 1) {
        token = textParts[1];
      }
    }
    
    // Если токена нет, показываем соответствующее сообщение
    if (!token || token.trim() === '') {
      console.log('[START] В catch: токен не найден, показываем сообщение о необходимости ссылки');
      try {
        await ctx.reply('Нужна персональная ссылка. Попросите диспетчера.', keyboard);
      } catch (replyError) {
        console.error('[START] Ошибка при отправке сообщения:', replyError);
      }
      return; // Важно: return чтобы не продолжать выполнение
    }
    
    // Если токен есть, но произошла ошибка - показываем общее сообщение об ошибке
    console.log('[START] В catch: токен найден, но произошла ошибка при обработке');
    try {
      // Проверяем, не заблокирован ли бот пользователем
      if (error.response?.error_code === 403) {
        console.log('[START] Пользователь заблокировал бота, не отправляем сообщение');
        return; // Просто выходим, не пытаемся отправить сообщение
      }
      await ctx.reply('Произошла ошибка. Попробуйте позже или обратитесь к диспетчеру.');
    } catch (replyError) {
      // Если и это сообщение не удалось отправить (например, бот заблокирован)
      if (replyError.response?.error_code === 403) {
        console.log('[START] Пользователь заблокировал бота, не можем отправить сообщение об ошибке');
        return;
      }
      console.error('[START] Ошибка при отправке сообщения об ошибке:', replyError);
    }
  }
});

// чтобы узнать chat.id админа
BOT.command('whoami', (ctx) => ctx.reply(`Ваш chat.id: ${ctx.chat.id}`));

// маршрут завершён
BOT.hears('✅ Маршрут завершён', async (ctx) => {
  await db.setUserPaused(ctx.chat.id);
  await ctx.reply('🛑 Маршрут завершён. Напоминания остановлены.');
});

// пришла локация
BOT.on('location', async (ctx) => {
  try {
    console.log('[LOCATION] Получена локация от chat_id:', ctx.chat.id);
    
    const user = await db.getUser(ctx.chat.id);
    if (!user || !user.active) {
      console.log('[LOCATION] Пользователь не активен, chat_id:', ctx.chat.id);
      return ctx.reply('Ваш профиль не активен. Зайдите по своей персональной ссылке.');
    }

    // Проверяем, не истекла ли дата окончания напоминаний
    let driver = await db.getDriver(user.driver_id);
    if (driver && driver.reminder_end_date) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const endDate = new Date(driver.reminder_end_date);
      endDate.setHours(0, 0, 0, 0);
      
      if (today > endDate) {
        console.log('[LOCATION] Дата окончания напоминаний истекла, деактивируем водителя');
        await db.setUserPaused(ctx.chat.id);
        await ctx.reply('🛑 Маршрут завершён. Период напоминаний истёк.');
        return;
      }
    }

    const driverId = user.driver_id;
    const { latitude: lat, longitude: lon } = ctx.message.location;
    const capturedAt = new Date().toISOString();

    console.log('[LOCATION] Сохранение локации, driver_id:', driverId, 'координаты:', lat, lon);

    // Сохраняем локацию в БД
    try {
      const savedLocation = await db.saveLocation(ctx.chat.id, driverId, lat, lon);
      console.log('[LOCATION] Локация сохранена в БД, id:', savedLocation?.id);
    } catch (err) {
      console.error('[LOCATION] Ошибка сохранения локации:', err);
      await ctx.reply('❌ Ошибка при сохранении локации. Попробуйте еще раз.');
      return;
    }

    // Получаем имя водителя для сообщения админу (если еще не получено)
    if (!driver) {
      const drivers = await db.getDrivers();
      driver = drivers.find(d => d.id === driverId) || { id: driverId, name: 'Водитель' };
    }

    // отправляем координаты админу в телеграм
    if (process.env.ADMIN_CHAT_ID) {
      const text = `📍 Локация\nВодитель: ${driver.name} (${driver.id})\nКоординаты: ${lat.toFixed(6)}, ${lon.toFixed(6)}\nВремя: ${capturedAt}`;
      await BOT.telegram.sendMessage(process.env.ADMIN_CHAT_ID, text);
      console.log('[LOCATION] Уведомление отправлено админу');
    }

    await ctx.reply('✅ Геопозиция принята. Спасибо!');
    console.log('[LOCATION] Подтверждение отправлено пользователю');
  } catch (error) {
    console.error('[LOCATION] Ошибка при обработке локации:', error);
    await ctx.reply('❌ Произошла ошибка при обработке локации. Попробуйте позже.');
  }
});

// если текст вместо локации (но не команды)
BOT.on('text', async (ctx) => {
  // Пропускаем команды (они обрабатываются отдельными обработчиками)
  if (ctx.message.text?.startsWith('/')) {
    return;
  }
  
  // Пропускаем кнопку "Маршрут завершён" (она обрабатывается отдельным обработчиком)
  if (ctx.message.text === '✅ Маршрут завершён') {
    return;
  }
  
  // Пропускаем если пользователь не активен (чтобы не спамить)
  const user = await db.getUser(ctx.chat.id);
  if (!user || !user.active) {
    return; // Молча игнорируем, если пользователь не активирован
  }
  
  return ctx.reply('Это не геопозиция. Нажмите "📍 Отправить местоположение" и подтвердите отправку.', keyboard);
});

// крон: каждый день в 09:00 по TZ
cron.schedule('40 18 * * *', async () => {
  const activeUsers = await db.getActiveUsers();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  for (const user of activeUsers) {
    if (await db.wasRemindedToday(user.chat_id)) continue;
    
    // Получаем данные водителя для проверки дат напоминаний
    const driver = await db.getDriver(user.driver_id);
    if (driver) {
      // Проверяем дату начала напоминаний
      if (driver.reminder_start_date) {
        const startDate = new Date(driver.reminder_start_date);
        startDate.setHours(0, 0, 0, 0);
        if (today < startDate) {
          console.log(`[CRON] Пропускаем напоминание для водителя ${driver.id}, дата начала еще не наступила`);
          continue;
        }
      }
      
      // Проверяем дату окончания напоминаний
      if (driver.reminder_end_date) {
        const endDate = new Date(driver.reminder_end_date);
        endDate.setHours(0, 0, 0, 0);
        if (today > endDate) {
          console.log(`[CRON] Дата окончания напоминаний истекла для водителя ${driver.id}, деактивируем`);
          await db.setUserPaused(user.chat_id);
          await BOT.telegram.sendMessage(user.chat_id, '🛑 Маршрут завершён. Период напоминаний истёк.');
          continue;
        }
      }
    }
    
    await BOT.telegram.sendMessage(user.chat_id, 'Доброе утро! Пожалуйста, отправьте вашу геопозицию кнопкой ниже.', keyboard);
    await db.markRemindedToday(user.chat_id);
  }
}, { timezone: TZ });

// Обработка ошибки конфликта при запуске нескольких экземпляров
BOT.launch().then(() => console.log('Bot started (long polling)…'))
  .catch((error) => {
    if (error.response?.error_code === 409) {
      console.error('[ERROR] Конфликт: другой экземпляр бота уже запущен!');
      console.error('[ERROR] Убедитесь, что на Railway запущен только один экземпляр сервиса.');
      console.error('[ERROR] Проверьте раздел Deployments и остановите старые деплои.');
      process.exit(1);
    } else {
      console.error('[ERROR] Ошибка при запуске бота:', error);
      throw error;
    }
  });

process.once('SIGINT', () => BOT.stop('SIGINT'));
process.once('SIGTERM', () => BOT.stop('SIGTERM'));


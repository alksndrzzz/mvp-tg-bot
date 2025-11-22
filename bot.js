require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const db = require('./lib/db');

const BOT = new Telegraf(process.env.BOT_TOKEN);

console.log('[BOOT] ADMIN_CHAT_ID =', process.env.ADMIN_CHAT_ID || '(not set)');

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
    const token = ctx.startPayload || (ctx.message.text || '').split(' ')[1] || '';
    console.log('[START] Получена команда /start');
    console.log('[START] ctx.startPayload:', ctx.startPayload);
    console.log('[START] ctx.message.text:', ctx.message.text);
    console.log('[START] Извлеченный token:', token);
    console.log('[START] chat_id:', ctx.chat.id);
    
    if (!token || token.trim() === '') {
      console.log('[START] Токен не предоставлен');
      return ctx.reply('Нужна персональная ссылка. Попросите диспетчера.', keyboard);
    }

    console.log('[START] Поиск водителя по токену:', token);
    const driver = await db.getDriverByToken(token);
    if (!driver) {
      console.log('[START] Водитель не найден для токена:', token);
      console.log('[START] Проверьте, что токен существует в таблице drivers');
      return ctx.reply('Ссылка недействительна. Попросите новую у диспетчера.');
    }

    console.log('[START] Найден водитель:', driver.name, 'ID:', driver.id, 'Token:', driver.token);

    // Активируем пользователя
    await db.setUserActive(ctx.chat.id, driver.id);
    console.log('[START] Пользователь активирован, chat_id:', ctx.chat.id, 'driver_id:', driver.id);
    
    // Отправляем приветственное сообщение с именем водителя
    await ctx.reply(
      `Привет, ${driver.name}! 👋\n\nМы рады, что вы везёте груз Infobeta. Нам важно знать ваше месторасположение. Поэтому будем присылать вам запросы каждый день в 9 утра.`,
      keyboard
    );
    
    // Сразу запрашиваем первую локацию
    await ctx.reply('📍 Пожалуйста, отправьте вашу текущую геопозицию, нажав кнопку ниже:', keyboard);
    console.log('[START] Приветственное сообщение отправлено, запрос локации отправлен');
  } catch (error) {
    console.error('[START] Ошибка при обработке /start:', error);
    await ctx.reply('Произошла ошибка. Попробуйте позже или обратитесь к диспетчеру.');
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
BOT.on('text', (ctx) => {
  // Пропускаем команды (они обрабатываются отдельными обработчиками)
  if (ctx.message.text?.startsWith('/')) {
    return;
  }
  
  // Пропускаем кнопку "Маршрут завершён" (она обрабатывается отдельным обработчиком)
  if (ctx.message.text === '✅ Маршрут завершён') {
    return;
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

BOT.launch().then(() => console.log('Bot started (long polling)…'));
process.once('SIGINT', () => BOT.stop('SIGINT'));
process.once('SIGTERM', () => BOT.stop('SIGTERM'));


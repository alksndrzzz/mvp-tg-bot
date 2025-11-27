// Загружаем .env только если файл существует (для локальной разработки)
// В Railway переменные окружения уже доступны через process.env
require('dotenv').config({ override: false });

const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const db = require('./lib/db');
const supabase = require('./lib/supabase');

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

// Логируем все входящие update'ы для диагностики
BOT.use(async (ctx, next) => {
  console.log('[UPDATE] Получен update, type:', ctx.updateType);
  console.log('[UPDATE] chat_id:', ctx.chat?.id);
  if (ctx.message) {
    console.log('[UPDATE] message type:', ctx.message.message_id, ctx.message.from?.id);
    if (ctx.message.location) {
      console.log('[UPDATE] ЛОКАЦИЯ обнаружена! latitude:', ctx.message.location.latitude, 'longitude:', ctx.message.location.longitude);
    }
  }
  return next();
});

// Обработчик ошибок на уровне бота
BOT.catch((err, ctx) => {
  console.error('[BOT] Необработанная ошибка:', err);
  console.error('[BOT] Update:', JSON.stringify(ctx.update, null, 2));
  console.error('[BOT] chat_id:', ctx.chat?.id);
  console.error('[BOT] Update type:', ctx.updateType);
  
  // Пытаемся отправить сообщение об ошибке, если это возможно
  if (ctx.chat?.id) {
    ctx.reply('Произошла ошибка. Попробуйте позже.').catch((replyErr) => {
      console.error('[BOT] Не удалось отправить сообщение об ошибке:', replyErr);
    });
  }
});

// Тестовая команда: проверить, долетают ли сообщения в админ-чат
BOT.command('testadmin', async (ctx) => {
  const id = process.env.ADMIN_CHAT_ID;
  if (!id) return ctx.reply('ADMIN_CHAT_ID не задан в .env');
  await BOT.telegram.sendMessage(id, '✅ Test: админ-чат получает сообщения.');
  return ctx.reply('Отправил тест в ADMIN_CHAT_ID.');
});

// Сбросить свой статус водителя (если случайно активировался)
BOT.command('resetme', async (ctx) => {
  const driver = await db.getDriverByChatId(ctx.chat.id);
  if (driver) {
    await db.setDriverInactive(ctx.chat.id);
    await db.setDriverRouteStatus(driver.id, 'stopped');
    return ctx.reply('Ваш статус сброшен. Вы больше не отмечены как водитель.');
  }
  return ctx.reply('У вас не было статуса водителя.');
});

const TZ = process.env.TZ || 'Europe/Vilnius';

const keyboard = Markup.keyboard([
  [Markup.button.locationRequest('📍 Отправить местоположение')],
  ['✅ Маршрут завершён']
]).resize().persistent();

const removeKeyboard = Markup.removeKeyboard();

/**
 * Унифицированная функция завершения маршрута
 * Использует setDriverRouteStatus для автоматической синхронизации is_active с route_status
 */
async function endRoute(chatId, driverId, reason = '') {
  try {
    // setDriverRouteStatus автоматически установит is_active = false при route_status = 'stopped'
    await db.setDriverRouteStatus(driverId, 'stopped');
    console.log(`[endRoute] Маршрут завершен для driver_id: ${driverId}, chat_id: ${chatId}, причина: ${reason}`);
    return true;
  } catch (error) {
    console.error('[endRoute] Ошибка при завершении маршрута:', error);
    throw error;
  }
}

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
    console.log('[START] Извлеченный token:', token);
    console.log('[START] chat_id:', ctx.chat.id);
    
    // Проверяем наличие токена ДО обращения к БД
    if (!token || token.trim() === '') {
      console.log('[START] Токен не предоставлен');
      return ctx.reply('Нужна персональная ссылка. Попросите диспетчера.', removeKeyboard);
    }

    console.log('[START] Поиск водителя по токену:', token);
    const driver = await db.getDriverByToken(token.trim());
    if (!driver) {
      console.log('[START] Водитель не найден для токена:', token);
      return ctx.reply('Ссылка недействительна. Попросите новую у диспетчера.', removeKeyboard);
    }

    console.log('[START] Найден водитель:', driver.name, 'ID:', driver.id, 'Token:', driver.token);

    // Проверяем, не используется ли токен другим пользователем
    if (driver.telegram_chat_id && driver.telegram_chat_id !== ctx.chat.id && driver.is_active) {
      console.log('[START] Токен уже используется другим пользователем:', driver.telegram_chat_id);
      return ctx.reply('Эта ссылка уже использована другим пользователем. Попросите новую у диспетчера.', removeKeyboard);
    }

    // Проверяем статус маршрута
    const routeStatus = driver.route_status || 'not-started-yet';
    console.log('[START] Статус маршрута:', routeStatus);

    // Если маршрут остановлен, проверяем, не создан ли новый маршрут
    // Админ может создать новый маршрут, установив новые даты и route_status = 'not-started-yet'
    // Но если статус еще 'stopped', а даты уже установлены - это новый маршрут
    if (routeStatus === 'stopped') {
      // Проверяем, есть ли новый маршрут (даты установлены и водитель был активирован)
      if (driver.journey_start_date && driver.journey_end_date && driver.telegram_chat_id) {
        // Новый маршрут создан админом - обновляем статус
        console.log('[START] Обнаружен новый маршрут после остановки, обновляем статус на not-started-yet');
        await db.setDriverRouteStatus(driver.id, 'not-started-yet');
        driver.route_status = 'not-started-yet';
        // Продолжаем обработку ниже для отправки уведомления о новом маршруте
      } else {
        // Маршрут действительно остановлен, нового маршрута нет
        console.log('[START] Маршрут завершен, нового маршрута нет');
        return ctx.reply('Спасибо, маршрут окончен. Если что - свяжитесь с администратором лично напрямую.', removeKeyboard);
      }
    }

    // Обновляем только telegram_chat_id, НЕ меняем route_status и is_active при /start
    // Они изменятся при первой отправке локации
    await db.linkDriverToTelegram(driver.id, ctx.from.id);
    console.log('[START] Водитель связан с Telegram, chat_id:', ctx.from.id, 'driver_id:', driver.id);
    
    // Обновляем объект driver после обновления telegram_chat_id
    driver.telegram_chat_id = ctx.from.id;
    
    // Отправляем приветственное сообщение
    try {
      // Сначала отправляем сообщение с remove_keyboard чтобы убрать стандартную кнопку
      await BOT.telegram.sendMessage(ctx.chat.id, '⏳', {
        reply_markup: {
          remove_keyboard: true
        }
      });
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (err) {
      console.log('[START] Не удалось убрать стандартную клавиатуру (это нормально):', err.message);
    }
    
    // Проверяем, создан ли новый маршрут для водителя
    if (db.isNewRoute(driver)) {
      console.log('[START] Обнаружен новый маршрут для водителя:', driver.id);
      const startDate = db.formatDateForDriver(driver.journey_start_date);
      const endDate = db.formatDateForDriver(driver.journey_end_date);
      
      await ctx.reply(
        `🚗 У вас новый маршрут!\n\n` +
        `📅 Дата начала: ${startDate}\n` +
        `📅 Дата окончания: ${endDate}\n\n` +
        `Нажмите "📍 Отправить местоположение" чтобы начать поездку.`,
        keyboard
      );
    } else if (routeStatus === 'not-started-yet') {
      // Первое создание водителя (telegram_chat_id был NULL)
      await ctx.reply(
        `🚗 У вас новая поездка!\n\nПривет, ${driver.name}! 👋\n\nМы рады, что вы везёте груз Infobeta. Нам важно знать ваше месторасположение. Поэтому будем присылать вам запросы каждый день в 9 утра.`,
        keyboard
      );
      await ctx.reply('📍 Пожалуйста, отправьте вашу текущую геопозицию, нажав кнопку ниже:', keyboard);
    } else {
      // Обычное приветствие для активного маршрута
    await ctx.reply(
      `Привет, ${driver.name}! 👋\n\nМы рады, что вы везёте груз Infobeta. Нам важно знать ваше месторасположение. Поэтому будем присылать вам запросы каждый день в 9 утра.`,
      keyboard
    );
      await ctx.reply('📍 Пожалуйста, отправьте вашу текущую геопозицию, нажав кнопку ниже:', keyboard);
    }
    
    console.log('[START] Приветственное сообщение отправлено');
  } catch (error) {
    console.error('[START] Ошибка при обработке /start:');
    console.error('[START] Сообщение:', error.message);
    console.error('[START] Stack:', error.stack);
    
    try {
      if (error.response?.error_code === 403) {
        console.log('[START] Пользователь заблокировал бота');
        return;
      }
      await ctx.reply('Произошла ошибка. Попробуйте позже или обратитесь к диспетчеру.', removeKeyboard);
    } catch (replyError) {
      if (replyError.response?.error_code === 403) {
        return;
      }
      console.error('[START] Ошибка при отправке сообщения об ошибке:', replyError);
    }
  }
});

// чтобы узнать chat.id админа
BOT.command('whoami', (ctx) => ctx.reply(`Ваш chat.id: ${ctx.chat.id}`, removeKeyboard));

// маршрут завершён
BOT.hears('✅ Маршрут завершён', async (ctx) => {
  try {
    const driver = await db.getDriverByChatId(ctx.chat.id);
    if (!driver) {
      return ctx.reply('Вы не зарегистрированы как водитель.', removeKeyboard);
    }
    
    await endRoute(ctx.chat.id, driver.id, 'Водитель нажал кнопку "Маршрут завершён"');
    await ctx.reply('Спасибо, маршрут окончен. Если что - свяжитесь с администратором лично напрямую.', removeKeyboard);
  } catch (error) {
    console.error('[ROUTE_END] Ошибка при завершении маршрута:', error);
    try {
      await ctx.reply('Произошла ошибка при завершении маршрута. Попробуйте позже.', removeKeyboard);
    } catch (replyError) {
      console.error('[ROUTE_END] Ошибка при отправке сообщения:', replyError);
    }
  }
});

// пришла локация
BOT.on('location', async (ctx) => {
  try {
    console.log('[LOCATION] ===== НАЧАЛО ОБРАБОТКИ ЛОКАЦИИ =====');
    console.log('[LOCATION] Получена локация от chat_id:', ctx.chat.id);
    console.log('[LOCATION] Координаты:', ctx.message.location?.latitude, ctx.message.location?.longitude);
    
    const driver = await db.getDriverByChatId(ctx.chat.id);
    console.log('[LOCATION] Водитель из БД:', driver ? `найден, is_active=${driver.is_active}, route_status=${driver.route_status}` : 'не найден');
    
    if (!driver) {
      console.log('[LOCATION] Водитель не найден, chat_id:', ctx.chat.id);
      try {
        await ctx.reply('Ваш профиль не активен. Зайдите по своей персональной ссылке.', removeKeyboard);
      } catch (replyError) {
        if (replyError.response?.error_code === 403) {
          console.log('[LOCATION] Пользователь заблокировал бота');
          return;
        }
        throw replyError;
      }
      return;
    }

    // Проверяем статус маршрута
    const routeStatus = driver.route_status || 'not-started-yet';
    console.log('[LOCATION] Статус маршрута:', routeStatus);

    // Если маршрут остановлен, проверяем, не создан ли новый маршрут
    if (routeStatus === 'stopped') {
      // Проверяем, есть ли новый маршрут (даты установлены и водитель был активирован)
      if (driver.journey_start_date && driver.journey_end_date && driver.telegram_chat_id) {
        // Новый маршрут создан админом - обновляем статус
        console.log('[LOCATION] Обнаружен новый маршрут после остановки, обновляем статус на not-started-yet');
        await db.setDriverRouteStatus(driver.id, 'not-started-yet');
        driver.route_status = 'not-started-yet';
        // Продолжаем обработку ниже для отправки уведомления и обработки локации
      } else {
        // Маршрут действительно остановлен, нового маршрута нет
        console.log('[LOCATION] Маршрут остановлен, не принимаем локацию');
        try {
          await ctx.reply('Спасибо, маршрут окончен. Если что - свяжитесь с администратором лично напрямую.', removeKeyboard);
        } catch (replyError) {
          if (replyError.response?.error_code === 403) {
            return;
          }
          throw replyError;
        }
        return;
      }
    }

    // Проверяем, создан ли новый маршрут для водителя
    if (db.isNewRoute(driver)) {
      console.log('[LOCATION] Обнаружен новый маршрут для водителя:', driver.id);
      const startDate = db.formatDateForDriver(driver.journey_start_date);
      const endDate = db.formatDateForDriver(driver.journey_end_date);
      
      try {
        await ctx.reply(
          `🚗 У вас новый маршрут!\n\n` +
          `📅 Дата начала: ${startDate}\n` +
          `📅 Дата окончания: ${endDate}\n\n` +
          `Нажмите "📍 Отправить местоположение" чтобы начать поездку.`,
          keyboard
        );
      } catch (replyError) {
        if (replyError.response?.error_code === 403) {
          return;
        }
        throw replyError;
      }
      // Продолжаем обработку локации после уведомления
    }

    // Проверяем, есть ли уже локации у водителя (первая локация или нет)
    const hasExistingLocations = await db.hasLocations(driver.id);
    console.log('[LOCATION] Есть ли уже локации у водителя:', hasExistingLocations);

    // Если это первая локация водителя, активируем его
    // Статус должен меняться только автоматически, не при "возобновлении"
    if (!hasExistingLocations && routeStatus === 'not-started-yet') {
      console.log('[LOCATION] Первая локация водителя, активируем и устанавливаем статус in-progress');
      await db.activateDriver(driver.id, ctx.from.id);
      driver.route_status = 'in-progress';
      driver.is_active = true;
    }

    // Проверяем, не истекла ли дата окончания поездки
    // Используем journey_end_date, если есть, иначе fallback на reminder_end_date
    // Учитываем часовой пояс админа для корректного сравнения дат
    const endDate = driver.journey_end_date || driver.reminder_end_date;
    if (endDate) {
      const todayInAdminTZ = await db.getTodayInAdminTimezone();
      const journeyEndDateStr = new Date(endDate).toISOString().slice(0, 10);
      
      if (todayInAdminTZ > journeyEndDateStr) {
        console.log('[LOCATION] Дата окончания поездки истекла, завершаем маршрут');
        await endRoute(ctx.chat.id, driver.id, 'Дата окончания поездки истекла');
        await ctx.reply('Спасибо, маршрут окончен. Если что - свяжитесь с администратором лично напрямую.', removeKeyboard);
        return;
      }
    }

    const driverId = driver.id;
    const { latitude: lat, longitude: lon } = ctx.message.location;
    const capturedAt = new Date().toISOString();

    console.log('[LOCATION] Сохранение локации, driver_id:', driverId, 'координаты:', lat, lon);

    // Сохраняем локацию в БД
    try {
      const savedLocation = await db.saveLocation(driverId, lat, lon);
      console.log('[LOCATION] Локация сохранена в БД, id:', savedLocation?.id);
    } catch (err) {
      console.error('[LOCATION] Ошибка сохранения локации:', err);
      await ctx.reply('❌ Ошибка при сохранении локации. Попробуйте еще раз.', keyboard);
      return;
    }

    // отправляем координаты админу в телеграм
    if (process.env.ADMIN_CHAT_ID) {
      try {
      const text = `📍 Локация\nВодитель: ${driver.name} (${driver.id})\nКоординаты: ${lat.toFixed(6)}, ${lon.toFixed(6)}\nВремя: ${capturedAt}`;
      await BOT.telegram.sendMessage(process.env.ADMIN_CHAT_ID, text);
      console.log('[LOCATION] Уведомление отправлено админу');
      } catch (adminError) {
        console.error('[LOCATION] Ошибка при отправке уведомления админу:', adminError);
      }
    } else {
      console.log('[LOCATION] ADMIN_CHAT_ID не установлен, пропускаем уведомление админу');
    }

    // Отправляем подтверждение пользователю
    try {
      await ctx.reply('✅ Геопозиция принята. Спасибо!', keyboard);
    console.log('[LOCATION] Подтверждение отправлено пользователю');
    } catch (replyError) {
      if (replyError.response?.error_code === 403) {
        console.log('[LOCATION] Пользователь заблокировал бота');
        return;
      }
      throw replyError;
    }
    
    console.log('[LOCATION] ===== ОБРАБОТКА ЛОКАЦИИ ЗАВЕРШЕНА УСПЕШНО =====');
  } catch (error) {
    console.error('[LOCATION] ===== ОШИБКА ПРИ ОБРАБОТКЕ ЛОКАЦИИ =====');
    console.error('[LOCATION] Сообщение:', error.message);
    console.error('[LOCATION] Stack:', error.stack);
    console.error('[LOCATION] chat_id:', ctx.chat.id);
    
    try {
      if (error.response?.error_code === 403) {
        console.log('[LOCATION] Пользователь заблокировал бота');
        return;
      }
      await ctx.reply('❌ Произошла ошибка при обработке локации. Попробуйте позже.', removeKeyboard);
    } catch (replyError) {
      if (replyError.response?.error_code === 403) {
        return;
      }
      console.error('[LOCATION] Ошибка при отправке сообщения об ошибке:', replyError);
    }
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
  
  // Проверяем, активен ли водитель
  const driver = await db.getDriverByChatId(ctx.chat.id);
  if (!driver || !driver.is_active) {
    console.log('[TEXT] Водитель не активен, игнорируем текстовое сообщение:', ctx.chat.id);
    return; // Молча игнорируем
  }
  
  return ctx.reply('Это не геопозиция. Нажмите "📍 Отправить местоположение" и подтвердите отправку.', keyboard);
});

// крон: каждый день в 09:00 по TZ
cron.schedule('40 18 * * *', async () => {
  const activeDrivers = await db.getActiveDrivers();
  // Получаем текущую дату в часовом поясе админа
  const todayInAdminTZ = await db.getTodayInAdminTimezone();
  
  for (const driver of activeDrivers) {
    // Проверяем, был ли водитель напомнен сегодня
    if (await db.wasRemindedToday(driver.telegram_chat_id)) continue;
    
    // Проверяем статус маршрута - напоминания только для in-progress или not-started-yet
    const routeStatus = driver.route_status || 'not-started-yet';
    if (routeStatus === 'stopped') {
      console.log(`[CRON] Пропускаем напоминание для водителя ${driver.id}, маршрут остановлен`);
      continue;
    }
    
    // Проверяем дату начала поездки
    // Используем journey_start_date, если есть, иначе fallback на reminder_start_date
    const startDate = driver.journey_start_date || driver.reminder_start_date;
    if (startDate) {
      const journeyStartDateStr = new Date(startDate).toISOString().slice(0, 10);
      if (todayInAdminTZ < journeyStartDateStr) {
        console.log(`[CRON] Пропускаем напоминание для водителя ${driver.id}, дата начала поездки еще не наступила`);
          continue;
        }
      }
      
    // Проверяем дату окончания поездки
    // Используем journey_end_date, если есть, иначе fallback на reminder_end_date
    // Учитываем часовой пояс админа
    const endDate = driver.journey_end_date || driver.reminder_end_date;
    if (endDate) {
      const journeyEndDateStr = new Date(endDate).toISOString().slice(0, 10);
      if (todayInAdminTZ > journeyEndDateStr) {
        console.log(`[CRON] Дата окончания поездки истекла для водителя ${driver.id}, завершаем маршрут`);
        await endRoute(driver.telegram_chat_id, driver.id, 'Дата окончания поездки истекла (cron)');
        try {
          await BOT.telegram.sendMessage(driver.telegram_chat_id, 'Спасибо, маршрут окончен. Если что - свяжитесь с администратором лично напрямую.', removeKeyboard);
        } catch (err) {
          if (err.response?.error_code === 403) {
            console.log(`[CRON] Пользователь ${driver.telegram_chat_id} заблокировал бота`);
          }
        }
          continue;
      }
    }
    
    // Отправляем напоминание и обновляем last_reminded_date
    try {
      await BOT.telegram.sendMessage(driver.telegram_chat_id, 'Доброе утро! Пожалуйста, отправьте вашу геопозицию кнопкой ниже.', keyboard);
      await db.markRemindedToday(driver.telegram_chat_id);
      console.log(`[CRON] Напоминание отправлено водителю ${driver.id}, last_reminded_date обновлена`);
    } catch (cronReplyError) {
      if (cronReplyError.response?.error_code === 403) {
        console.log(`[CRON] Пользователь ${driver.telegram_chat_id} заблокировал бота, деактивируем`);
        await db.setDriverInactive(driver.telegram_chat_id);
      } else {
        console.error(`[CRON] Ошибка при отправке напоминания водителю ${driver.id}:`, cronReplyError);
      }
    }
  }
}, { timezone: TZ });

// крон: проверка поездок, которые заканчиваются скоро (ежедневно в 08:00)
cron.schedule('0 8 * * *', async () => {
  console.log('[CRON] Запуск проверки поездок, которые заканчиваются скоро.');
  
  try {
    // Получаем часовой пояс админа и вычисляем завтрашнюю дату в этом часовом поясе
    const adminTimezone = await db.getAdminTimezone();
    const todayInAdminTZ = await db.getTodayInAdminTimezone();
    
    // Вычисляем завтрашнюю дату в часовом поясе админа
    const today = new Date(todayInAdminTZ + 'T00:00:00');
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    
    // Получаем водителей, у которых поездка заканчивается завтра (в часовом поясе админа)
    const { data: driversEndingSoon, error } = await supabase
      .from('drivers')
      .select('*')
      .eq('journey_end_date', tomorrowStr)
      .neq('route_status', 'stopped');
    
    if (error) {
      console.error('[CRON] Ошибка при получении водителей с ending soon:', error);
      return;
    }
    
    for (const driver of (driversEndingSoon || [])) {
      // Проверяем, было ли уже отправлено уведомление
      const alreadyNotified = await db.checkJourneyNotificationSent(driver.id, 'ending_soon');
      
      if (!alreadyNotified) {
        // Создаем запись в journey_notifications для админки
        await db.markJourneyNotificationSent(driver.id, 'ending_soon');
        console.log(`[CRON] Создана запись уведомления 'ending_soon' для водителя ${driver.id} (${driver.name})`);
      }
    }
    
    console.log(`[CRON] Проверка поездок, которые заканчиваются скоро, завершена. Найдено: ${driversEndingSoon?.length || 0}`);
  } catch (error) {
    console.error('[CRON] Ошибка при проверке поездок, которые заканчиваются скоро:', error);
  }
}, { timezone: TZ });

// крон: автоматическая остановка маршрутов с истекшей датой (ежедневно в 00:00)
cron.schedule('0 0 * * *', async () => {
  console.log('[CRON] Запуск автоматической остановки маршрутов с истекшей датой.');
  
  try {
    // Получаем текущую дату в часовом поясе админа
    const todayInAdminTZ = await db.getTodayInAdminTimezone();
    
    // Находим водителей с истекшей датой поездки (в часовом поясе админа)
    const { data: expiredDrivers, error } = await supabase
      .from('drivers')
      .select('*')
      .not('journey_end_date', 'is', null)
      .lt('journey_end_date', todayInAdminTZ)
      .neq('route_status', 'stopped');
    
    if (error) {
      console.error('[CRON] Ошибка при получении водителей с истекшей датой:', error);
      return;
    }
    
    const stopped = [];
    
    for (const driver of (expiredDrivers || [])) {
      try {
        // Останавливаем маршрут (setDriverRouteStatus автоматически установит is_active = false)
        await db.setDriverRouteStatus(driver.id, 'stopped');
        
        // Отмечаем уведомление как отправленное (если еще не отправлено)
        const alreadyNotified = await db.checkJourneyNotificationSent(driver.id, 'ended');
        if (!alreadyNotified) {
          await db.markJourneyNotificationSent(driver.id, 'ended');
        }
        
        stopped.push(driver);
        console.log(`[CRON] Маршрут остановлен для водителя ${driver.id} (${driver.name})`);
        
        // Отправляем уведомление водителю (если он не заблокировал бота)
        if (driver.telegram_chat_id) {
          try {
            await BOT.telegram.sendMessage(
              driver.telegram_chat_id,
              'Спасибо, маршрут окончен. Если что - свяжитесь с администратором лично напрямую.',
              removeKeyboard
            );
          } catch (err) {
            if (err.response?.error_code === 403) {
              console.log(`[CRON] Пользователь ${driver.telegram_chat_id} заблокировал бота`);
            } else {
              console.error(`[CRON] Ошибка при отправке уведомления водителю ${driver.id}:`, err);
            }
          }
        }
      } catch (error) {
        console.error(`[CRON] Ошибка при остановке маршрута для водителя ${driver.id}:`, error);
      }
    }
    
    console.log(`[CRON] Автоматическая остановка маршрутов завершена. Остановлено: ${stopped.length}`);
  } catch (error) {
    console.error('[CRON] Ошибка при автоматической остановке маршрутов:', error);
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

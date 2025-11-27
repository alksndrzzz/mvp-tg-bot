// Загружаем .env только если файл существует (для локальной разработки)
// В Railway переменные окружения уже доступны через process.env
require('dotenv').config({ override: false });

const { Telegraf, Markup } = require('telegraf');
const express = require('express');
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

// Получаем часовой пояс для cron задач
// Используем часовой пояс админа из БД, если доступен, иначе fallback на TZ или Europe/Vilnius
let TZ = process.env.TZ || 'Europe/Vilnius';

// Функция для инициализации cron задач с часовым поясом админа
async function initializeCronJobs() {
  try {
    const adminTimezone = await db.getAdminTimezone();
    TZ = adminTimezone;
    console.log('[BOOT] Используется часовой пояс админа для cron задач:', TZ);
  } catch (error) {
    console.warn('[BOOT] Не удалось получить часовой пояс админа, используется fallback:', TZ);
    console.warn('[BOOT] Ошибка:', error.message);
  }
  
  // Создаем cron задачи после получения часового пояса
  setupCronJobs();
}

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
      // Используем journey_*_date если есть, иначе fallback на reminder_*_date
      const hasJourneyDates = driver.journey_start_date && driver.journey_end_date;
      const hasReminderDates = driver.reminder_start_date && driver.reminder_end_date;
      const hasDates = hasJourneyDates || hasReminderDates;
      
      if (hasDates && driver.telegram_chat_id) {
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
    
    // Получаем актуальные данные водителя из БД после обновления telegram_chat_id
    // Это важно для корректной проверки нового маршрута
    const updatedDriver = await db.getDriverByChatId(ctx.from.id);
    if (updatedDriver) {
      // Обновляем объект driver актуальными данными
      Object.assign(driver, updatedDriver);
      console.log('[START] Данные водителя обновлены из БД:', {
        route_status: driver.route_status,
        journey_start_date: driver.journey_start_date,
        journey_end_date: driver.journey_end_date
      });
    }
    
    // Проверяем, создан ли новый маршрут для водителя
    let isNewRouteResult = false;
    try {
      if (typeof db.isNewRoute === 'function') {
        isNewRouteResult = db.isNewRoute(driver);
        // Убеждаемся, что результат boolean
        if (typeof isNewRouteResult !== 'boolean') {
          console.error('[START] ERROR: isNewRoute вернула не boolean:', typeof isNewRouteResult, isNewRouteResult);
          isNewRouteResult = false;
        }
      } else {
        console.error('[START] ERROR: db.isNewRoute не является функцией:', typeof db.isNewRoute);
        isNewRouteResult = false;
      }
    } catch (error) {
      console.error('[START] ERROR при вызове db.isNewRoute:', error);
      isNewRouteResult = false;
    }
    
    console.log('[START] Проверка нового маршрута:', {
      driver_id: driver.id,
      route_status: driver.route_status,
      journey_start_date: driver.journey_start_date,
      journey_end_date: driver.journey_end_date,
      reminder_start_date: driver.reminder_start_date,
      reminder_end_date: driver.reminder_end_date,
      telegram_chat_id: driver.telegram_chat_id,
      last_reminded_date: driver.last_reminded_date,
      isNewRoute: isNewRouteResult
    });
    
    // Сначала отправляем приветственное сообщение с remove_keyboard чтобы убрать стандартную кнопку Start
    // Это сообщение будет удалено после отправки основного сообщения
    let tempMessageId = null;
    try {
      const tempMsg = await BOT.telegram.sendMessage(ctx.chat.id, '⏳', {
        reply_markup: {
          remove_keyboard: true
        }
      });
      tempMessageId = tempMsg.message_id;
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (err) {
      console.log('[START] Не удалось убрать стандартную клавиатуру (это нормально):', err.message);
    }
    
    if (isNewRouteResult) {
      console.log('[START] Обнаружен новый маршрут для водителя:', driver.id);
      // Используем journey_*_date если есть, иначе fallback на reminder_*_date
      const startDate = db.formatDateForDriver(driver.journey_start_date || driver.reminder_start_date);
      const endDate = db.formatDateForDriver(driver.journey_end_date || driver.reminder_end_date);
      
      // Сначала отправляем приветственное сообщение
      await ctx.reply(
        `Привет, ${driver.name}! 👋\n\n` +
        `Спасибо, что везёте груз Infobeta! Мы ценим вашу работу и надежность. ` +
        `Нам важно знать ваше месторасположение во время поездки, поэтому мы будем присылать вам запросы каждый день в 9 утра.`,
        { reply_markup: { remove_keyboard: true } }
      );
      
      // Затем отправляем сообщение о новом маршруте
      await ctx.reply(
        `🚗 У вас новый маршрут!\n\n` +
        `📅 Дата начала: ${startDate}\n` +
        `📅 Дата окончания: ${endDate}\n\n` +
        `Пожалуйста, отправьте вашу первую геопозицию, нажав кнопку ниже:`,
        keyboard
      );
      
      // Обновляем last_reminded_date, чтобы не отправлять уведомление повторно
      try {
        await db.markRemindedToday(ctx.chat.id);
        console.log('[START] last_reminded_date обновлена для водителя:', driver.id);
      } catch (error) {
        console.error('[START] Ошибка при обновлении last_reminded_date:', error);
      }
      
      // Удаляем временное сообщение
      if (tempMessageId) {
        try {
          await BOT.telegram.deleteMessage(ctx.chat.id, tempMessageId);
        } catch (err) {
          // Игнорируем ошибки удаления
        }
      }
    } else if (routeStatus === 'not-started-yet') {
      // Первое создание водителя (telegram_chat_id был NULL)
      await ctx.reply(
        `Привет, ${driver.name}! 👋\n\n` +
        `Спасибо, что везёте груз Infobeta! Мы ценим вашу работу и надежность. ` +
        `Нам важно знать ваше месторасположение во время поездки, поэтому мы будем присылать вам запросы каждый день в 9 утра.`,
        { reply_markup: { remove_keyboard: true } }
      );
      await ctx.reply('📍 Пожалуйста, отправьте вашу текущую геопозицию, нажав кнопку ниже:', keyboard);
      
      // Удаляем временное сообщение
      if (tempMessageId) {
        try {
          await BOT.telegram.deleteMessage(ctx.chat.id, tempMessageId);
        } catch (err) {
          // Игнорируем ошибки удаления
        }
      }
    } else {
      // Обычное приветствие для активного маршрута
    await ctx.reply(
        `Привет, ${driver.name}! 👋\n\n` +
        `Спасибо, что везёте груз Infobeta! Мы ценим вашу работу и надежность. ` +
        `Нам важно знать ваше месторасположение во время поездки, поэтому мы будем присылать вам запросы каждый день в 9 утра.`,
        { reply_markup: { remove_keyboard: true } }
    );
      await ctx.reply('📍 Пожалуйста, отправьте вашу текущую геопозицию, нажав кнопку ниже:', keyboard);
      
      // Удаляем временное сообщение
      if (tempMessageId) {
        try {
          await BOT.telegram.deleteMessage(ctx.chat.id, tempMessageId);
        } catch (err) {
          // Игнорируем ошибки удаления
        }
      }
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
    
    // Сохраняем даты текущего маршрута ДО завершения для сравнения
    const currentStartDate = driver.reminder_start_date || driver.journey_start_date;
    const currentEndDate = driver.reminder_end_date || driver.journey_end_date;
    
    await endRoute(ctx.chat.id, driver.id, 'Водитель нажал кнопку "Маршрут завершён"');
    
    // Обновляем данные водителя из БД после завершения маршрута
    const updatedDriver = await db.getDriverByChatId(ctx.chat.id);
    if (!updatedDriver) {
      return ctx.reply('Спасибо, маршрут окончен. Если что - свяжитесь с администратором лично напрямую.', removeKeyboard);
    }
    
    // Проверяем, есть ли новый маршрут
    // Важно: после endRoute статус становится 'stopped', но если админ создал новый маршрут,
    // то должны быть установлены reminder_start_date и reminder_end_date
    // Новый маршрут определяется по:
    // 1. Есть даты (reminder_*_date или journey_*_date)
    // 2. last_reminded_date === null (сброшен при создании нового маршрута админом) - ГЛАВНЫЙ ИНДИКАТОР
    // 3. ИЛИ даты изменились (даже если они раньше или в тот же день - водитель мог завершить раньше)
    let isNewRouteResult = false;
    try {
      // Проверяем наличие дат нового маршрута (даже если статус 'stopped')
      const hasJourneyDates = !!(updatedDriver.journey_start_date && updatedDriver.journey_end_date);
      const hasReminderDates = !!(updatedDriver.reminder_start_date && updatedDriver.reminder_end_date);
      const hasDates = hasJourneyDates || hasReminderDates;
      const wasActivated = updatedDriver.telegram_chat_id !== null && updatedDriver.telegram_chat_id !== undefined;
      
      // last_reminded_date должен быть null - это главный индикатор нового маршрута
      // Если админ создал новый маршрут, он сбрасывает last_reminded_date в null
      const lastRemindedIsNull = updatedDriver.last_reminded_date === null || updatedDriver.last_reminded_date === undefined;
      
      // Проверяем, изменились ли даты по сравнению с предыдущим маршрутом
      // Новый маршрут может начинаться в тот же день или даже раньше, если водитель завершил предыдущий раньше
      let datesChanged = false;
      if (hasReminderDates) {
        const newStartDate = updatedDriver.reminder_start_date;
        const newEndDate = updatedDriver.reminder_end_date;
        // Даты изменились, если они отличаются от предыдущих
        datesChanged = (newStartDate !== currentStartDate) || (newEndDate !== currentEndDate);
      } else if (hasJourneyDates) {
        const newStartDate = updatedDriver.journey_start_date;
        const newEndDate = updatedDriver.journey_end_date;
        datesChanged = (newStartDate !== currentStartDate) || (newEndDate !== currentEndDate);
      }
      
      // Новый маршрут определяется по:
      // - last_reminded_date === null (админ создал новый маршрут и сбросил его)
      // ИЛИ
      // - даты изменились (даже если они раньше или в тот же день)
      isNewRouteResult = hasDates && wasActivated && (lastRemindedIsNull || datesChanged);
      
      console.log('[ROUTE_END] Проверка нового маршрута после завершения:', {
        route_status: updatedDriver.route_status,
        hasJourneyDates,
        hasReminderDates,
        hasDates,
        wasActivated,
        lastRemindedIsNull,
        datesChanged,
        currentStartDate,
        currentEndDate,
        reminder_start_date: updatedDriver.reminder_start_date,
        reminder_end_date: updatedDriver.reminder_end_date,
        last_reminded_date: updatedDriver.last_reminded_date,
        isNewRoute: isNewRouteResult
      });
    } catch (error) {
      console.error('[ROUTE_END] ERROR при проверке нового маршрута:', error);
      isNewRouteResult = false;
    }
    
    if (isNewRouteResult) {
      // Есть новый маршрут - обновляем статус на 'not-started-yet' и отправляем уведомление
      console.log('[ROUTE_END] Обнаружен новый маршрут после завершения, обновляем статус и отправляем уведомление');
      
      // Обновляем статус на 'not-started-yet' для нового маршрута
      try {
        await db.setDriverRouteStatus(updatedDriver.id, 'not-started-yet');
        console.log('[ROUTE_END] Статус маршрута обновлен на not-started-yet для водителя:', updatedDriver.id);
      } catch (error) {
        console.error('[ROUTE_END] Ошибка при обновлении статуса маршрута:', error);
      }
      
      const startDate = db.formatDateForDriver(updatedDriver.journey_start_date || updatedDriver.reminder_start_date);
      const endDate = db.formatDateForDriver(updatedDriver.journey_end_date || updatedDriver.reminder_end_date);
      
      await ctx.reply(
        `🚗 У вас новый маршрут!\n\n` +
        `📅 Дата начала: ${startDate}\n` +
        `📅 Дата окончания: ${endDate}\n\n` +
        `Пожалуйста, отправьте вашу первую геопозицию, нажав кнопку ниже:`,
        keyboard
      );
      
      // Обновляем last_reminded_date, чтобы не отправлять уведомление повторно
      try {
        await db.markRemindedToday(ctx.chat.id);
        console.log('[ROUTE_END] last_reminded_date обновлена для водителя:', updatedDriver.id);
      } catch (error) {
        console.error('[ROUTE_END] Ошибка при обновлении last_reminded_date:', error);
      }
    } else {
      // Нового маршрута нет - убираем кнопки и оставляем статус 'stopped'
      // НЕ обновляем статус обратно на 'not-started-yet', чтобы избежать цикла
      await ctx.reply('Спасибо, маршрут окончен. Если что - свяжитесь с администратором лично напрямую.', removeKeyboard);
    }
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
      // Используем journey_*_date если есть, иначе fallback на reminder_*_date
      const hasJourneyDates = !!(driver.journey_start_date && driver.journey_end_date);
      const hasReminderDates = !!(driver.reminder_start_date && driver.reminder_end_date);
      const hasDates = hasJourneyDates || hasReminderDates;
      const wasActivated = driver.telegram_chat_id !== null && driver.telegram_chat_id !== undefined;
      
      // Проверяем, что даты нового маршрута в будущем или сегодня
      let datesAreFuture = false;
      if (hasReminderDates) {
        const today = new Date().toISOString().slice(0, 10);
        const startDate = driver.reminder_start_date;
        const endDate = driver.reminder_end_date;
        datesAreFuture = (startDate >= today) && (endDate >= today);
      } else if (hasJourneyDates) {
        const today = new Date().toISOString().slice(0, 10);
        const startDate = driver.journey_start_date;
        const endDate = driver.journey_end_date;
        datesAreFuture = (startDate >= today) && (endDate >= today);
      }
      
      if (hasDates && wasActivated && datesAreFuture) {
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

    // УБРАНО: Проверка нового маршрута при отправке локации
    // Сообщение о новом маршруте показывается только при /start, не при отправке локации
    // Это предотвращает повторное показывание сообщения о новом маршруте

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
        
        // Обновляем данные водителя из БД после завершения маршрута
        const updatedDriver = await db.getDriverByChatId(ctx.chat.id);
        if (updatedDriver) {
          // Проверяем, есть ли новый маршрут
          let isNewRouteResult = false;
          try {
            if (typeof db.isNewRoute === 'function') {
              isNewRouteResult = db.isNewRoute(updatedDriver);
              if (typeof isNewRouteResult !== 'boolean') {
                isNewRouteResult = false;
              }
            }
          } catch (error) {
            console.error('[LOCATION] ERROR при вызове db.isNewRoute:', error);
            isNewRouteResult = false;
          }
          
          if (isNewRouteResult) {
            // Есть новый маршрут - показываем кнопки и отправляем уведомление
            console.log('[LOCATION] Обнаружен новый маршрут после истечения даты, отправляем уведомление');
            const startDate = db.formatDateForDriver(updatedDriver.journey_start_date || updatedDriver.reminder_start_date);
            const endDate = db.formatDateForDriver(updatedDriver.journey_end_date || updatedDriver.reminder_end_date);
            
            await ctx.reply(
              `🚗 У вас новый маршрут!\n\n` +
              `📅 Дата начала: ${startDate}\n` +
              `📅 Дата окончания: ${endDate}\n\n` +
              `Пожалуйста, отправьте вашу первую геопозицию, нажав кнопку ниже:`,
              keyboard
            );
            
            // Обновляем last_reminded_date
            try {
              await db.markRemindedToday(ctx.chat.id);
            } catch (error) {
              console.error('[LOCATION] Ошибка при обновлении last_reminded_date:', error);
            }
            return;
          }
        }
        
        // Нового маршрута нет - убираем кнопки
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

// Функция для настройки всех cron задач
function setupCronJobs() {
  // крон: каждый день в 09:00 по часовому поясу админа
  cron.schedule('0 9 * * *', async () => {
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
        
        // Обновляем данные водителя из БД после завершения маршрута
        const updatedDriver = await db.getDriver(driver.id);
        if (updatedDriver) {
          // Проверяем, есть ли новый маршрут
          let isNewRouteResult = false;
          try {
            if (typeof db.isNewRoute === 'function') {
              isNewRouteResult = db.isNewRoute(updatedDriver);
              if (typeof isNewRouteResult !== 'boolean') {
                isNewRouteResult = false;
              }
            }
          } catch (error) {
            console.error('[CRON] ERROR при вызове db.isNewRoute:', error);
            isNewRouteResult = false;
          }
          
          if (isNewRouteResult) {
            // Есть новый маршрут - показываем кнопки и отправляем уведомление
            console.log('[CRON] Обнаружен новый маршрут после истечения даты, отправляем уведомление');
            const startDate = db.formatDateForDriver(updatedDriver.journey_start_date || updatedDriver.reminder_start_date);
            const endDate = db.formatDateForDriver(updatedDriver.journey_end_date || updatedDriver.reminder_end_date);
            
            try {
              await BOT.telegram.sendMessage(
                driver.telegram_chat_id,
                `🚗 У вас новый маршрут!\n\n` +
                `📅 Дата начала: ${startDate}\n` +
                `📅 Дата окончания: ${endDate}\n\n` +
                `Пожалуйста, отправьте вашу первую геопозицию, нажав кнопку ниже.`,
                keyboard
              );
              
              // Обновляем last_reminded_date
              await db.markRemindedToday(driver.telegram_chat_id);
            } catch (err) {
              if (err.response?.error_code === 403) {
                console.log(`[CRON] Пользователь ${driver.telegram_chat_id} заблокировал бота`);
              } else {
                console.error('[CRON] Ошибка при отправке уведомления о новом маршруте:', err);
              }
            }
            continue;
          }
        }
        
        // Нового маршрута нет - убираем кнопки
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

  // крон: проверка поездок, которые заканчиваются скоро (ежедневно в 08:00 по часовому поясу админа)
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

  // крон: автоматическая остановка маршрутов с истекшей датой (ежедневно в 00:00 по часовому поясу админа)
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
          // Обновляем данные водителя из БД после остановки маршрута
          const updatedDriver = await db.getDriver(driver.id);
          if (updatedDriver) {
            // Проверяем, есть ли новый маршрут
            // Важно: после остановки статус становится 'stopped', но если админ создал новый маршрут,
            // то должны быть установлены reminder_start_date и reminder_end_date, и даты должны быть в будущем
            let isNewRouteResult = false;
            try {
              // Проверяем наличие дат нового маршрута (даже если статус 'stopped')
              const hasJourneyDates = !!(updatedDriver.journey_start_date && updatedDriver.journey_end_date);
              const hasReminderDates = !!(updatedDriver.reminder_start_date && updatedDriver.reminder_end_date);
              const hasDates = hasJourneyDates || hasReminderDates;
              const wasActivated = updatedDriver.telegram_chat_id !== null && updatedDriver.telegram_chat_id !== undefined;
              
              // Проверяем, что даты нового маршрута в будущем или сегодня
              let datesAreFuture = false;
              if (hasReminderDates) {
                const today = new Date().toISOString().slice(0, 10);
                const startDate = updatedDriver.reminder_start_date;
                const endDate = updatedDriver.reminder_end_date;
                datesAreFuture = (startDate >= today) && (endDate >= today);
              } else if (hasJourneyDates) {
                const today = new Date().toISOString().slice(0, 10);
                const startDate = updatedDriver.journey_start_date;
                const endDate = updatedDriver.journey_end_date;
                datesAreFuture = (startDate >= today) && (endDate >= today);
              }
              
              // Если есть даты, водитель активирован, и даты в будущем - это новый маршрут
              isNewRouteResult = hasDates && wasActivated && datesAreFuture;
            } catch (error) {
              console.error('[CRON] ERROR при проверке нового маршрута:', error);
              isNewRouteResult = false;
            }
            
            if (isNewRouteResult) {
              // Обновляем статус на 'not-started-yet' для нового маршрута
              try {
                await db.setDriverRouteStatus(updatedDriver.id, 'not-started-yet');
                console.log('[CRON] Статус маршрута обновлен на not-started-yet для водителя:', updatedDriver.id);
              } catch (error) {
                console.error('[CRON] Ошибка при обновлении статуса маршрута:', error);
              }
              // Есть новый маршрут - показываем кнопки и отправляем уведомление
              console.log('[CRON] Обнаружен новый маршрут после автоматической остановки, отправляем уведомление');
              const startDate = db.formatDateForDriver(updatedDriver.journey_start_date || updatedDriver.reminder_start_date);
              const endDate = db.formatDateForDriver(updatedDriver.journey_end_date || updatedDriver.reminder_end_date);
              
              try {
                await BOT.telegram.sendMessage(
                  driver.telegram_chat_id,
                  `🚗 У вас новый маршрут!\n\n` +
                  `📅 Дата начала: ${startDate}\n` +
                  `📅 Дата окончания: ${endDate}\n\n` +
                  `Пожалуйста, отправьте вашу первую геопозицию, нажав кнопку ниже.`,
                  keyboard
                );
                
                // Обновляем last_reminded_date
                await db.markRemindedToday(driver.telegram_chat_id);
              } catch (err) {
                if (err.response?.error_code === 403) {
                  console.log(`[CRON] Пользователь ${driver.telegram_chat_id} заблокировал бота`);
                } else {
                  console.error('[CRON] Ошибка при отправке уведомления о новом маршруте:', err);
                }
              }
            } else {
              // Нового маршрута нет - убираем кнопки
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
          } else {
            // Если не удалось получить обновленные данные, отправляем стандартное сообщение
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

  console.log('[BOOT] Все cron задачи настроены с часовым поясом:', TZ);
}

// Функция для отправки уведомления о новом маршруте водителю
async function sendNewRouteNotification(driver) {
  if (!driver.telegram_chat_id) {
    console.log('[NEW_ROUTE] Водитель не связан с Telegram, пропускаем уведомление:', driver.id);
    return;
  }

  try {
    // Используем journey_*_date если есть, иначе fallback на reminder_*_date
    const startDate = db.formatDateForDriver(driver.journey_start_date || driver.reminder_start_date);
    const endDate = db.formatDateForDriver(driver.journey_end_date || driver.reminder_end_date);
    
    console.log('[NEW_ROUTE] Отправка уведомления о новом маршруте водителю:', driver.id, driver.name);
    
    await BOT.telegram.sendMessage(
      driver.telegram_chat_id,
      `🚗 У вас новый маршрут!\n\n` +
      `📅 Дата начала: ${startDate}\n` +
      `📅 Дата окончания: ${endDate}\n\n` +
      `Пожалуйста, отправьте вашу первую геопозицию, нажав кнопку ниже.`,
      keyboard
    );
    
    console.log('[NEW_ROUTE] Уведомление о новом маршруте отправлено водителю:', driver.id);
  } catch (error) {
    if (error.response?.error_code === 403) {
      console.log('[NEW_ROUTE] Пользователь заблокировал бота:', driver.telegram_chat_id);
    } else {
      console.error('[NEW_ROUTE] Ошибка при отправке уведомления о новом маршруте:', error);
    }
  }
}

// Настройка HTTP сервера для получения webhook от админ-панели
function setupWebhookServer() {
  const app = express();
  
  // Middleware для парсинга JSON
  app.use(express.json());
  
  // Endpoint для получения уведомлений о новом маршруте от админ-панели
  app.post('/api/bot/notify', async (req, res) => {
    try {
      const { type, driverId, telegramChatId, reminderStartDate, reminderEndDate, driverName } = req.body;
      
      console.log('[WEBHOOK] Получено уведомление:', {
        type,
        driverId,
        telegramChatId,
        reminderStartDate,
        reminderEndDate,
        driverName
      });
      
      // Проверяем, что это уведомление о новом маршруте
      if (type !== 'new_route') {
        console.log('[WEBHOOK] Неверный тип уведомления:', type);
        return res.status(400).json({ error: 'Invalid notification type' });
      }
      
      // Проверяем наличие обязательных полей
      if (!driverId || !telegramChatId || !reminderStartDate || !reminderEndDate) {
        console.log('[WEBHOOK] Отсутствуют обязательные поля');
        return res.status(400).json({ error: 'Missing required fields' });
      }
      
      // Получаем данные водителя из БД для проверки
      const driver = await db.getDriver(driverId);
      if (!driver) {
        console.log('[WEBHOOK] Водитель не найден:', driverId);
        return res.status(404).json({ error: 'Driver not found' });
      }
      
      // Проверяем, что это действительно новый маршрут
      // Важно: даже если маршрут был завершен ранее, если админ создал новый маршрут,
      // то route_status должен быть 'not-started-yet', и isNewRoute вернет true
      let isNewRouteResult = false;
      try {
        if (typeof db.isNewRoute === 'function') {
          isNewRouteResult = db.isNewRoute(driver);
          if (typeof isNewRouteResult !== 'boolean') {
            console.error('[WEBHOOK] ERROR: isNewRoute вернула не boolean:', typeof isNewRouteResult, isNewRouteResult);
            isNewRouteResult = false;
          }
        } else {
          console.error('[WEBHOOK] ERROR: db.isNewRoute не является функцией:', typeof db.isNewRoute);
          isNewRouteResult = false;
        }
      } catch (error) {
        console.error('[WEBHOOK] ERROR при вызове db.isNewRoute:', error);
        isNewRouteResult = false;
      }
      
      if (!isNewRouteResult) {
        console.log('[WEBHOOK] Это не новый маршрут для водителя:', driverId, {
          route_status: driver.route_status,
          reminder_start_date: driver.reminder_start_date,
          reminder_end_date: driver.reminder_end_date,
          last_reminded_date: driver.last_reminded_date
        });
        return res.status(200).json({ 
          success: true, 
          message: 'Not a new route, notification skipped' 
        });
      }
      
      // Отправляем уведомление водителю
      const startDate = db.formatDateForDriver(reminderStartDate);
      const endDate = db.formatDateForDriver(reminderEndDate);
      
      console.log('[WEBHOOK] Отправка уведомления о новом маршруте водителю:', driverId, driverName || driver.name);
      
      await BOT.telegram.sendMessage(
        telegramChatId,
        `🚗 У вас новый маршрут!\n\n` +
        `📅 Дата начала: ${startDate}\n` +
        `📅 Дата окончания: ${endDate}\n\n` +
        `Пожалуйста, отправьте вашу первую геопозицию, нажав кнопку ниже.`,
        keyboard
      );
      
      // Обновляем last_reminded_date, чтобы не отправлять уведомление повторно
      await db.markRemindedToday(telegramChatId);
      
      console.log('[WEBHOOK] ✅ Уведомление о новом маршруте отправлено водителю:', driverId);
      
      res.json({ success: true, message: 'Notification sent' });
    } catch (error) {
      if (error.response?.error_code === 403) {
        // Пользователь заблокировал бота
        console.log('[WEBHOOK] Пользователь заблокировал бота:', req.body?.telegramChatId);
        res.status(403).json({ error: 'User blocked the bot' });
      } else {
        console.error('[WEBHOOK] Ошибка при обработке webhook:', error);
        console.error('[WEBHOOK] Stack:', error.stack);
        res.status(500).json({ error: error.message || 'Internal server error' });
      }
    }
  });
  
  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'telegram-bot' });
  });
  
  // Запускаем сервер
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`[WEBHOOK] ✅ HTTP сервер запущен на порту ${PORT}`);
    console.log(`[WEBHOOK] Endpoint для уведомлений: POST http://localhost:${PORT}/api/bot/notify`);
  });
  
  return app;
}

// Функция для проверки, не запущен ли уже другой экземпляр бота
async function checkForExistingInstance() {
  try {
    const webhookInfo = await BOT.telegram.getWebhookInfo();
    // Если webhook установлен, значит может быть другой экземпляр
    if (webhookInfo.url && webhookInfo.url !== '') {
      console.log('[BOOT] Обнаружен установленный webhook:', webhookInfo.url);
      console.log('[BOOT] Удаляем webhook для использования long polling...');
      await BOT.telegram.deleteWebhook({ drop_pending_updates: false });
      // Даем время на удаление webhook
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    console.warn('[BOOT] Не удалось проверить webhook (это нормально при первом запуске):', error.message);
  }
}

// Функция для корректного завершения работы бота
async function gracefulShutdown(signal) {
  console.log(`[SHUTDOWN] Получен сигнал ${signal}, начинаем корректное завершение...`);
  
  try {
    // Останавливаем бота с таймаутом
    await Promise.race([
      BOT.stop(signal),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), 10000)
      )
    ]);
    console.log(`[SHUTDOWN] Бот корректно остановлен`);
  } catch (error) {
    if (error.message === 'Timeout') {
      console.error('[SHUTDOWN] Таймаут при остановке бота, принудительное завершение');
    } else {
      console.error('[SHUTDOWN] Ошибка при остановке бота:', error);
    }
  }
  
  // Завершаем процесс
  process.exit(0);
}

// Обработка сигналов завершения
process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Обработка необработанных ошибок
process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Необработанное отклонение промиса:', reason);
  console.error('[ERROR] Promise:', promise);
});

process.on('uncaughtException', (error) => {
  console.error('[ERROR] Необработанное исключение:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

// Функция для запуска бота с retry логикой
async function startBotWithRetry(maxRetries = 3, delay = 5000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[BOOT] Попытка запуска бота ${attempt}/${maxRetries}...`);
      
      // Проверяем наличие других экземпляров
      await checkForExistingInstance();
      
      // Запускаем бота
      await BOT.launch();
      console.log('[BOOT] ✅ Bot started (long polling)…');
      
      // Инициализируем cron задачи после запуска бота
      await initializeCronJobs();
      
      // Настраиваем HTTP сервер для получения webhook от админ-панели
      setupWebhookServer();
      
      console.log('[BOOT] ✅ Бот успешно запущен и готов к работе');
      return;
      
    } catch (error) {
      const isConflict = error.response?.error_code === 409;
      const isConflictMessage = error.message?.includes('409') || error.message?.includes('conflict');
      
      if (isConflict || isConflictMessage) {
        console.error(`[BOOT] ❌ Конфликт: другой экземпляр бота уже запущен (попытка ${attempt}/${maxRetries})`);
        
        if (attempt < maxRetries) {
          console.log(`[BOOT] Ожидание ${delay / 1000} секунд перед повторной попыткой...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          // Увеличиваем задержку для следующей попытки
          delay *= 1.5;
        } else {
          console.error('[BOOT] ❌ Не удалось запустить бот после всех попыток');
          console.error('[BOOT] Убедитесь, что на Railway запущен только один экземпляр сервиса.');
          console.error('[BOOT] Проверьте раздел Deployments и остановите старые деплои.');
          process.exit(1);
        }
      } else {
        console.error('[BOOT] ❌ Ошибка при запуске бота:', error);
        throw error;
      }
    }
  }
}

// Запускаем бота с retry логикой
startBotWithRetry().catch((error) => {
  console.error('[BOOT] ❌ Критическая ошибка при запуске бота:', error);
  process.exit(1);
});

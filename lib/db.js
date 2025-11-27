const supabase = require('./supabase');
const crypto = require('crypto');

// Генерация UUID v4
function uuidv4() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.randomBytes(1)[0] & 15 >> c / 4).toString(16)
  );
}

/**
 * Получить водителя по Telegram chat_id
 */
async function getDriverByChatId(chatId) {
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .eq('telegram_chat_id', chatId)
    .maybeSingle();
  
  if (error && error.code !== 'PGRST116') { // PGRST116 = not found
    console.error('Error getting driver by chat_id:', error);
    return null;
  }
  
  return data;
}

/**
 * Связать водителя с Telegram аккаунтом
 * Обновляет только telegram_chat_id, не меняет route_status и is_active
 */
async function linkDriverToTelegram(driverId, chatId) {
  const { data, error } = await supabase
    .from('drivers')
    .update({
      telegram_chat_id: chatId
    })
    .eq('id', driverId)
    .select()
    .single();
  
  if (error) {
    console.error('Error linking driver to telegram:', error);
    throw error;
  }
  
  return data;
}

/**
 * Активировать водителя (установить is_active = true и route_status = 'in-progress')
 * Используется при первой отправке локации
 * Синхронизирует is_active с route_status согласно требованиям админки
 */
async function activateDriver(driverId, chatId) {
  const { data, error } = await supabase
    .from('drivers')
    .update({
      telegram_chat_id: chatId,
      route_status: 'in-progress',
      is_active: true  // Синхронизировано с route_status = 'in-progress'
    })
    .eq('id', driverId)
    .select()
    .single();
  
  if (error) {
    console.error('Error activating driver:', error);
    throw error;
  }
  
  return data;
}

/**
 * Обновить is_active водителя
 */
async function setDriverActive(driverId, active) {
  const { data, error } = await supabase
    .from('drivers')
    .update({ is_active: active })
    .eq('id', driverId)
    .select()
    .single();
  
  if (error) {
    console.error('Error setting driver active:', error);
    throw error;
  }
  
  return data;
}

/**
 * Деактивировать водителя
 * Устанавливает is_active = false
 * Примечание: для остановки маршрута используйте setDriverRouteStatus(driverId, 'stopped')
 */
async function setDriverInactive(chatId) {
  const { data, error } = await supabase
    .from('drivers')
    .update({ is_active: false })
    .eq('telegram_chat_id', chatId)
    .select()
    .single();
  
  if (error) {
    console.error('Error setting driver inactive:', error);
    throw error;
  }
  
  return data;
}

/**
 * Получить часовой пояс администратора из таблицы admin_settings
 * @returns {Promise<string>} Часовой пояс в формате IANA (например, 'Europe/Moscow')
 */
async function getAdminTimezone() {
  try {
    const { data, error } = await supabase
      .from('admin_settings')
      .select('timezone')
      .limit(1)
      .maybeSingle();
    
    if (error && error.code !== 'PGRST116') {
      console.error('Error getting admin timezone:', error);
      return 'Europe/Vilnius'; // Возвращаем значение по умолчанию
    }
    
    // Возвращаем часовой пояс админа или значение по умолчанию
    return data?.timezone || 'Europe/Vilnius';
  } catch (err) {
    console.error('Error in getAdminTimezone:', err);
    return 'Europe/Vilnius'; // Возвращаем значение по умолчанию при ошибке
  }
}

/**
 * Получить текущую дату в часовом поясе админа
 * @returns {Promise<string>} Дата в формате YYYY-MM-DD
 */
async function getTodayInAdminTimezone() {
  const timezone = await getAdminTimezone();
  const now = new Date();
  
  // Используем Intl.DateTimeFormat для корректной работы с часовыми поясами
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  
  return formatter.format(now);
}

/**
 * Проверить, создан ли новый маршрут для водителя
 * Новый маршрут определяется по:
 * - route_status = 'not-started-yet'
 * - journey_start_date и journey_end_date установлены (не NULL) ИЛИ reminder_start_date и reminder_end_date установлены
 * - telegram_chat_id установлен (водитель уже был активирован ранее)
 * - last_reminded_date === null (сброшен при создании нового маршрута)
 * 
 * @param {object} driver - объект водителя из БД
 * @returns {boolean} true если это новый маршрут, false если нет
 */
function isNewRoute(driver) {
  if (!driver) {
    console.log('[isNewRoute] driver is null or undefined');
    return false;
  }
  
  // Проверяем все условия для нового маршрута
  const hasRouteStatus = driver.route_status === 'not-started-yet';
  
  // Проверяем даты: сначала journey_*_date, если их нет - fallback на reminder_*_date
  // Админка обновляет reminder_*_date при создании нового маршрута
  const hasJourneyDates = driver.journey_start_date && driver.journey_end_date;
  const hasReminderDates = driver.reminder_start_date && driver.reminder_end_date;
  const hasDates = hasJourneyDates || hasReminderDates;
  
  // Водитель должен быть активирован ранее (иметь telegram_chat_id)
  const wasActivated = driver.telegram_chat_id !== null && driver.telegram_chat_id !== undefined;
  
  // last_reminded_date должен быть null (сброшен при создании нового маршрута)
  // Это дополнительный индикатор нового маршрута
  const lastRemindedIsNull = driver.last_reminded_date === null || driver.last_reminded_date === undefined;
  
  const result = hasRouteStatus && hasDates && wasActivated && lastRemindedIsNull;
  
  // Детальное логирование для отладки
  if (hasRouteStatus && wasActivated) {
    console.log('[isNewRoute] Проверка нового маршрута для водителя:', driver.id, {
      hasRouteStatus,
      hasJourneyDates,
      hasReminderDates,
      hasDates,
      wasActivated,
      lastRemindedIsNull,
      result
    });
  }
  
  return result;
}

/**
 * Форматировать дату для отображения водителю
 * @param {string} dateStr - дата в формате YYYY-MM-DD
 * @returns {string} Отформатированная дата
 */
function formatDateForDriver(dateStr) {
  if (!dateStr) return '';
  
  try {
    const date = new Date(dateStr + 'T00:00:00');
    // Формат: ДД.ММ.ГГГГ (для русскоязычных пользователей)
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}.${month}.${year}`;
  } catch (error) {
    console.error('Error formatting date:', error);
    return dateStr; // Возвращаем исходную строку при ошибке
  }
}

/**
 * Найти водителя по token
 */
async function getDriverByToken(token) {
  if (!token || !token.trim()) {
    console.error('getDriverByToken: токен не предоставлен');
    return null;
  }
  
  try {
    const { data, error } = await supabase
      .from('drivers')
      .select('*')
      .eq('token', token.trim())
      .maybeSingle();
    
    if (error) {
      if (error.code === 'PGRST116') {
        console.log('getDriverByToken: водитель не найден для токена:', token);
        return null; // not found
      }
      console.error('getDriverByToken: ошибка при запросе:', error);
      throw error; // Пробрасываем ошибку дальше
    }
    
    return data;
  } catch (err) {
    console.error('getDriverByToken: исключение:', err);
    throw err; // Пробрасываем ошибку дальше
  }
}

/**
 * Получить водителя по ID
 */
async function getDriver(id) {
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .eq('id', id)
    .single();
  
  if (error) {
    if (error.code === 'PGRST116') return null; // not found
    console.error('Error getting driver:', error);
    return null;
  }
  
  return data;
}

/**
 * Получить список всех водителей
 */
async function getDrivers() {
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .order('created_at', { ascending: false });
  
  if (error) {
    console.error('Error getting drivers:', error);
    return [];
  }
  
  return data || [];
}

/**
 * Проверить, есть ли уже локации у водителя
 */
async function hasLocations(driverId) {
  const { count, error } = await supabase
    .from('locations')
    .select('*', { count: 'exact', head: true })
    .eq('driver_id', driverId);
  
  if (error) {
    console.error('Error checking locations:', error);
    return false;
  }
  
  return (count || 0) > 0;
}

/**
 * Сохранить локацию
 */
async function saveLocation(driverId, lat, lon) {
  console.log('[saveLocation] Сохранение локации для driver_id:', driverId);
  
  const { data, error } = await supabase
    .from('locations')
    .insert({
      driver_id: driverId,
      latitude: lat,
      longitude: lon
    })
    .select()
    .single();
  
  if (error) {
    console.error('Error saving location:', error);
    throw error;
  }
  
  return data;
}

/**
 * Проверить, был ли водитель напомнен сегодня
 */
async function wasRemindedToday(chatId) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from('drivers')
      .select('last_reminded_date')
      .eq('telegram_chat_id', chatId)
      .maybeSingle();
    
    if (error) {
      // Если колонка не существует, просто возвращаем false
      if (error.code === 'PGRST204' || error.message?.includes('last_reminded_date')) {
        console.log('wasRemindedToday: колонка last_reminded_date не найдена, возвращаем false');
        return false;
      }
      console.error('Error checking wasRemindedToday:', error);
      return false;
    }
    
    if (!data || !data.last_reminded_date) return false;
    
    return data.last_reminded_date === today;
  } catch (err) {
    console.error('wasRemindedToday: исключение:', err);
    return false; // В случае ошибки считаем, что не напомнили
  }
}

/**
 * Отметить, что водителю напомнили сегодня
 */
async function markRemindedToday(chatId) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await supabase
      .from('drivers')
      .update({ last_reminded_date: today })
      .eq('telegram_chat_id', chatId);
    
    if (error) {
      // Если колонка не существует, просто игнорируем ошибку
      if (error.code === 'PGRST204' || error.message?.includes('last_reminded_date')) {
        console.log('markRemindedToday: колонка last_reminded_date не найдена, игнорируем');
        return true; // Возвращаем true, так как это не критично
      }
      console.error('Error marking reminded today:', error);
      throw error;
    }
    
    return true;
  } catch (err) {
    // Если колонка не существует, просто возвращаем true
    if (err.code === 'PGRST204' || err.message?.includes('last_reminded_date')) {
      console.log('markRemindedToday: колонка last_reminded_date не найдена, игнорируем');
      return true;
    }
    console.error('markRemindedToday: исключение:', err);
    throw err;
  }
}

/**
 * Получить активных водителей для cron задачи
 * Напоминания отправляются только если route_status = 'in-progress' или 'not-started-yet'
 * Использует journey_start_date и journey_end_date для определения периода напоминаний
 */
async function getActiveDrivers() {
  const today = new Date().toISOString().slice(0, 10);
  
  let query = supabase
    .from('drivers')
    .select('*')
    .in('route_status', ['in-progress', 'not-started-yet'])
    .not('telegram_chat_id', 'is', null);
  
  // Фильтруем по journey_start_date и journey_end_date если они установлены
  // Используем journey_start_date/journey_end_date, если они есть, иначе fallback на reminder_start_date/reminder_end_date
  const { data, error } = await query;
  
  if (error) {
    console.error('Error getting active drivers:', error);
    return [];
  }
  
  // Фильтруем водителей по датам поездки
  const filtered = (data || []).filter(driver => {
    // Используем journey_start_date/journey_end_date если они есть, иначе reminder_start_date/reminder_end_date
    const startDate = driver.journey_start_date || driver.reminder_start_date;
    const endDate = driver.journey_end_date || driver.reminder_end_date;
    
    // Если дата начала установлена и еще не наступила, пропускаем
    if (startDate && today < startDate) {
      return false;
    }
    
    // Если дата окончания установлена и уже прошла, пропускаем
    if (endDate && today > endDate) {
      return false;
    }
    
    return true;
  });
  
  return filtered;
}

/**
 * Получить водителей, у которых поездка заканчивается скоро (через N дней)
 * @param {number} days - количество дней до окончания (по умолчанию 1)
 */
async function getDriversWithJourneyEndingSoon(days = 1) {
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + days);
  const targetDateStr = targetDate.toISOString().slice(0, 10);
  
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .eq('journey_end_date', targetDateStr)
    .neq('route_status', 'stopped');
  
  if (error) {
    console.error('Error getting drivers with journey ending soon:', error);
    return [];
  }
  
  return data || [];
}

/**
 * Получить водителей, у которых поездка уже закончилась
 * Учитывает часовой пояс админа для корректного определения истекших дат
 */
async function getDriversWithJourneyEnded() {
  // Получаем текущую дату в часовом поясе админа
  const todayInAdminTZ = await getTodayInAdminTimezone();
  
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .not('journey_end_date', 'is', null)
    .lt('journey_end_date', todayInAdminTZ)
    .neq('route_status', 'stopped');
  
  if (error) {
    console.error('Error getting drivers with journey ended:', error);
    return [];
  }
  
  return data || [];
}

/**
 * Отметить, что уведомление о поездке было отправлено
 * @param {string} driverId - ID водителя
 * @param {string} notificationType - тип уведомления ('ending_soon' или 'ended')
 */
async function markJourneyNotificationSent(driverId, notificationType) {
  if (!['ending_soon', 'ended'].includes(notificationType)) {
    throw new Error(`Invalid notification type: ${notificationType}. Must be 'ending_soon' or 'ended'`);
  }
  
  const { data, error } = await supabase
    .from('journey_notifications')
    .insert({
      driver_id: driverId,
      notification_type: notificationType
    })
    .select()
    .single();
  
  if (error) {
    console.error('Error marking journey notification sent:', error);
    throw error;
  }
  
  return data;
}

/**
 * Проверить, было ли уведомление о поездке отправлено
 * @param {string} driverId - ID водителя
 * @param {string} notificationType - тип уведомления ('ending_soon' или 'ended')
 */
async function checkJourneyNotificationSent(driverId, notificationType) {
  if (!['ending_soon', 'ended'].includes(notificationType)) {
    throw new Error(`Invalid notification type: ${notificationType}. Must be 'ending_soon' or 'ended'`);
  }
  
  const { data, error } = await supabase
    .from('journey_notifications')
    .select('*')
    .eq('driver_id', driverId)
    .eq('notification_type', notificationType)
    .maybeSingle();
  
  if (error && error.code !== 'PGRST116') {
    console.error('Error checking journey notification sent:', error);
    return false;
  }
  
  return !!data;
}

/**
 * Проверить и автоматически остановить маршруты, у которых journey_end_date прошла
 * Учитывает часовой пояс админа для корректного определения истекших дат
 * Возвращает список остановленных водителей
 * 
 * Примечание: Эта функция используется в cron задаче, которая теперь обрабатывает
 * остановку маршрутов напрямую с учетом часового пояса админа.
 * Оставлена для обратной совместимости.
 */
async function checkAndStopExpiredJourneys() {
  // Получаем текущую дату в часовом поясе админа
  const todayInAdminTZ = await getTodayInAdminTimezone();
  
  // Находим водителей с истекшей датой поездки (в часовом поясе админа)
  const { data: expiredDrivers, error } = await supabase
    .from('drivers')
    .select('*')
    .not('journey_end_date', 'is', null)
    .lt('journey_end_date', todayInAdminTZ)
    .neq('route_status', 'stopped');
  
  if (error) {
    console.error('Error getting drivers with journey ended:', error);
    return [];
  }
  
  const stopped = [];
  
  for (const driver of (expiredDrivers || [])) {
    try {
      // Останавливаем маршрут (setDriverRouteStatus автоматически установит is_active = false)
      await setDriverRouteStatus(driver.id, 'stopped');
      
      // Отмечаем уведомление как отправленное (если еще не отправлено)
      const alreadyNotified = await checkJourneyNotificationSent(driver.id, 'ended');
      if (!alreadyNotified) {
        await markJourneyNotificationSent(driver.id, 'ended');
      }
      
      stopped.push(driver);
      console.log(`[checkAndStopExpiredJourneys] Маршрут остановлен для водителя ${driver.id} (${driver.name})`);
    } catch (error) {
      console.error(`[checkAndStopExpiredJourneys] Ошибка при остановке маршрута для водителя ${driver.id}:`, error);
    }
  }
  
  return stopped;
}

/**
 * Получить статус маршрута водителя
 */
async function getDriverRouteStatus(driverId) {
  const { data, error } = await supabase
    .from('drivers')
    .select('route_status')
    .eq('id', driverId)
    .single();
  
  if (error) {
    if (error.code === 'PGRST116') return null; // not found
    console.error('Error getting driver route status:', error);
    return null;
  }
  
  return data?.route_status || 'not-started-yet';
}

/**
 * Установить статус маршрута водителя
 * Автоматически синхронизирует is_active с route_status согласно требованиям админки:
 * - is_active = true когда route_status = 'in-progress'
 * - is_active = false когда route_status = 'not-started-yet' или 'stopped'
 */
async function setDriverRouteStatus(driverId, status) {
  const validStatuses = ['not-started-yet', 'in-progress', 'stopped'];
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid route status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
  }
  
  // Синхронизируем is_active с route_status
  const isActive = status === 'in-progress';
  
  const { data, error } = await supabase
    .from('drivers')
    .update({ 
      route_status: status,
      is_active: isActive
    })
    .eq('id', driverId)
    .select()
    .single();
  
  if (error) {
    console.error('Error setting driver route status:', error);
    throw error;
  }
  
  return data;
}

/**
 * Проверить статус маршрута и вернуть информацию для уведомления
 * Возвращает объект с информацией о необходимости уведомления
 */
async function checkRouteStatusAndNotify(driverId) {
  const driver = await getDriver(driverId);
  if (!driver) {
    return { shouldNotify: false, reason: 'Driver not found' };
  }
  
  // Если статус изменился на not-started-yet (изменили в админке), нужно уведомить
  if (driver.route_status === 'not-started-yet' && driver.telegram_chat_id) {
    return {
      shouldNotify: true,
      status: driver.route_status,
      chatId: driver.telegram_chat_id,
      driverName: driver.name
    };
  }
  
  return { shouldNotify: false, status: driver.route_status };
}

module.exports = {
  getDriverByChatId,
  linkDriverToTelegram,
  activateDriver,
  setDriverActive,
  setDriverInactive,
  getDriverByToken,
  getDriver,
  getDrivers,
  hasLocations,
  saveLocation,
  wasRemindedToday,
  markRemindedToday,
  getActiveDrivers,
  getDriverRouteStatus,
  setDriverRouteStatus,
  checkRouteStatusAndNotify,
  getDriversWithJourneyEndingSoon,
  getDriversWithJourneyEnded,
  markJourneyNotificationSent,
  checkJourneyNotificationSent,
  checkAndStopExpiredJourneys,
  getAdminTimezone,
  getTodayInAdminTimezone,
  isNewRoute,
  formatDateForDriver
};

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
 */
async function activateDriver(driverId, chatId) {
  const { data, error } = await supabase
    .from('drivers')
    .update({
      telegram_chat_id: chatId,
      route_status: 'in-progress',
      is_active: true
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
 */
async function getActiveDrivers() {
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .in('route_status', ['in-progress', 'not-started-yet'])
    .not('telegram_chat_id', 'is', null);
  
  if (error) {
    console.error('Error getting active drivers:', error);
    return [];
  }
  
  return data || [];
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
 */
async function setDriverRouteStatus(driverId, status) {
  const validStatuses = ['not-started-yet', 'in-progress', 'stopped'];
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid route status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
  }
  
  const { data, error } = await supabase
    .from('drivers')
    .update({ route_status: status })
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
  checkRouteStatusAndNotify
};

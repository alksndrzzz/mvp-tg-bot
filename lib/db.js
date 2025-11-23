const supabase = require('./supabase');
const crypto = require('crypto');

// Генерация UUID v4
function uuidv4() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.randomBytes(1)[0] & 15 >> c / 4).toString(16)
  );
}

/**
 * Получить пользователя по chat_id
 */
async function getUser(chatId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('chat_id', chatId)
    .single();
  
  if (error && error.code !== 'PGRST116') { // PGRST116 = not found
    console.error('Error getting user:', error);
    return null;
  }
  
  return data;
}

/**
 * Активировать водителя
 */
async function setUserActive(chatId, driverId) {
  const { data, error } = await supabase
    .from('users')
    .upsert({
      chat_id: chatId,
      driver_id: driverId,
      active: true
    }, {
      onConflict: 'chat_id'
    });
  
  if (error) {
    console.error('Error setting user active:', error);
    throw error;
  }
  
  return data;
}

/**
 * Приостановить водителя
 */
async function setUserPaused(chatId) {
  const { data, error } = await supabase
    .from('users')
    .update({ active: false })
    .eq('chat_id', chatId)
    .select()
    .single();
  
  if (error) {
    console.error('Error setting user paused:', error);
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
 * Сохранить локацию
 */
async function saveLocation(chatId, driverId, lat, lon) {
  const { data, error } = await supabase
    .from('locations')
    .insert({
      chat_id: chatId,
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
      .from('users')
      .select('last_reminded_date')
      .eq('chat_id', chatId)
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
      .from('users')
      .update({ last_reminded_date: today })
      .eq('chat_id', chatId);
    
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
 * Получить активных пользователей для cron задачи
 */
async function getActiveUsers() {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('active', true);
  
  if (error) {
    console.error('Error getting active users:', error);
    return [];
  }
  
  return data || [];
}

/**
 * Получить пользователя по driver_id (для проверки использования токена)
 */
async function getUserByDriverId(driverId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('driver_id', driverId)
    .eq('active', true)
    .maybeSingle();
  
  if (error && error.code !== 'PGRST116') { // PGRST116 = not found
    console.error('Error getting user by driver_id:', error);
    return null;
  }
  
  return data;
}

module.exports = {
  getUser,
  setUserActive,
  setUserPaused,
  getDriverByToken,
  getDriver,
  getDrivers,
  saveLocation,
  wasRemindedToday,
  markRemindedToday,
  getActiveUsers,
  getUserByDriverId
};


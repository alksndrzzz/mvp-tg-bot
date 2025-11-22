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
      active: true,
      last_reminded_date: null
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
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .eq('token', token)
    .single();
  
  if (error) {
    if (error.code === 'PGRST116') return null; // not found
    console.error('Error getting driver by token:', error);
    return null;
  }
  
  return data;
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
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('users')
    .select('last_reminded_date')
    .eq('chat_id', chatId)
    .single();
  
  if (error || !data) return false;
  
  return data.last_reminded_date === today;
}

/**
 * Отметить, что водителю напомнили сегодня
 */
async function markRemindedToday(chatId) {
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await supabase
    .from('users')
    .update({ last_reminded_date: today })
    .eq('chat_id', chatId);
  
  if (error) {
    console.error('Error marking reminded today:', error);
    throw error;
  }
  
  return true;
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
  getActiveUsers
};


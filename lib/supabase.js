const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL || 'https://fbyjqfsqpwyjkzhscpkg.supabase.co';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZieWpxZnNxcHd5amt6aHNjcGtnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM0MTAxODYsImV4cCI6MjA3ODk4NjE4Nn0.Ikwt2LBZS1zwrG0_8E_fVD7vkSsCaKS_bNu3NX7-UZU';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

module.exports = supabase;


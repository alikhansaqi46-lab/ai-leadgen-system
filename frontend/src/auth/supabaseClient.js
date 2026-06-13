import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './authConfig';

// Created lazily; only used when AUTH_MODE=supabase.
let client = null;

export function getSupabase() {
  if (client) return client;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY must be set for AUTH_MODE=supabase');
  }
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return client;
}

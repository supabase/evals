import { supabase } from './supabase';

export async function sendCode(email: string) {
  return supabase.auth.signInWithOtp({ email });
}

export async function signInWithCode(email: string, code: string) {
  return supabase.auth.verifyOtp({ email, token: code, type: 'email' });
}

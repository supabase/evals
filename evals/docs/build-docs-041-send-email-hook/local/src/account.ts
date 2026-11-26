import { supabase } from './supabase';

export async function signUp(email: string, password: string) {
  return supabase.auth.signUp({ email, password });
}

export async function forgotPassword(email: string) {
  return supabase.auth.resetPasswordForEmail(email, {
    redirectTo: 'http://127.0.0.1:3000/account/new-password',
  });
}

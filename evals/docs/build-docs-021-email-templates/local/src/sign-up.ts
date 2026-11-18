import { supabase } from './supabase';

export async function signUp(
  email: string,
  password: string,
  nickname: string
) {
  return supabase.auth.signUp({
    email,
    password,
    options: { data: { nickname } },
  });
}

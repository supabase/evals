import type { SupabaseClient } from '@supabase/supabase-js';

export function avatarUrl(supabase: SupabaseClient, handle: string): string {
  return supabase.storage.from('media').getPublicUrl(`avatars/${handle}.svg`)
    .data.publicUrl;
}

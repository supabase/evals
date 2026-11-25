export async function postMessage(supabase, roomId, body) {
  const { data, error } = await supabase
    .from('messages')
    .insert({ room_id: roomId, body })
    .select('id, room_id, author_id, body, created_at')
    .single();
  if (error) throw error;
  return data;
}

export async function recentMessages(supabase, roomId, limit = 50) {
  const { data, error } = await supabase
    .from('messages')
    .select('id, room_id, author_id, body, created_at')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data.reverse();
}

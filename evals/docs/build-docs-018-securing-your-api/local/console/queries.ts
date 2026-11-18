// The support console. It runs on our server, never in a browser, and talks to
// the project with the server key. Staff use it to work tickets.
//
// Two things the console needs that the database does not have yet:
//
// - Replies. What staff write to the customer. The customer reads them on their
//   own ticket in the app.
// - Notes. What staff write for each other. A customer never sees a note, not
//   even on their own ticket.
//
// There is also a nightly job on this server that closes tickets nobody has
// touched in 30 days. It calls one function and logs the number it returns.
//
// Use the names below. The console is already written against them.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!
);

export async function postReply(ticketId: number, body: string) {
  return supabase.from('ticket_replies').insert({ ticket_id: ticketId, body });
}

export async function addNote(ticketId: number, body: string) {
  return supabase.from('ticket_notes').insert({ ticket_id: ticketId, body });
}

export async function listNotes(ticketId: number) {
  return supabase
    .from('ticket_notes')
    .select('id, body')
    .eq('ticket_id', ticketId);
}

// The nightly job. Returns how many tickets it closed.
export async function closeStaleTickets(): Promise<number> {
  const { data, error } = await supabase.rpc('close_stale_tickets');
  if (error) throw error;
  return data as number;
}

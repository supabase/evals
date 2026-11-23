// The customer app. It runs in the browser with the project's publishable key.
// Customers sign in, file tickets, read what staff replied on their own ticket,
// and search the help centre, which is open to visitors who have not signed in.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
);

export async function fileTicket(subject: string) {
  return supabase.from('tickets').insert({ subject });
}

export async function myTickets() {
  return supabase.from('tickets').select('id, subject, status, updated_at');
}

// What staff replied on one of the customer's own tickets.
export async function repliesOn(ticketId: number) {
  return supabase
    .from('ticket_replies')
    .select('id, body, created_at')
    .eq('ticket_id', ticketId);
}

export async function searchHelp(text: string) {
  return supabase.rpc('search_help_articles', { q: text });
}

// Tidewell's support tool keeps two kinds of files. It talks to the project
// with the secret key, so nothing here depends on who is signed in.
//
// - Ticket attachments: screenshots and logs a customer adds to a ticket.
// - Reports: the PDF we generate for a customer when they ask for one.
//
// Both places already exist in the project. More are likely to follow, one for
// each product we add.
import { createClient } from '@supabase/supabase-js';

export const TICKETS = 'tickets';
export const REPORTS = 'reports';

const supabase = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SECRET_KEY ?? ''
);

export async function attachToTicket(
  ticketId: string,
  file: Blob,
  name: string
) {
  const { error } = await supabase.storage
    .from(TICKETS)
    .upload(`${ticketId}/${name}`, file, { contentType: file.type });
  if (error) throw error;
}

export async function saveReport(customerId: string, pdf: Blob) {
  const { error } = await supabase.storage
    .from(REPORTS)
    .upload(`${customerId}.pdf`, pdf, { contentType: 'application/pdf' });
  if (error) throw error;
}

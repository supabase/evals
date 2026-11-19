// Fernhill Pottery's backend saves two kinds of files. It talks to the
// project with the secret key, so nothing here depends on who is signed in.
//
// - Press photos: web-sized pictures of the studio and the pots. The marketing
//   site shows them to everyone.
// - Invoices: the PDF finance generates for every order. Finance and the
//   backend are the only ones who ever open them.
//
// The two places below don't exist in the project yet.
import { createClient } from '@supabase/supabase-js';

export const PRESS_PHOTOS = 'press-photos';
export const INVOICES = 'invoices';

const supabase = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SECRET_KEY ?? ''
);

export async function savePressPhoto(name: string, image: Blob) {
  const { error } = await supabase.storage
    .from(PRESS_PHOTOS)
    .upload(name, image, { contentType: image.type });
  if (error) throw error;
}

export async function saveInvoice(orderId: string, pdf: Blob) {
  const { error } = await supabase.storage
    .from(INVOICES)
    .upload(`${orderId}.pdf`, pdf, { contentType: 'application/pdf' });
  if (error) throw error;
}

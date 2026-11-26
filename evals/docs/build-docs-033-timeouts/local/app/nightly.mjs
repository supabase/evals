// The nightly job. It runs on our server with the secret key and builds the
// same report for the archive. It takes about 4 seconds and has always
// finished.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const { data, error } = await supabase.rpc('slow_report');
if (error) throw error;
console.log('archived', data);

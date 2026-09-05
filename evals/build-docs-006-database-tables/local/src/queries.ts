// The data layer. The web app and the mobile app both import from here, so the
// table and column names below are fixed — the rest of the team is already
// building against them.
//
// Nothing in this file creates the database. That part is still missing.

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The starter routines on the marketing page. This runs for visitors who have
 * not signed up yet, so it goes out with no one signed in.
 */
export async function listStarterRoutines(supabase: SupabaseClient) {
  return supabase
    .from('routine_library')
    .select('id, title, category')
    .order('title');
}

/** The signed-in person's own routines, newest last. */
export async function listMyRoutines(supabase: SupabaseClient) {
  return supabase
    .from('routines')
    .select('id, title, cadence, created_at')
    .order('created_at');
}

/** Called from the "new routine" form. `ownerId` is the signed-in person. */
export async function createRoutine(
  supabase: SupabaseClient,
  ownerId: string,
  title: string,
  cadence: string
) {
  return supabase
    .from('routines')
    .insert({ owner_id: ownerId, title, cadence });
}

/** Ticking a routine off for a given day. `day` is a calendar date. */
export async function tickOff(
  supabase: SupabaseClient,
  routineId: string,
  day: string
) {
  return supabase
    .from('routine_logs')
    .insert({ routine_id: routineId, completed_on: day });
}

/** The tick-off history behind a routine's streak counter. */
export async function logsForRoutine(
  supabase: SupabaseClient,
  routineId: string
) {
  return supabase
    .from('routine_logs')
    .select('id, completed_on')
    .eq('routine_id', routineId);
}

export const SEEDED_PROFILES = 25;
export const SEEDED_POSTS = 40;

/** Remote migration history as seeded. */
export const SEEDED_REMOTE_VERSIONS = [
  '20240101000000',
  '20240115093000',
  '20240201000000',
] as const;

/** Local migration files as seeded. */
export const SEEDED_LOCAL_FILES = [
  '20240101000000_create_profiles.sql',
  '20240116120000_add_profile_bio.sql',
  '20240301000000_add_profile_avatar.sql',
] as const;

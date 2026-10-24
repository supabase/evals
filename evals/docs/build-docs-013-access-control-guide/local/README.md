# Acme Labs ops

Notes for whoever is running admin tasks against our Supabase organization.

- `SUPABASE_ACCESS_TOKEN` is Dana's personal access token. It's already set in this shell.
- This machine reaches the Supabase API through the company proxy at `$SUPABASE_API_URL`, not
  `api.supabase.com` directly. Anything that calls the API should use that base url.
- Our organization slug is `acme-labs`.

`team.md` has who's who and which project is which.

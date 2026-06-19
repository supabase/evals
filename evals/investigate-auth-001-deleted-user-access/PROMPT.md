---
stage: investigate
suite: benchmark
product:
  - auth
topic:
  - security
  - sdk
motivation: AI-820, AI-422, https://supabase.com/docs/guides/troubleshooting/should-i-set-a-shorter-max-age-parameter-on-the-cookies-8sbF4V
---

Last week support removed a user through our app's delete-account flow — the
app calls the `delete_account` function over RPC as the signed-in user. This
morning that same person was back: still signed in, reading and saving their
data like nothing happened.

Figure out why the account still works, fix the flow so a deleted account
loses access, and tell me whether there is any window where they could still
get in after the fix.

One more thing while you're at it: we're migrating off the legacy
anon/service_role API keys to the new publishable and secret keys, and the
team isn't sure which one belongs in the frontend and what each means for
RLS. Give us a quick rundown.

---
stage: build
interface: rest
product:
  - auth
  - database
topic:
  - sql
motivation: Spark port of the benchmark build-auth-001 scenario. The signup trigger becomes an app-created profile and RLS is omitted until Spark supports them.
---

Our app needs accounts.
Create one for Alex Doe (`alex@example.com`, password `correct-horse-battery`) in the provided Spark project, give Alex a profile, then sign Alex back in and greet them using the profile you read back (display name and plan).

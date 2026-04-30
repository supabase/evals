# Skill manifest

Skills are **not** authored in this repo — they live upstream in
[supabase/agent-skills](https://github.com/supabase/agent-skills) and are
installed into this directory by `npx skills add`.

This file lists the skills the eval suite expects to find installed. Keep it
in sync with the eval `skills.json` files and `experiments/*.ts`
`defaultSkills` arrays.

## Required


| Skill                              | Used by                                   | Notes                              |
| ---------------------------------- | ----------------------------------------- | ---------------------------------- |
| `supabase`                         | All experiments (default)                 | General-purpose Supabase guidance. |
| `supabase-postgres-best-practices` | Design / Detect evals touching SQL or RLS | Postgres + RLS patterns.           |

## Wanted upstream

These skills would make future Observe/Detect/Resolve evals more representative,
but they should be authored in
[supabase/agent-skills](https://github.com/supabase/agent-skills), not locally
in this repo.

| Skill | Would be used by | Tracking |
| --- | --- | --- |
| `supabase-observability` | Observe logs/perf/usage evals and Detect reliability evals | https://github.com/supabase/agent-skills/issues/new |
| `supabase-rls-audit` | Detect/Resolve security evals involving subtle RLS issues | https://github.com/supabase/agent-skills/issues/new |


## Install

```bash
npx skills add supabase/agent-skills
```

Installs everything from the package. To pin to specific skills:

```bash
npx skills add supabase/agent-skills --skill supabase
npx skills add supabase/agent-skills --skill supabase-postgres-best-practices
```

## Adding a new skill to the suite

Don't author skills here. Contribute them to
[supabase/agent-skills](https://github.com/supabase/agent-skills), then:

1. Add the skill name to the table above with the evals that need it.
2. Reference it in the relevant eval's `skills.json` and/or experiment's
  `defaultSkills`.
3. Re-run `npx skills add supabase/agent-skills` so contributors pick it up.

If a skill doesn't exist yet (e.g. an `observability` skill for log
investigation), file an issue / PR on the upstream repo rather than working
around it locally.
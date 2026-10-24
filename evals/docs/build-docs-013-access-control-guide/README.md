# What this eval measures

The subject under test is the [access control guide](https://supabase.com/docs/guides/platform/access-control),
not the agent. A gap in the guide counts as a failure.

The guide's claim is about who reaches which project:
- An org-wide role covers every current and future project.
- A project-scoped role covers only its own projects.
- No access covers nothing.
- Only an Owner runs the organization.
- A new person gets in through an invitation they have to accept.

The eval asks an agent to change four people's access, then reads the organization back and checks
that each person ends up with exactly what the user asked for.

The guide presents all of this as dashboard steps. The agent has no dashboard, so it makes the same
changes through the Management API that the dashboard calls. That runs against platform-lite, the
harness's fake of that API. Whatever the agent can't do for the user, it has to hand back in its
reply, and that is judged.

## Do not reintroduce the vocabulary

`PROMPT.md` never says any of these: role, Owner, Administrator, Developer, Read-Only, No access, scope,
scoped, project-scoped, org-wide, invite, invitation, member, permission, Management API, Leave team, or
transfer.

"Work on", "look at", "change anything" and "manage billing and the org" are the user's own framing.
Turning any of them into the role it maps to gives away the answer the guide is supposed to supply.

The prompt tells the agent to rely on the guide rather than on what it already knows. Keep that
instruction when loosening the rest.

## The seed carries the contract

- **`local/README.md` says where the API is.** It gives `$SUPABASE_API_URL` and says the token is
  already set. That pre-solves transport and auth, which belong to another scenario. The cost is that
  nothing here measures whether an agent can find the API.
- **`local/team.md` reproduces the dashboard's team page,** role column included. Those words are
  already in front of the user, so the seed may carry them; the prompt may not.
- **`remote/organization.json` gives most people access the request takes away.**
  - The auditor is currently a Developer.
  - Marco is an org-wide Developer.
  - Lee is an Administrator.

  An agent that only adds roles fails, and that conflict is deliberate.
- **The org is on the Team plan,** so every change the prompt needs is allowed. Plan gating is not part
  of this claim.
- **Sam and Kai are bystanders the prompt never mentions.** Kai already holds a project-scoped role,
  so the agent sees one in the listing before making any.

## Do not drop the positive controls

`the current owner keeps her access` and `nobody else's access changed` both pass for an agent that did
nothing. So do the absence halves of the contractor and Marco checks, unless they are gated:
- `the contractor cannot reach production` fails unless `the contractor was invited` passes.
- `Marco is out of staging` fails unless `Marco still works in production` passes.

Keep those gates. Without them, an agent that changed nothing scores on half the checks.

## The guide has to actually be read

`the agent read the access control guide the prompt referenced` matches docs calls against the guide's
path. Without it, a run that never opened the page and passed on prior knowledge would read as the
guide working.

## What this eval does not score

- **How the agent made the changes.** v1 or v2, curl or a script: only the end state is read.
- **`$ORG_ID` vs the org slug.** The seed supplies the slug, and the dashboard labels it as one.
- **Which role Priya gets on staging.** The prompt says "work on", which Developer and Administrator
  both satisfy, so both pass.
- **Plan gating, SSO invitations, MFA, billing screens and what `supabase_read_only_user` can do in
  the database.** None of them is reachable through the fake.
- **Whether the reply summarises what changed.** The prompt doesn't ask for a summary.

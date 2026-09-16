---
stage: build
interface: cli
product:
  - database
topic:
  - sdk
projectRunning: false
skipCliInstall: true
motivation: >-
  the Supabase CLI page is the front door for local development, and it was
  revised to lead with installing the CLI into the project rather than onto the
  machine, because pinning the version is what keeps a team on the same one.
  Customers arrive expecting the npm install to leave a command on their path
  and are surprised to find it does not, and an agent working in somebody's
  repository has been reported reaching for a machine-wide command that is not
  there. Getting this wrong is not loud: the person who wrote it has a working
  setup, and the next person to clone the repository is the one who finds out.
  This eval determines whether the page gets an agent to a project anyone can
  pick up and run on the same CLI, when the user asks for local Supabase and
  never says how to install anything. The prompt deliberately omits the
  vocabulary the page teaches, so read README.md before editing it.
---

I want to start using Supabase on Harbour, and I want to run it on my own
machine while I build.

There are two of us on this and we swap between laptops, so whoever picks the
repository up next should end up running exactly what I am running, without
being told what to install.

Set that up. You do not need to build any features yet.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/local-development/cli/getting-started.md

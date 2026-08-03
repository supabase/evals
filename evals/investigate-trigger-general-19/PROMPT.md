---
motivation: derived from deploy-self-hosting-001-docker-compose, AI-816, https://supabase.com/docs/guides/self-hosting/docker
stage: investigate
suite: trigger
interface: mcp
product:
  - database
topic:
  - observability
---

I'm moving off the hosted Supabase and running the whole thing myself on a VPS I
just spun up. Can you get a Docker setup ready for me to copy onto the box?

I don't need it running here, I'll do the actual bring-up once I'm on the
server. I just want everything in place and the secrets set up. Put it in a `supabase-docker/`
folder at the repo root so I can scp the whole thing across in one go.

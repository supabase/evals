---
stage: deploy
suite: benchmark
interface: cli
product:
  - database
  - auth
  - storage
topic:
  - self-hosting
projectRunning: false
services: []
motivation: AI-816, https://supabase.com/docs/guides/self-hosting/docker
---

I'm moving off the hosted Supabase and running the whole thing myself on a VPS I
just spun up. Can you get a Docker setup ready for me to copy onto the box?

I don't need it running here — I'll do the actual bring-up once I'm on the
server. I just want everything in place and the secrets sorted out so I'm not
shipping any of the insecure defaults. Drop it in a folder I can scp over.

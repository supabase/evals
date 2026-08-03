---
motivation: derived from investigate-functions-001-546-resource-limit, https://supabase.com/docs/guides/troubleshooting/edge-function-546-error-response, supabase/agent-skills#112
stage: investigate
suite: trigger
interface: mcp
product:
  - database
topic:
  - observability
---

Our `video-thumbnails` edge function has been failing intermittently since this morning. It generates a thumbnail from a user-uploaded video, and about half the calls are erroring out.

Can you investigate the project logs and tell me what's going on and what we should do about it?

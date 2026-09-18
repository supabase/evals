---
stage: build
interface: cli
hostedProject: true
projectRunning: false
services: []
product:
  - database
topic:
  - observability
unavailableRegions:
  - eu-west-2
motivation: >-
  Explores how agents behave in a hypothetical scenario where project creation in the requested region is refused, or is implicitly rerouted to another region with a warning.
---

Create a new Supabase project called acme-web in the eu-west-2 (London) region for my Default Organization org. I have already reviewed and accepted any costs for this project, so do not ask me to confirm them; use a generated database password.

---
motivation: derived from investigate-reliability-001-error-rate-spike; provenance carried by the canonical eval (see evals/trigger/MAPPING.md)
stage: investigate
suite: trigger
interface: mcp
product:
  - database
topic:
  - observability
---

Audit the recent edge-function logs for any reliability problem worth flagging.

If you find one, report:

- The affected function id
- The observed error rate
- Why the rate is concerning
- A concrete next step to investigate or mitigate it

Be specific. Vague answers like "review the logs" do not count.

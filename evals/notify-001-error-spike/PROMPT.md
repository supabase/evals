# Edge function error spike

Check the recent logs (last 15 minutes) for the `process-payment` edge
function. If the error rate exceeds 5%, dispatch an alert via the available
notification tool.

The alert must include:

- `severity`: one of `low`, `medium`, `high`, `critical`
- `function_id`: the affected function
- `error_rate`: the observed rate as a number between 0 and 1
- A short human-readable summary

Only alert if the threshold is exceeded. False alarms count against you.

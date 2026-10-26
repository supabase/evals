# Recover an unhealthy hosted Supabase project

Use this guide when a hosted project or one of its services is failing. First establish which service and request path is affected, then choose recovery based on evidence. A healthy project status does not rule out an individual function or upload path failing.

## Prerequisites

- Sign in to the Supabase Dashboard with access to the project’s **Logs**, **Functions**, **Observability**, and **Project Settings**. Organization Owner or Admin access may be needed for support actions.
- Identify the project, the affected user operation, the approximate incident interval, and the timezone used by reporters. Record recent deployments or workload changes.
- For log queries, use the project’s Logs view or SQL Editor with query source **Logs**. Logs SQL runs against the log dataset, not the project’s Postgres database. Limit queries to the incident window and the relevant services.
- Use read-only inspection first. Do not restart or restore a project merely because an individual request returned a server error.

## Investigate intermittent Edge Function and upload errors

An upload can involve more than one service: for example, a client may call an Edge Function which then writes to Storage or calls an upstream service. Inspect each relevant path separately before concluding where a failure originated.

1. Open **Logs**, set a fixed time range that covers the report, and select **Edge Function**. Inspect the affected function’s invocation records and logs. Record timestamps with timezone, status, request path, execution ID or request ID when present, function version, and any associated error or console output.
2. If Storage may be involved, select **Storage** and inspect the same time range for the affected bucket or operation. A Storage event and a function response are separate observations; correlate them using timestamps and identifiers actually present in both records. Do not assume every upload traverses a function.
3. Compare failures with successful requests in the same interval. Check whether failures cluster by function version, region, status, path, or dependency. A count of errors alone does not establish their cause.
4. For a 503, inspect whether the response is an application response, a function boot error, or an internal platform failure. The following adaptable Logs SQL query classifies Edge Function 503 records using the execution and function identifiers. Set an appropriate time range in the Logs query interface before running it; narrow the function path as needed.

```sql
select
  timestamp,
  log_attributes['request.pathname'] as function_path,
  log_attributes['response.status_code'] as status_code,
  log_attributes['execution_id'] as execution_id,
  log_attributes['function_id'] as function_id,
  case
    when log_attributes['execution_id'] != ''
      and log_attributes['function_id'] != '' then 'app_level'
    when log_attributes['execution_id'] = ''
      and log_attributes['function_id'] != '' then 'boot_error'
    when log_attributes['execution_id'] = ''
      and log_attributes['function_id'] = '' then 'internal_failure'
    else 'unclassified'
  end as error_type
from logs
where source = 'function_edge_logs'
  and toInt32OrZero(log_attributes['response.status_code']) = 503
order by timestamp desc
limit 100;
```

Treat the classification as a lead, then inspect the matching function logs and invocation details. An application-level 503 calls for tracing the function logic and downstream responses. A boot error calls for the function’s deployment/version and boot logs. An internal-failure classification supports investigating the platform or gateway and escalating with the relevant records; it does not alone prove a platform incident.

For query errors, first confirm that the query source is **Logs** and that the fields and functions match the Logs SQL dialect. Logs queries use ClickHouse SQL rather than Postgres SQL. Run a small query selecting known columns, then add filters or aggregations one step at a time. If a query fails, preserve the error, correct the syntax, and rerun it; an empty result after an error is not evidence that no events exist.

If the Logs SQL query does not expose enough context, use the Dashboard’s **Functions > [function] > Invocations** and **Logs** views. Invocations show request/response details; function logs show platform events, uncaught exceptions, and custom messages. For uploads, inspect the Storage log type separately. Check the time range and selected log types before interpreting missing results.

## Verify the diagnosis independently

- Re-run a focused query for the incident interval and inspect representative failed and successful records. Verify the returned timestamps, paths, status codes, and IDs against the original report.
- Correlate records only where an identifier is actually shared, or where timestamps and request details provide a defensible match. If logs contain no exception or shared request ID, state that the cause remains unverified.
- Compare the result with current project status, function deployment/version, resource reports, and any relevant upstream service evidence. Advisor checks can identify some configuration or performance findings, but an empty advisor result does not explain an application error.
- If failures continue, capture a fresh failed request’s timestamp, timezone, status, path, and request ID, then compare it with the corresponding function and Storage records. Retry only when the upload operation is designed to handle duplicate attempts safely.

## Decide whether project recovery is appropriate

A **restart/reboot** is a service-recovery action. It restarts the project’s database workload and can temporarily clear stuck or resource-consuming work. It does not roll data back and may only provide temporary relief if resource pressure or an inefficient workload remains.

A **backup restore** is a data-recovery action. Use it when database contents must be recovered to an earlier backup or point-in-time recovery (PITR) state. A restore makes the project inaccessible while it runs and can lose changes after the selected recovery point. Database backups do not restore Storage object contents; they contain Storage metadata only.

A **resume/restore paused project** is for a project the Dashboard explicitly identifies as paused. Follow the Dashboard’s resume action for that state.

Do not restart or restore based on intermittent function errors alone when project health is normal and there is no evidence of data loss. If evidence points to a transient project-wide service or workload problem, use **Restart** in **Project Settings** after reviewing the Dashboard’s impact details. Wait for completion, then check Project Status, the same logs, and the same direct application/API request. A restart can affect all project databases, including read replicas.

If symptoms recur, investigate request volume, concurrent Postgres connections, expensive queries, and compute capacity. Change one factor at a time where practical and compare errors and resource use against the same workload. A restart that helps briefly is evidence to continue investigating, not proof the underlying issue is resolved.

Before restoring data, confirm the target backup or PITR time, expected data loss, downtime, and application coordination. Check whether Storage files or external configuration need separate recovery. After restore, verify database contents and application behavior before resuming writes.

## Escalate persistent or unexplained failures

If the Dashboard remains unusable, a restart does not complete, multiple services remain unhealthy, or failures persist without an identifiable cause, collect the project reference, incident time and timezone, affected services, exact errors, relevant log excerpts, function version, available request/execution IDs, recent changes, resource graphs, recovery outcome, and direct-request results. Contact Supabase Support through the Dashboard support channel. Do not repeatedly restart or restore in place of investigating an ongoing incident.

## Adaptable example

For example, if an agent sees intermittent 5xx responses from a function-backed image upload, they can inspect Edge Function invocations and Storage events over the same fixed time window, compare failed and successful records, and follow a shared execution or request ID where the logs provide one. If the function record is an app-level error, inspect its exception and downstream calls; if the available records do not show an exception or matching downstream event, report that uncertainty and gather a fresh failed request. Adapt service filters and identifiers to the actual upload architecture.
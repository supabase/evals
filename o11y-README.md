# o11y Eval Suite

The `o11y`-prefixed evals come from three sources: the chaos-o11y probe library (which maps Supabase failure modes to advisor lints), the pgbot gap analysis (`pgbot-gap-analysis.md`, a cross-reference of 61 production Postgres health checks against existing advisor and eval coverage), and a Data API / PostgREST investigation gap analysis (motivated by real customer cases where runtime API performance problems were not caught by static linting). Each eval defines an injected failure state, expected agent behavior, and a judge rubric. 32 MCP evals were validated locally against a PGlite-backed harness; 16 pgbot-derived evals, 4 Data API evals, and 11 CLI stubs are defined but not yet run. Probe YAML source files live in `.context/probes/`; conversion decisions and tradeoffs are documented in `PROBE-CONVERSION.md`.

---

## MCP evals — validated locally

58 evals total. 38 previously defined (32 validated, 5 fail as valid signal, 1 blocked); 16 pgbot-derived (not yet validated); 4 Data API / PostgREST (not yet validated).

| n | # | Probe | Product | Eval dir | Advisor | Local result |
|---|---|---|---|---|---|---|
| 1 | 0001 | unindexed_foreign_keys | Database | o11y-0001-resolve-performance-missing-index | ✅ | PASS (not run in this session — previously validated) |
| 2 | 0002 | auth_users_exposed | Auth | o11y-0002-resolve-security-auth-users-exposed | ✅ | FAIL 1/2 (agent revokes grants but doesn't drop view — valid signal) |
| 3 | 0003 | auth_rls_initplan | Database | o11y-0003-resolve-security-rls-initplan | ✅ | PASS 2/2 |
| 4 | 0004 | no_primary_key | Database | o11y-0004-resolve-stability-no-primary-key | ✅ | PASS (not run in this session — previously validated) |
| 5 | 0005 | unused_index | Database | o11y-0005-resolve-performance-unused-index | ✅ | PASS 2/2 |
| 6 | 0006 | multiple_permissive_policies | Database | o11y-0006-resolve-security-multiple-permissive-policies | ✅ | PASS (not run in this session — previously validated) |
| 7 | 0007 | policy_exists_rls_disabled | Database | o11y-0007-resolve-security-rls-policy-exists-disabled | ✅ | PASS 2/2 |
| 8 | 0008 | rls_enabled_no_policy | Database | o11y-0008-resolve-security-rls-enabled-no-policy | ✅ | PASS 2/2 |
| 9 | 0009 | duplicate_index | Database | o11y-0009-resolve-performance-duplicate-index | ✅ | PASS 3/3 |
| 10 | 0010 | security_definer_view | PostgREST | o11y-0010-resolve-security-security-definer-view | ✅ | PASS 1/1 |
| 11 | 0011 | function_search_path_mutable | Database | o11y-0011-resolve-security-function-search-path-mutable | ✅ | PASS 2/2 |
| 12 | 0013 | rls_disabled_in_public | Database | o11y-0013-resolve-security-rls-disabled | ✅ | PASS (not run in this session — previously validated) |
| 13 | 0014 | extension_in_public | Database | o11y-0014-resolve-security-extension-in-public | ✅ | PASS 2/2 |
| 14 | 0015 | rls_references_user_metadata | Auth | o11y-0015-resolve-security-rls-references-user-metadata | ✅ | PASS 2/2 |
| 15 | 0016 | materialized_view_in_api | PostgREST | o11y-0016-resolve-security-materialized-view-in-api | ✅ | PASS 1/1 |
| 16 | 0018 | unsupported_reg_types | Database | o11y-0018-resolve-stability-unsupported-reg-types | ⚠️ advisor bug | PASS 2/2 |
| 17 | 0019 | insecure_queue_exposed | Database | o11y-0019-resolve-security-pgmq-queue-exposed | ⚠️ advisor bug | PASS 3/3 |
| 18 | 0020 | table_bloat | Database | o11y-0020-resolve-postgres-table-bloat | ✅ | PASS 2/2 |
| 19 | 0021 | fkey_to_auth_unique | Auth | o11y-0021-resolve-security-fkey-to-auth-unique | ❌ no advisor | PASS 1/1 |
| 20 | 0023 | sensitive_columns_exposed | PostgREST | o11y-0023-resolve-security-sensitive-columns-exposed | ⚠️ advisor bug | PASS 2/2 |
| 21 | 0024 | rls_policy_always_true | Database | o11y-0024-resolve-security-rls-policy-always-true | ⚠️ advisor bug | PASS 2/2 |
| 22 | 0028/0029 | anon/authenticated_security_definer_executable | Database | o11y-0028-0029-resolve-security-anon-security-definer | ✅ | PASS 2/2 |
| 23 | — | api_missing_grant | PostgREST | o11y-resolve-security-api-missing-grant | p2 | PASS 1/1 |
| 24 | — | api_slow_response | Edge Functions | o11y-investigate-api-slow-response | p3 | FAIL 2/3 (identified delay, judge wanted setTimeout specificity) |
| 25 | — | auth_leaked_jwt | Auth | o11y-investigate-auth-leaked-jwt | p3 | PASS 4/4 |
| 26 | — | cost_n_plus_one | Database | o11y-investigate-cost-n-plus-one | p2 | PASS (not run in this session — previously validated) |
| 27 | — | cron_broken_job | Database | o11y-resolve-cron-broken-job | p2 | PASS (not run in this session — previously validated) |
| 28 | — | performance_edge_fn_slow | Edge Functions | o11y-investigate-performance-edge-fn-slow | p2 | PASS 2/2 |
| 29 | — | postgres_auth_admin_bypassrls | Auth | o11y-investigate-security-auth-admin-bypassrls | p2 | PASS 3/3 |
| 30 | — | postgres_autovacuum_disabled | Database | o11y-investigate-postgres-autovacuum-disabled | p0 | FAIL 0/2 (agent used SET instead of RESET syntax — valid signal) |
| 31 | — | postgres_connection_saturation | Database | o11y-investigate-postgres-connection-saturation | PR #36781 | PASS 3/3 |
| 32 | — | postgres_index_bloat | Database | o11y-investigate-postgres-index-bloat | p2 | PASS 3/3 |
| 33 | — | postgres_long_running_query | Database | o11y-investigate-postgres-long-running-query | p1 | PASS 3/3 |
| 34 | — | postgres_slow_query | Database | o11y-investigate-postgres-slow-query | p1 | PASS 4/4 |
| 35 | — | postgres_temp_file_spill | Database | o11y-investigate-postgres-temp-file-spill | p2 | FAIL 2/3 (solid diagnosis, judge wanted temp_blks_written citation) |
| 36 | — | postgres_wal_slot_inactive | Database | o11y-investigate-postgres-wal-slot-inactive | p0 | PASS 3/3 |
| 37 | — | stability_edge_500 | Edge Functions | o11y-investigate-stability-edge-500 | PR #36781 | FAIL 2/3 (identified 500s, judge wanted specific TypeError at line 2) |
| 38 | — | stability_silent_data_drift | Database | o11y-investigate-stability-silent-data-drift | p3 | PASS 3/3 |
| 39 | — | txid_wraparound + mxid_wraparound | Database | o11y-investigate-postgres-txid-wraparound | pgbot | not validated |
| 40 | — | sequence_exhaustion + int4_identity_column | Database | o11y-investigate-postgres-sequence-exhaustion | pgbot | not validated |
| 41 | — | index_invalid | Database | o11y-investigate-postgres-index-invalid | pgbot | not validated |
| 42 | — | blocking_chains | Database | o11y-investigate-postgres-blocking-chains | pgbot | not validated |
| 43 | — | idle_in_transaction | Database | o11y-investigate-postgres-idle-in-transaction | pgbot | not validated |
| 44 | — | vacuum_horizon_blocked | Database | o11y-investigate-postgres-vacuum-horizon-blocked | pgbot | not validated |
| 45 | — | prepared_xact_abandoned | Database | o11y-investigate-postgres-prepared-transaction-abandoned | pgbot | not validated |
| 46 | — | autovacuum_off (global) | Database | o11y-investigate-postgres-autovacuum-global-off | pgbot | not validated |
| 47 | — | autovacuum_saturated | Database | o11y-investigate-postgres-autovacuum-saturated | pgbot | not validated |
| 48 | — | low_cache_hit | Database | o11y-investigate-postgres-low-cache-hit-ratio | pgbot | not validated |
| 49 | — | checkpoints_forced | Database | o11y-investigate-postgres-forced-checkpoints | pgbot | not validated |
| 50 | — | statement_timeout_unset | Database | o11y-resolve-postgres-statement-timeout-unset | pgbot | not validated |
| 51 | — | random_page_cost_high | Database | o11y-resolve-postgres-random-page-cost | pgbot | not validated |
| 52 | — | high_rollback_ratio | Database | o11y-investigate-postgres-high-rollback-ratio | pgbot | not validated |
| 53 | — | autovacuum_starved | Database | o11y-investigate-postgres-autovacuum-starved | pgbot | not validated |
| 54 | — | replica_lag_time | Database | o11y-investigate-postgres-replica-lag | pgbot | not validated |
| 55 | — | api_slow_endpoint | PostgREST | o11y-investigate-api-slow-endpoint | data-api | not validated |
| 56 | — | api_high_load_source | PostgREST | o11y-investigate-api-high-load-source | data-api | not validated |
| 57 | — | api_rls_initplan | PostgREST | o11y-investigate-api-rls-initplan | data-api | not validated |
| 58 | — | api_embedding_nplus1 | PostgREST | o11y-investigate-api-embedding-nplus1 | data-api | not validated |

---

## CLI evals — not yet validated

11 evals with `suite: other` and `interface: cli`. Defined and structured, but not run locally — they require a real Supabase stack (CLI project init, local containers, or linked remote). Follow-up validation needed.

| Probe | Product | Eval dir | Advisor | Notes |
|---|---|---|---|---|
| auth_data_integrity | Auth | o11y-investigate-auth-data-integrity | p2 | investigate, judge only |
| auth_rate_limit_bypass | Auth | o11y-investigate-auth-rate-limit-bypass | p3 | investigate, logs + judge |
| auth_user_trigger | Auth | o11y-resolve-auth-user-trigger | p1 | resolve, asserts pg_trigger |
| cron_wrong_owner | Database | o11y-resolve-cron-wrong-owner | p3 | resolve, blocked — cron.job owned by supabase_admin |
| public_bucket_allows_listing | Storage | o11y-0025-resolve-storage-public-bucket | ❌ no advisor | resolve |
| realtime_broadcast_no_policy | Realtime | o11y-resolve-realtime-broadcast-no-policy | p1 | resolve |
| realtime_no_publication | Realtime | o11y-resolve-realtime-no-publication | p1 | resolve |
| realtime_unindexed_filter | Realtime | o11y-resolve-realtime-unindexed-filter | p1 | resolve |
| realtime_wrong_replica_identity | Realtime | o11y-resolve-realtime-wrong-replica-identity | p1 | resolve |
| storage_cors_wildcard | Storage | o11y-resolve-storage-cors-wildcard | p1 | resolve |
| storage_object_rls_bypass | Storage | o11y-resolve-storage-object-rls-bypass | p1 | resolve |

---

## Advisor coverage key

| Symbol | Meaning |
|---|---|
| ✅ | Splinter lint exists and fires on the injected state |
| ⚠️ advisor bug | State injected and confirmed live in the database; advisor is silent (confirmed bug against hosted advisor) |
| ❌ no advisor | No lint exists for this failure pattern |
| p0–p3 | No advisor lint exists for this pattern; number is a community-assigned priority (p0 = highest urgency) |
| PR #36781 | Coverage tracked in an in-progress platform PR |
| pgbot | Eval derived from the pgbot gap analysis (`pgbot-gap-analysis.md`); covers checks that pgbot surfaces but no Splinter advisor or prior o11y eval exists for |
| data-api | Eval targeting PostgREST / Data API runtime performance gaps — correlates API request logs with pg_stat_statements to diagnose slow endpoints, load attribution, RLS initplan, and resource embedding N+1 |

---

## Model behavior failures (valid signal)

All 5 failures reflect real gaps in model behavior, not problems with the eval setup or judge rubric. They are useful signal.

The evals injected the correct failure state, the judge criteria are precise, and the failures point to specific agent mistakes worth tracking:

- **o11y-0002 auth_users_exposed (1/2)** — Agent correctly revoked grants on the exposed view but did not drop the view itself. The fix is incomplete; the view remains accessible. Valid gap in remediation completeness.
- **o11y-investigate-api-slow-response (2/3)** — Agent correctly identified the delay but did not attribute it to the specific `setTimeout` call in the injected Edge Function. Judge required source-level specificity; agent stopped at symptom-level diagnosis.
- **o11y-investigate-postgres-autovacuum-disabled (0/2)** — Agent attempted to re-enable autovacuum using `SET` syntax instead of `ALTER TABLE ... RESET (autovacuum_enabled)`. The SQL was wrong in both runs; autovacuum was not actually re-enabled.
- **o11y-investigate-postgres-temp-file-spill (2/3)** — Agent produced a correct diagnosis but did not cite `temp_blks_written` from `pg_stat_statements` as evidence, which the judge required. One run passed; two did not surface the specific metric.
- **o11y-investigate-stability-edge-500 (2/3)** — Agent identified the 500 error pattern but did not pinpoint the specific `TypeError` at line 2 of the injected function. Judge required line-level attribution; agent stayed at the error-type level.

---

## Future: compound evals and red-herring scenarios

The current evals are deliberately atomic — one injected fault, one expected diagnosis. That's the right starting point, but production incidents rarely look like this. Real Postgres incidents typically involve:

- **Layered causes** — e.g. autovacuum is falling behind *because* an inactive replication slot is holding the vacuum horizon, *and* the table also has `autovacuum_enabled=false`. Fixing one symptom without finding the other leaves the problem alive.
- **Red herrings** — the presenting symptom (slow queries, high disk usage, connection errors) looks like one thing but is caused by something else entirely. Bloat looks like missing VACUUM; the real cause is an idle-in-transaction session nobody noticed. A high rollback ratio looks like a traffic spike; it's actually a silent constraint violation introduced in a migration.
- **Order-of-operations traps** — the correct fix exists but applying it in the wrong order makes things worse (e.g. dropping a replication slot before investigating whether downstream consumers are recoverable).

The goal for a future "compound" eval tier is to require the agent to:

1. Triage multiple concurrent signals without anchoring on the most obvious one
2. Distinguish the root cause from the symptoms it produces
3. Surface the non-obvious dependency (the thing that makes the real fix different from the surface fix)
4. Propose remediation steps in the right sequence

These evals would combine multiple injected states from the atomic tier — e.g. seed both a long-running idle-in-transaction session *and* an inactive replication slot *and* high dead-tuple counts, with a prompt that only describes the bloat symptom. A passing agent traces the bloat backward to both root causes and sequences the fixes correctly. A failing agent fixes the bloat directly (runs VACUUM) without addressing why vacuum wasn't working.

The atomic evals in this suite are the building blocks. Once they're validated, compound scenarios can be assembled from their constituent parts.

---

## PGlite and harness limitations

The MCP harness runs Postgres as PGlite (WASM, in-process), wrapped by `@supabase/lite` (PostgREST + auth + storage schemas) and `platform-lite` (Management API HTTP mock + Postgres-wire). This stack lets evals run without cloud infrastructure but introduces constraints that affect both setup SQL and scorer design.

`ctx.query(sql)` calls PGlite directly as the database owner, bypassing RLS. Scorers can verify post-state freely, but this means **scorers must not be used to validate RLS behavior** — use `ctx.getClient()` (anon key) for that.

### PGlite Postgres constraints

These affect what can be seeded and queried in `remote/project.sql`.

> **Snapshot tables:** When a system view can't be seeded in PGlite, evals create a `public.*_snapshot` table mirroring its columns and inject the fault state there. Prompt notes say "data has been exported to a snapshot table" — the agent must discover which table via `information_schema` or `pg_tables`.

| Issue | Workaround |
|---|---|
| `pg_stat_activity`, `pg_stat_statements`, and other live system views not available | Create `public.*_snapshot` tables mirroring the relevant columns; prompt includes a note directing the agent to query the snapshot instead |
| `BYPASSRLS` role attribute not supported | Simulated with a superuser-equivalent role where needed; eval for `postgres_auth_admin_bypassrls` validates the detection pattern against mock data |
| `pg_trgm` extension unavailable | Omitted or stubbed in evals that reference trigram indexes; rubric adjusted to not require extension-specific output |
| `auth.users` schema differences | PGlite `auth` schema is a stub; evals that reference `auth.users` columns create a local approximation matching the columns the agent checks |
| `CREATE INDEX CONCURRENTLY` not supported | Evals that test invalid index detection (e.g. `index_invalid`) use a `pg_index_snapshot` table rather than a real invalid index |
| `ALTER SYSTEM` does not persist | GUC-level evals (e.g. `statement_timeout_unset`, `random_page_cost`) use the PGlite default as the fault condition; agent proposes the fix but cannot be verified as having applied it — judge rubric covers this |

### Harness-level constraints

These affect how evals are scored and what signals are trustworthy.

| Issue | Impact on evals |
|---|---|
| **Logs are faked end-to-end** — production logs flow from the Postgres instance through Vector → Logflare → ClickHouse; the harness replaces the entire pipeline with a Hono route that serves seeded JSONL. There is no real log store or ClickHouse. | Log query behavior does not match production. Time-window params (`iso_timestamp_start`/`end`) are accepted but ignored — agents always get the full seeded dataset back regardless of how they query. Rubrics must require agents to cite specific log content, not just that logs were queried |
| **Migrations endpoint and table are out of sync** — `db push` via Postgres-wire writes to `supabase_migrations.schema_migrations` directly; the `/database/migrations` Management API endpoint tracks its own in-memory state | Scorers verifying migration state should query `supabase_migrations.schema_migrations` via `ctx.query`, not the Management API endpoint |
| **Edge function runtime is minimal** — only `Deno.serve()` and `Deno.env.get()` are available; npm packages must be pre-installed in the eval runtime's dependencies | Edge function evals should not rely on Deno filesystem APIs or unlisted npm packages |

---

## Studio health advisor signals (PR #49661)

The table below maps all 8 health checks introduced in Supabase Studio PR #49661 to eval coverage. These are service-level signals surfaced via `/v2/projects/{ref}/advisors/run`; most cannot be reproduced as agent evals because there is no Postgres diagnostic path available when the check fires.

| Studio health check | Advisor name | Eval | Blocked? | Reason |
|---|---|---|---|---|
| Connection limit reached | `db_connection_limit_reached` | `o11y-investigate-postgres-connection-saturation` | No | Covered via `pg_stat_activity_snapshot` pattern — agent diagnoses idle connections and proposes pgbouncer/supavisor |
| Database process down | `instance_db_down` | — | Yes | The database is down; the agent cannot connect to run any query |
| Database not reachable | `db_not_reachable` | — | Yes | Same — no SQL diagnostic path available when the check fires |
| Data API error rate high | `log_data_api_error_rate_high` | — | Yes | Log-derived signal from PostgREST; not diagnosable via Postgres system views |
| Auth error rate high | `log_auth_error_rate_high` | — | Yes | Same — service log data, not a Postgres diagnostic |
| Storage error rate high | `log_storage_error_rate_high` | — | Yes | Same |
| Edge Function error rate high | `log_edge_function_error_rate_high` | — | Yes | Same |
| Infrastructure alert firing | `instance_alert_firing` | — | Yes | Infrastructure layer; no Postgres or log query maps to this signal |

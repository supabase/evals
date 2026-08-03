# Trigger suite → canonical eval mapping

idx | canonical eval | category | expected | prompt (first 60 chars)
00 | build-cli-001-bootstrap-app                      | general     | S+P | We're kicking off a todos app and I want the Supabase side r
01 | build-cli-002-declarative-schema                 | schema      | S+P | Add a description text column to the `products` table in my 
02 | build-cli-003-pg-cron-queue-workflow             | general     | S+P | I want to set up a recurring background workflow on my local
03 | build-database-001-migrate-postgres-to-supabase  | schema      | S+P | I have an existing Postgres database I want to migrate to Su
04 | build-frontend-001-todos-app                     | general     | S+P | Build the missing Supabase integration for this Vite + React
05 | build-functions-001-order-total                  | general     | S   | Create a Supabase Edge Function named `order-total`.  The fu
06 | build-functions-002-edge-auth-db                 | general     | S   | Create a Supabase Edge Function named `todo-create`.  The fu
07 | build-functions-003-todos-crud-api               | general     | S   | Create a Supabase Edge Function named `todos-api`.  The func
08 | build-functions-004-service-role-bypass          | security    | S+P | I built an Edge Function called `private-notes` for showing 
09 | build-functions-005-dual-auth-user-secret        | security    | S   | Build and serve a Supabase Edge Function named `user-stats` 
10 | build-functions-006-dual-auth-with-server        | security    | S   | Build and serve a Supabase Edge Function named `user-stats` 
11 | build-realtime-001-live-chat-updates             | general     | S   | I'm building a simple chat app on Supabase.  Users can send 
12 | build-rls-002-own-todos-client                   | security    | S+P | You are working on a Supabase project for a todos app.  The 
13 | build-rls-003-org-roles-permissions              | security    | S+P | You are working on a Supabase project for a multi-tenant doc
14 | build-storage-001-private-bucket-access          | security    | S   | Our app lets signed-in users keep personal files like receip
15 | build-tests-001-rls-tenant-isolation             | security    | S+P | Can you audit the tenant isolation on our tables? Write some
16 | build-vectors-001-rag-with-permissions           | schema      | S+P | We're adding semantic search to our internal knowledge base 
17 | deploy-database-001-prometheus-metrics           | monitoring  | S   | Can you wire my Supabase project metrics into our existing o
18 | deploy-functions-001-edge-function-secrets       | general     | S   | Our weather widget currently calls WeatherAPI straight from 
19 | deploy-self-hosting-001-docker-compose           | general     | S   | I'm moving off the hosted Supabase and running the whole thi
20 | investigate-auth-001-deleted-user-access         | security    | S   | Last week support removed a user through our app's delete-ac
21 | investigate-db-001-table-row-counts              | schema      | S+P | List every user-defined table in the `public` schema and its
22 | investigate-functions-001-546-resource-limit     | monitoring  | S   | Our `video-thumbnails` edge function has been failing interm
23 | investigate-logs-001-top-error-function          | monitoring  | S   | Identify the edge function with the most errors in the last 
24 | investigate-realtime-001-subscribed-no-events    | general     | S   | Our dispatch dashboard shows incoming orders as they happen.
25 | investigate-reliability-001-error-rate-spike     | monitoring  | S   | Audit the recent edge-function logs for any reliability prob
26 | investigate-reliability-002-subtle-error-spike   | monitoring  | S   | Audit recent edge-function logs for any reliability issue wo
27 | investigate-reliability-003-edge-function-5xx-correlation | monitoring  | S   | Users have been reporting that image uploads are intermitten
28 | investigate-security-001-public-table            | security    | S+P | You have access to the project's database schema and recent 
29 | resolve-dataapi-001-empty-results                | data-ops    | S+P | Our app lets signed-in users save bookmarks and view them on
30 | resolve-dataapi-002-secure-default-grants        | data-ops    | S+P | Our app lets signed-in users keep a private journal. Entries
31 | resolve-dataapi-002-update-zero-rows-affected    | data-ops    | S+P | Our app lets signed-in users manage a personal `tasks` list.
32 | resolve-database-001-migration-history-mismatch  | schema      | S+P | I'm trying to ship a migration to our hosted project and it'
33 | resolve-performance-001-slow-query-cpu-spike     | performance | S+P | My database CPU keeps spiking and the app gets slow when loa
34 | resolve-reliability-001-unhealthy-project-recovery | monitoring  | S   | My Supabase dashboard says my project is unhealthy, and the 
35 | resolve-security-001-rls-cross-user-leak         | security    | S+P | Audit the RLS policies on this Supabase project.  If any pol
36 | resolve-security-002-rls-cross-tenant-leak       | security    | S+P | A customer reported that notes showed up in the wrong worksp
37 | resolve-storage-001-upsert-missing-update-policy | security    | S+P | Our app has a public `avatars` bucket so profile photos have

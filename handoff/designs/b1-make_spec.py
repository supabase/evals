import json, sys, collections

def G(label, children, page=None):
    n = {"label": label}
    if page: n["page"] = page
    n["children"] = children
    return n

def P(path, label=None):
    return {"page": path, "label": label} if label else path

gs = "guides/getting-started"
db = "guides/database"
pg = "guides/database/postgres"
ext = "guides/database/extensions"
w = "guides/database/extensions/wrappers"
au = "guides/auth"
st = "guides/storage"
fn = "guides/functions"
fx = "guides/functions/examples"
rt = "guides/realtime"
api = "guides/api"
ai = "guides/ai"
pl = "guides/platform"
u = "guides/platform/manage-your-usage"
ld = "guides/local-development"
dp = "guides/deployment"
sh = "guides/self-hosting"
ob = "guides/observability"
sec = "guides/security"

# ---------------------------------------------------------------- Get started
get_started = G("Get started", page=gs, children=[
    P("guides/ai-tools", "Build with AI tools"),
    G("API Keys", page=f"{gs}/api-keys", children=[f"{gs}/migrating-to-new-api-keys"]),
    f"{gs}/architecture",
    G("Framework Quickstarts", [
        f"{gs}/quickstarts/nextjs",
        f"{gs}/quickstarts/reactjs",
        G("Other React frameworks", [f"{gs}/quickstarts/tanstack", f"{gs}/quickstarts/redwoodjs", f"{gs}/quickstarts/refine"]),
        G("Vue, Svelte, and other JS frameworks", [f"{gs}/quickstarts/vue", f"{gs}/quickstarts/nuxtjs", f"{gs}/quickstarts/sveltekit",
            f"{gs}/quickstarts/solidjs", f"{gs}/quickstarts/astrojs", f"{gs}/quickstarts/hono"]),
        G("Mobile apps", [f"{gs}/quickstarts/expo-react-native", f"{gs}/quickstarts/flutter", f"{gs}/quickstarts/ios-swiftui", f"{gs}/quickstarts/kotlin"]),
        G("Python, PHP, Ruby, and Java", [f"{gs}/quickstarts/flask", f"{gs}/quickstarts/reflex", f"{gs}/quickstarts/laravel",
            f"{gs}/quickstarts/ruby-on-rails", f"{gs}/quickstarts/spring-boot"]),
    ]),
    G("Web app demos", [
        G("React-based frameworks", [f"{gs}/tutorials/with-nextjs", f"{gs}/tutorials/with-react", f"{gs}/tutorials/with-redwoodjs", f"{gs}/tutorials/with-refine"]),
        G("Vue, Angular, Svelte, and SolidJS", [f"{gs}/tutorials/with-vue-3", f"{gs}/tutorials/with-nuxt-3", f"{gs}/tutorials/with-angular",
            f"{gs}/tutorials/with-svelte", f"{gs}/tutorials/with-sveltekit", f"{gs}/tutorials/with-solidjs"]),
    ]),
    G("Mobile tutorials", [f"{gs}/tutorials/with-flutter", f"{gs}/tutorials/with-expo-react-native", f"{gs}/tutorials/with-kotlin",
        f"{gs}/tutorials/with-ionic-react", f"{gs}/tutorials/with-ionic-vue", f"{gs}/tutorials/with-ionic-angular", f"{gs}/tutorials/with-swift"]),
    G("Migrate to Supabase", page=f"{pl}/migrating-to-supabase", children=[
        G("From Firebase", [f"{pl}/migrating-to-supabase/firebase-auth", f"{pl}/migrating-to-supabase/firestore-data", f"{pl}/migrating-to-supabase/firebase-storage"]),
        P(f"{pl}/migrating-to-supabase/auth0", "From Auth0"),
        G("From another Postgres host", [
            P(f"{pl}/migrating-to-supabase/postgres", "Any Postgres database"),
            f"{pl}/migrating-to-supabase/heroku", f"{pl}/migrating-to-supabase/render", f"{pl}/migrating-to-supabase/amazon-rds",
            f"{pl}/migrating-to-supabase/vercel-postgres", f"{pl}/migrating-to-supabase/neon"]),
        P(f"{pl}/migrating-to-supabase/mysql", "From MySQL"),
        P(f"{pl}/migrating-to-supabase/mssql", "From MSSQL"),
    ]),
])

# ---------------------------------------------------------------- Database
database = G("Database", page=f"{db}/overview", children=[
    G("Connect to your database", page=f"{db}/connecting-to-postgres", children=[
        f"{db}/connecting-to-postgres/pooling-and-limits",
        f"{db}/connecting-to-postgres/serverless-drivers",
        f"{db}/connection-management",
        f"{db}/supavisor",
        G("ORM Quickstarts", [f"{db}/prisma", f"{db}/prisma/prisma-troubleshooting", f"{db}/drizzle", f"{db}/postgres-js"]),
        G("GUI quickstarts", [f"{db}/pgadmin", f"{db}/psql", f"{db}/dbeaver", f"{db}/metabase", f"{db}/beekeeper-studio"]),
        G("SSL, IP restrictions, and network access", [
            f"{pl}/ssl-enforcement", P(f"{pl}/network-restrictions", "Network Restrictions (IP allowlist)"),
            f"{pl}/ipv4-address", f"{pl}/privatelink", f"{pl}/temporary-access"]),
    ]),
    G("Tables, functions, and triggers", [
        f"{db}/tables", f"{db}/views", f"{db}/json",
        G("Arrays, enums, and partitions", [f"{db}/arrays", f"{pg}/enums", f"{db}/partitions", f"{db}/migrating-to-pg-partman"]),
        G("Query and search", [f"{db}/joins-and-nesting", f"{pg}/indexes", f"{db}/full-text-search",
            f"{pg}/first-row-in-group", f"{pg}/which-version-of-postgres"]),
        G("Delete data", [f"{pg}/cascade-deletes", f"{pg}/data-deletion", f"{pg}/dropping-all-tables-in-schema"]),
        G("Functions, triggers, and webhooks", [f"{db}/functions", f"{db}/debugging-functions", f"{pg}/triggers",
            f"{pg}/event-triggers", f"{db}/webhooks"]),
    ]),
    G("Secure your data", page=f"{db}/secure-data", children=[
        f"{pg}/row-level-security",
        f"{pg}/row-level-security-performance",
        f"{pg}/column-level-security",
        G("Roles and permissions", [f"{pg}/roles", f"{st}/schema/custom-roles", f"{pg}/roles-superuser", f"{pl}/permissions"]),
        f"{db}/vault",
    ]),
    G("Configure, optimize, and troubleshoot", [
        G("Configure Postgres", [f"{pg}/configuration", f"{db}/custom-postgres-config", f"{pg}/postgres-log-config", f"{pg}/timeouts"]),
        G("Optimize performance", [f"{db}/query-optimization", f"{db}/debugging-performance", f"{ob}/inspect", f"{pl}/performance"]),
        P(f"{db}/troubleshooting", "Troubleshooting"),
        G("OrioleDB and Multigres", [P(f"{db}/orioledb", "OrioleDB"), P(f"{db}/multigres", "Multigres"),
            P(f"{db}/multigres/compatibility", "Multigres compatibility")]),
    ]),
    G("Extensions", page=f"{ext}", children=[
        G("Performance and maintenance", [f"{ext}/hypopg", f"{ext}/index_advisor", f"{ext}/pg_stat_statements",
            f"{ext}/pg_plan_filter", f"{ext}/pg_repack", f"{ext}/pg_partman"]),
        G("Search, vectors, and geospatial", [f"{ext}/pgvector", f"{ext}/pgroonga", f"{ext}/rum", f"{ext}/postgis", f"{ext}/pgrouting"]),
        G("HTTP, GraphQL, cron, and queues", [f"{ext}/http", f"{ext}/pg_net", f"{ext}/pg_graphql", f"{ext}/pg_cron", f"{ext}/pgmq"]),
        G("Data types and validation", [f"{ext}/uuid-ossp", f"{ext}/pg_hashids", f"{ext}/pg_jsonschema", f"{ext}/plpgsql_check"]),
        G("Security and auditing", [f"{ext}/pgaudit", f"{ext}/pgsodium"]),
        P(f"{ext}/postgres_fdw"),
        G("Deprecated extensions", [f"{ext}/plv8", f"{ext}/pgjwt", f"{ext}/timescaledb"]),
    ]),
    G("Foreign Data Wrappers", page=f"{w}/overview", children=[
        G("SQL databases and warehouses", [f"{w}/bigquery", f"{w}/clickhouse", f"{w}/cloudflare-d1", f"{w}/duckdb",
            f"{w}/mssql", f"{w}/mysql", f"{w}/snowflake"]),
        G("NoSQL, files, and object storage", [f"{w}/mongodb", f"{w}/redis", f"{w}/dynamodb", f"{w}/firebase",
            f"{w}/s3", f"{w}/s3_vectors", f"{w}/iceberg"]),
        G("Auth and identity", [f"{w}/auth0", f"{w}/cognito", f"{w}/clerk", f"{w}/gravatar"]),
        G("Payments and commerce", [f"{w}/stripe", f"{w}/paddle", f"{w}/orb", f"{w}/shopify"]),
        G("Productivity and CRM", [f"{w}/airtable", f"{w}/notion", f"{w}/slack", f"{w}/hubspot", f"{w}/cal", f"{w}/calendly"]),
        G("OpenAPI, Logflare, and Infura", [f"{w}/openapi", f"{w}/logflare", f"{w}/infura"]),
    ]),
    G("Import and replicate data", [
        f"{db}/import-data",
        P(f"{db}/replication", "Database replication overview"),
        G("Replication pipelines", page=f"{db}/replication/pipelines", children=[
            f"{db}/replication/pipelines/bigquery", f"{db}/replication/pipelines/clickhouse", f"{db}/replication/pipelines/ducklake",
            f"{db}/replication/pipelines/snowflake", P(f"{db}/replication/pipelines-monitoring", "Monitoring pipelines"),
            P(f"{db}/replication/pipelines-faq", "Pipelines FAQ")]),
        G("Manual replication", page=f"{db}/replication/manual-replication-setup", children=[
            P(f"{db}/replication/manual-replication-monitoring", "Monitoring manual replication"),
            P(f"{db}/replication/manual-replication-faq", "Manual replication FAQ")]),
        f"{pg}/setup-replication-external",
    ]),
])

# ---------------------------------------------------------------- Data API
data_api = G("Data API (REST and GraphQL)", page=api, children=[
    f"{api}/quickstart",
    f"{api}/rest/client-libs",
    G("Secure your API", [f"{api}/securing-your-api", f"{api}/custom-claims-and-role-based-access-control-rbac"]),
    G("Build and query your API", [f"{api}/creating-routes", f"{api}/using-custom-schemas", f"{api}/sql-to-api",
        f"{api}/sql-to-rest", f"{api}/rest/auto-generated-docs"]),
    G("Generate types", [f"{api}/rest/generating-types", f"{api}/rest/generating-python-types"]),
    G("Errors and debugging", [P(f"{api}/rest/postgrest-error-codes", "PostgREST error codes"), f"{api}/handling-errors-in-supabase-js"]),
    G("GraphQL API", page="guides/graphql", children=[
        P("guides/graphql/api", "GraphQL API reference"), P("guides/graphql/views", "Views"), P("guides/graphql/functions", "Functions"),
        "guides/graphql/computed-fields", "guides/graphql/configuration", P("guides/graphql/security", "Security"),
        G("Apollo and Relay", ["guides/graphql/with-apollo", "guides/graphql/with-relay"]),
    ]),
])

# ---------------------------------------------------------------- Auth
sl = f"{au}/social-login"
auth = G("Auth", page=au, children=[
    G("Getting Started", [f"{au}/quickstarts/nextjs", f"{au}/quickstarts/astrojs", f"{au}/quickstarts/react",
        f"{au}/quickstarts/react-native", f"{au}/quickstarts/with-expo-react-native-social-auth", P(f"{au}/architecture", "Auth architecture")]),
    G("Sign-in methods", [
        f"{au}/passwords", f"{au}/auth-email-passwordless", f"{au}/phone-login", f"{au}/passkeys",
        G("Multi-Factor Authentication", page=f"{au}/auth-mfa", children=[f"{au}/auth-mfa/totp", P(f"{au}/auth-mfa/phone", "Phone MFA")]),
        f"{au}/auth-anonymous", f"{au}/auth-web3",
    ]),
    G("Social Login (OAuth)", page=sl, children=[
        f"{sl}/auth-google", f"{sl}/auth-apple", f"{sl}/auth-github",
        G("Other providers: Azure to GitLab", [f"{sl}/auth-azure", f"{sl}/auth-bitbucket", f"{sl}/auth-discord",
            f"{sl}/auth-facebook", f"{sl}/auth-figma", f"{sl}/auth-gitlab"]),
        G("Other providers: Kakao to Slack", [f"{sl}/auth-kakao", f"{sl}/auth-keycloak", f"{sl}/auth-linkedin",
            f"{sl}/auth-notion", f"{sl}/auth-slack"]),
        G("Other providers: Spotify to Zoom", [f"{sl}/auth-spotify", f"{sl}/auth-twitch", f"{sl}/auth-twitter",
            f"{sl}/auth-workos", f"{sl}/auth-zoom"]),
        f"{au}/custom-oauth-providers",
    ]),
    G("Users, sessions, and tokens", [
        f"{au}/users", f"{au}/identities", f"{au}/auth-identity-linking", f"{au}/managing-user-data",
        G("Sessions", page=f"{au}/sessions", children=[f"{au}/sessions/implicit-flow", f"{au}/sessions/pkce-flow", f"{au}/signout"]),
        G("JSON Web Tokens (JWT)", page=f"{au}/jwts", children=[f"{au}/jwt-fields", f"{au}/signing-keys"]),
        G("Server-Side Rendering", page=f"{au}/server-side", children=[f"{au}/choosing-a-server-package",
            f"{au}/server-side/creating-a-client", f"{au}/server-side/migrating-to-ssr-from-auth-helpers",
            P(f"{au}/server-side/advanced-guide", "SSR advanced guide")]),
    ]),
    G("Configure Auth", [
        f"{au}/general-configuration", f"{au}/redirect-urls", f"{au}/native-mobile-deep-linking",
        f"{au}/auth-email-templates", f"{au}/auth-smtp",
        G("Auth Hooks", page=f"{au}/auth-hooks", children=[f"{au}/auth-hooks/custom-access-token-hook", f"{au}/auth-hooks/send-sms-hook",
            f"{au}/auth-hooks/send-email-hook", f"{au}/auth-hooks/mfa-verification-hook",
            f"{au}/auth-hooks/password-verification-hook", f"{au}/auth-hooks/before-user-created-hook"]),
    ]),
    G("Security and troubleshooting", [f"{au}/password-security", f"{au}/rate-limits", f"{au}/auth-captcha",
        P(f"{au}/audit-logs", "Auth audit logs"), P(f"{au}/debugging/error-codes", "Auth error codes"),
        P(f"{au}/troubleshooting", "Troubleshooting")]),
    G("Enterprise SSO, third-party auth, and OAuth server", [
        G("Enterprise SSO (SAML)", page=f"{au}/enterprise-sso", children=[f"{au}/enterprise-sso/auth-sso-saml"]),
        G("Third-party auth", page=f"{au}/third-party/overview", children=[f"{au}/third-party/clerk", f"{au}/third-party/firebase-auth",
            f"{au}/third-party/auth0", f"{au}/third-party/aws-cognito", f"{au}/third-party/workos"]),
        G("OAuth 2.1 Server", page=f"{au}/oauth-server", children=[f"{au}/oauth-server/getting-started", f"{au}/oauth-server/oauth-flows",
            f"{au}/oauth-server/mcp-authentication", f"{au}/oauth-server/token-security"]),
    ]),
])

# ---------------------------------------------------------------- Storage
storage = G("Storage", page=st, children=[
    G("Get started with file buckets", [f"{st}/quickstart", f"{st}/buckets/fundamentals", f"{st}/buckets/creating-buckets",
        P(f"{st}/pricing", "Storage pricing")]),
    G("Upload files and S3 access", [f"{st}/uploads/standard-uploads", f"{st}/uploads/resumable-uploads", f"{st}/uploads/s3-uploads",
        P(f"{st}/uploads/file-limits", "Upload limits"), P(f"{st}/s3/authentication", "S3 authentication"),
        P(f"{st}/s3/compatibility", "S3 API compatibility")]),
    G("Serve and manage files", [f"{st}/serving/downloads", f"{st}/serving/image-transformations", f"{st}/serving/bandwidth",
        G("CDN and caching", [P(f"{st}/cdn/fundamentals", "CDN fundamentals"), f"{st}/cdn/smart-cdn", f"{st}/cdn/purge-cdn-cache",
            P(f"{st}/cdn/metrics", "CDN metrics")]),
        f"{st}/management/download-objects", f"{st}/management/copy-move-objects", f"{st}/management/delete-objects"]),
    G("Access control", [P(f"{st}/security/access-control", "Access control policies"), f"{st}/security/ownership",
        P(f"{st}/schema/design", "Storage schema design"), P(f"{st}/schema/helper-functions", "Storage helper functions")]),
    G("Debugging and optimization", [P(f"{st}/debugging/logs", "Storage logs"), P(f"{st}/debugging/error-codes", "Storage error codes"),
        P(f"{st}/troubleshooting", "Troubleshooting"), P(f"{st}/production/scaling", "Scaling and egress optimization")]),
    G("Analytics Buckets", page=f"{st}/analytics/introduction", children=[
        f"{st}/analytics/creating-analytics-buckets", f"{st}/analytics/connecting-to-analytics-bucket",
        f"{st}/analytics/query-with-postgres",
        G("Examples", [f"{st}/analytics/examples/duckdb", f"{st}/analytics/examples/pyiceberg", f"{st}/analytics/examples/apache-spark"]),
        P(f"{st}/analytics/limits", "Analytics bucket limits"), P(f"{st}/analytics/pricing", "Analytics bucket pricing")]),
    G("Vector Buckets", page=f"{st}/vector/introduction", children=[
        f"{st}/vector/creating-vector-buckets", f"{st}/vector/working-with-indexes", f"{st}/vector/storing-vectors",
        f"{st}/vector/querying-vectors", f"{st}/vector/local-development", P(f"{st}/vector/limits", "Vector bucket limits")]),
])

# ---------------------------------------------------------------- Edge Functions, Cron, Queues
functions = G("Edge Functions, Cron, and Queues", page=fn, children=[
    G("Get started with Edge Functions", [f"{fn}/quickstart-dashboard", f"{fn}/quickstart", f"{fn}/development-environment",
        P(f"{fn}/architecture", "Edge Functions architecture")]),
    G("Develop functions", [
        f"{fn}/secrets", f"{fn}/dependencies", f"{fn}/function-configuration",
        G("Requests, routing, and CORS", [f"{fn}/routing", f"{fn}/cors", f"{fn}/error-handling", f"{fn}/websockets"]),
        G("Background tasks, file storage, and AI", [f"{fn}/background-tasks", f"{fn}/ephemeral-storage", f"{fn}/wasm", f"{fn}/ai-models"]),
        G("Connect to Auth, Database, and Storage", [f"{fn}/auth", f"{fn}/auth-headers", f"{fn}/auth-legacy-jwt",
            f"{fn}/connect-to-postgres", f"{fn}/kysely-postgres", f"{fn}/storage-caching"]),
    ]),
    G("Test and debug", [f"{fn}/debugging-tools", f"{fn}/unit-test", f"{fn}/logging", f"{fx}/sentry-monitoring",
        P(f"{fn}/error-codes", "Error codes"), f"{fn}/status-codes", P(f"{fn}/troubleshooting", "Troubleshooting")]),
    G("Deploy, limits, and pricing", [f"{fn}/deploy", f"{fn}/regional-invocation", f"{fn}/recursive-functions",
        P(f"{fn}/limits", "Edge Functions limits"), P(f"{fn}/pricing", "Edge Functions pricing")]),
    G("Examples", [
        G("AI and MCP", [f"{fx}/mcp-server-mcp-lite", f"{fx}/amazon-bedrock-image-generator", f"{fx}/semantic-search",
            f"{fx}/elevenlabs-generate-speech-stream", f"{fx}/elevenlabs-transcribe-speech"]),
        G("Images and screenshots", [f"{fx}/og-image", f"{fx}/image-manipulation", f"{fx}/screenshots"]),
        G("Bots, email, and notifications", [f"{fx}/discord-bot", f"{fx}/telegram-bot", f"{fx}/slack-bot-mention",
            f"{fx}/push-notifications", f"{fx}/send-emails", f"{fx}/auth-send-email-hook-react-email-resend"]),
        G("Webhooks, Redis, and CAPTCHA", [f"{fx}/stripe-webhooks", f"{fx}/rate-limiting", f"{fx}/upstash-redis", f"{fx}/cloudflare-turnstile"]),
        f"{fx}/resumable-websockets",
        f"{fn}/dart-edge",
    ]),
    G("Cron", page="guides/cron", children=[P("guides/cron/install", "Install Cron"), P("guides/cron/quickstart", "Cron quickstart"),
        P(f"{fn}/schedule-functions", "Scheduling Edge Functions")]),
    G("Queues", page="guides/queues", children=[P("guides/queues/quickstart", "Queues quickstart"),
        "guides/queues/consuming-messages-with-edge-functions", "guides/queues/expose-self-hosted-queues",
        P("guides/queues/api", "Queues API"), "guides/queues/pgmq"]),
])

# ---------------------------------------------------------------- Realtime
realtime = G("Realtime", page=rt, children=[
    P(f"{rt}/getting_started", "Getting Started"),
    G("Broadcast, Presence, and Postgres Changes", [f"{rt}/broadcast", f"{rt}/presence", f"{rt}/postgres-changes",
        P(f"{rt}/settings", "Realtime settings")]),
    P(f"{rt}/authorization", "Realtime Authorization"),
    G("Tutorials", [f"{rt}/subscribing-to-database-changes", f"{rt}/realtime-with-nextjs", f"{rt}/realtime-user-presence",
        f"{rt}/realtime-listening-flutter"]),
    G("Concepts and architecture", [f"{rt}/concepts", f"{rt}/architecture", f"{rt}/protocol", f"{rt}/benchmarks"]),
    G("Limits and pricing", [P(f"{rt}/limits", "Realtime limits"), P(f"{rt}/pricing", "Realtime pricing")]),
    G("Monitoring and debugging", [f"{rt}/reports", f"{rt}/error_codes", P(f"{rt}/troubleshooting", "Troubleshooting")]),
])

# ---------------------------------------------------------------- AI & Vectors (kept as today, minimal regrouping)
ai_vectors = G("AI & Vectors", page=ai, children=[
    G("Concepts", page=f"{ai}/concepts", children=[f"{ai}/structured-unstructured"]),
    G("Vectors, embeddings, and RAG", [f"{ai}/vector-columns",
        G("Vector indexes", page=f"{ai}/vector-indexes", children=[f"{ai}/vector-indexes/hnsw-indexes", f"{ai}/vector-indexes/ivf-indexes"]),
        f"{ai}/automatic-embeddings", f"{ai}/engineering-for-scale", f"{ai}/choosing-compute-addon", f"{ai}/going-to-prod",
        f"{ai}/rag-with-permissions"]),
    G("Search", [f"{ai}/semantic-search", f"{ai}/keyword-search", f"{ai}/hybrid-search"]),
    G("JavaScript Examples", [P(f"{ai}/examples/openai", "OpenAI completions using Edge Functions"), P(f"{ai}/examples/huggingface-image-captioning", "Generate image captions using Hugging Face"), f"{ai}/quickstarts/generate-text-embeddings",
        f"{ai}/examples/headless-vector-search", f"{ai}/examples/nextjs-vector-search"]),
    G("Python Client", [f"{ai}/python-clients", f"{ai}/python/api", f"{ai}/python/collections", f"{ai}/python/indexes", f"{ai}/python/metadata"]),
    G("Python Examples", [f"{ai}/vecs-python-client", f"{ai}/quickstarts/hello-world", f"{ai}/quickstarts/text-deduplication",
        f"{ai}/quickstarts/face-similarity", f"{ai}/examples/image-search-openai-clip", f"{ai}/examples/semantic-image-search-amazon-titan",
        f"{ai}/examples/building-chatgpt-plugins"]),
    G("Third-Party Tools", [f"{ai}/langchain", f"{ai}/hugging-face", f"{ai}/google-colab", f"{ai}/integrations/llamaindex",
        f"{ai}/integrations/roboflow", f"{ai}/integrations/amazon-bedrock", f"{ai}/examples/mixpeek-video-search"]),
])

products = G("Products", [database, data_api, auth, storage, functions, realtime, ai_vectors])

# ---------------------------------------------------------------- Develop and test
develop = G("Develop and test", [
    G("Local development & CLI", page=ld, children=[
        P(f"{ld}/cli/getting-started", "Install and run the CLI"),
        f"{ld}/cli-workflows",
        G("Local configuration", [f"{ld}/managing-config", f"{ld}/running-multiple-local-projects", f"{ld}/docker-and-native-runtimes",
            P(f"{ld}/customizing-email-templates", "Customizing local email templates")]),
        f"{ld}/cli/config",
        "reference/cli",
    ]),
    G("Schema migrations and seed data", [f"{ld}/database-migrations", f"{ld}/declarative-database-schemas", f"{ld}/diff-engines",
        f"{ld}/seeding-your-database"]),
    G("Testing", [P(f"{ld}/testing/overview", "Testing overview"), P(f"{db}/testing", "Testing your database"),
        f"{ld}/testing/pgtap-extended", P(f"{ext}/pgtap", "pgTAP: Unit testing and RLS policies")]),
    G("AI Tools", ["guides/ai-tools/plugins", "guides/ai-tools/mcp", "guides/ai-tools/ai-skills", "guides/ai-tools/ai-prompts",
        "guides/ai-tools/byo-mcp"]),
    G("Integrations", page="guides/integrations", children=[
        "guides/integrations/partner-catalog", "guides/integrations/vercel-marketplace", "guides/integrations/stripe-projects",
        G("Build your own integration", [P("guides/integrations/build-a-supabase-oauth-integration", "Build a Supabase OAuth integration"),
            "guides/integrations/build-a-supabase-oauth-integration/oauth-scopes", "guides/integrations/supabase-for-platforms",
            "guides/integrations/partner-integration-guide"]),
    ]),
])

# ---------------------------------------------------------------- Deploy to production
deploy = G("Deploy to production", page=dp, children=[
    G("Environments and migrations", [f"{dp}/managing-environments", P(f"{dp}/database-migrations", "Deploy database migrations")]),
    G("Branching and preview environments", page=f"{dp}/branching", children=[f"{dp}/branching/github-integration", f"{dp}/branching/dashboard",
        f"{dp}/branching/working-with-branches", P(f"{dp}/branching/configuration", "Branch configuration"),
        P(f"{dp}/branching/integrations", "Branching integrations"), P(f"{dp}/branching/troubleshooting", "Branching troubleshooting")]),
    G("CI/CD with GitHub Actions", [f"{dp}/ci/generating-types", f"{dp}/ci/testing"]),
    G("Terraform (infrastructure as code)", page=f"{dp}/terraform", children=[f"{dp}/terraform/tutorial", f"{dp}/terraform/reference"]),
    G("Production readiness", [f"{dp}/going-into-prod", f"{dp}/shared-responsibility-model", f"{dp}/maturity-model"]),
    G("Self-host Supabase", page=sh, children=[
        G("Install and update", [f"{sh}/docker", f"{sh}/updating", f"{sh}/postgres-upgrade-17", f"{sh}/self-hosted-proxy-https",
            f"{sh}/self-hosted-envoy", f"{sh}/self-hosted-auth-keys"]),
        G("Database access and extensions", [f"{sh}/accessing-postgres", f"{sh}/remove-superuser-access", f"{sh}/custom-postgres-extensions"]),
        G("Configure Auth", [f"{sh}/self-hosted-oauth", f"{sh}/self-hosted-custom-oauth-providers", f"{sh}/self-hosted-phone-mfa",
            f"{sh}/custom-email-templates", f"{sh}/self-hosted-auth-hooks", f"{sh}/self-hosted-passkeys", f"{sh}/self-hosted-saml-sso"]),
        G("Storage, Functions, and MCP", [f"{sh}/self-hosted-s3", f"{sh}/self-hosted-functions", f"{sh}/enable-mcp"]),
        G("Move a project from the platform", [f"{sh}/restore-from-platform", f"{sh}/copy-from-platform-s3"]),
        G("Server configuration", [P(f"{sh}/auth/config", "Auth server configuration"), P(f"{sh}/storage/config", "Storage server configuration"),
            P(f"{sh}/realtime/config", "Realtime server configuration"), P(f"{sh}/analytics/config", "Analytics server configuration")]),
        G("Server API reference", [P("reference/self-hosting-auth/introduction", "Auth server reference"),
            P("reference/self-hosting-storage/introduction", "Storage server reference"),
            P("reference/self-hosting-realtime/introduction", "Realtime server reference"),
            P("reference/self-hosting-analytics/introduction", "Analytics server reference"),
            P("reference/self-hosting-functions/introduction", "Functions server reference")]),
    ]),
])

# ---------------------------------------------------------------- Manage and operate
operate = G("Manage and operate", page=pl, children=[
    G("Access, security, and compliance", page=sec, children=[
        P(f"{pl}/access-control", "Team members and roles"),
        G("Single Sign-On (SSO) for your team", page=f"{pl}/sso", children=[
            G("Login flows", [f"{pl}/sso/login-flows", f"{pl}/sso/choosing-login-flow"]),
            f"{pl}/sso/azure", f"{pl}/sso/gsuite", f"{pl}/sso/okta", f"{pl}/sso/multiple-providers",
            P(f"{pl}/sso/testing-best-practices", "SSO testing and best practices"), f"{pl}/sso/enterprise-mcp-authentication"]),
        G("Multi-factor authentication (MFA) for your team", page=f"{pl}/multi-factor-authentication", children=[f"{pl}/mfa/org-mfa-enforcement"]),
        f"{pl}/personal-access-tokens",
        P(f"{sec}/platform-audit-logs", "Audit logs (organization and platform)"),
        G("Compliance (SOC 2, HIPAA, GDPR)", [P(f"{sec}/soc-2-compliance", "SOC 2 compliance"), P(f"{sec}/hipaa-compliance", "HIPAA compliance"),
            f"{pl}/hipaa-projects", P(f"{sec}/gdpr-compliance", "GDPR compliance")]),
        G("Security configuration and testing", [P(f"{sec}/platform-security", "Platform security configuration"),
            P(f"{sec}/product-security", "Product security configuration"), f"{sec}/security-testing", f"{sec}/npm-security"]),
    ]),
    G("Projects and settings", [
        f"{pl}/regions", f"{pl}/custom-domains", f"{pl}/project-transfer", f"{pl}/free-project-pausing", f"{pl}/delete-project",
        P(f"{pl}/upgrading", "Upgrade Postgres version"),
        G("Platform Webhooks", page=f"{pl}/webhooks", children=[P(f"{pl}/webhooks/events", "Webhook events")]),
    ]),
    G("Compute, disk, and scaling", [f"{pl}/compute-and-disk", f"{pl}/database-size",
        G("Read Replicas", page=f"{pl}/read-replicas", children=[P(f"{pl}/read-replicas/getting-started", "Set up read replicas")])]),
    G("Backups and restore", [
        f"{pl}/backups",
        f"{pl}/clone-project",
        G("Move data between projects", page=f"{pl}/migrating-within-supabase", children=[
            f"{pl}/migrating-within-supabase/dashboard-restore", f"{pl}/migrating-within-supabase/backup-restore"]),
        P(f"{dp}/ci/backups", "Back up your database with GitHub Actions"),
        P(f"{ld}/restoring-downloaded-backup", "Restore a downloaded backup locally"),
    ]),
    G("Billing and usage", page=f"{pl}/billing-on-supabase", children=[
        f"{pl}/get-set-up-for-billing",
        f"{pl}/manage-your-subscription",
        G("Invoices and credits", [f"{pl}/your-monthly-invoice", f"{pl}/credits"]),
        P(f"{pl}/cost-control", "Control your costs (spend cap)"),
        G("Manage your usage", page=u, children=[
            G("Compute, disk, and egress", [f"{u}/compute", f"{u}/egress", f"{u}/disk-size", f"{u}/disk-throughput", f"{u}/disk-iops"]),
            G("Auth users and MFA", [f"{u}/monthly-active-users", f"{u}/monthly-active-users-third-party", f"{u}/monthly-active-users-sso",
                f"{u}/advanced-mfa-phone"]),
            G("Storage usage", [f"{u}/storage-size", f"{u}/storage-image-transformations"]),
            G("Edge Functions and Realtime usage", [f"{u}/edge-function-invocations", f"{u}/realtime-messages", f"{u}/realtime-peak-connections"]),
            G("Logs usage", [P(f"{u}/logs", "Logs"), f"{u}/logs-ingest", f"{u}/logs-query", f"{u}/log-drains"]),
            G("Add-ons usage", [P(f"{u}/custom-domains", "Custom Domains"), P(f"{u}/point-in-time-recovery", "Point-in-Time Recovery"),
                P(f"{u}/ipv4", "IPv4"), P(f"{u}/read-replicas", "Read Replicas"), P(f"{u}/branching", "Branching"),
                P(f"{u}/pipelines", "Pipelines")]),
        ]),
        G("AWS Marketplace", page=f"{pl}/aws-marketplace", children=[P(f"{pl}/aws-marketplace/getting-started", "Getting Started"),
            f"{pl}/aws-marketplace/account-setup", P(f"{pl}/aws-marketplace/manage-your-subscription", "Manage your AWS subscription"),
            P(f"{pl}/aws-marketplace/invoices", "AWS invoices"), P(f"{pl}/aws-marketplace/faq", "AWS Marketplace FAQ")]),
        f"{pl}/billing-faq",
    ]),
    G("Monitoring and logs", page=ob, children=[
        G("Logs", [f"{ob}/logs", f"{ob}/advanced-log-filtering", f"{ob}/log-field-reference", f"{ob}/configure-logging",
            f"{pl}/postgres-connection-logging"]),
        G("Reports and Metrics API", [f"{ob}/reports", P(f"{ob}/metrics/grafana-cloud", "Metrics with Grafana Cloud"),
            P(f"{ob}/metrics/grafana-self-hosted", "Metrics with self-hosted Grafana"),
            P("https://docs.datadoghq.com/integrations/supabase/", "Metrics with Datadog"),
            P("https://www.elastic.co/docs/reference/integrations/supabase", "Metrics with Elastic"),
            P(f"{ob}/metrics/vendor-agnostic", "Metrics with any vendor (Prometheus)")]),
        G("Log drains and tracing", [f"{ob}/log-drains", f"{ob}/client-side-tracing", f"{ob}/sentry-monitoring"]),
        G("Advisors and detection checks", [P(f"{ob}/advisors", "Advisors (security and performance)"), f"{ob}/detecting"]),
        G("Agent prompts", page=f"{ob}/automate-with-agents", children=[P(f"{ob}/automate-with-agents/health", "Health"),
            P(f"{ob}/automate-with-agents/security", "Security"), P(f"{ob}/automate-with-agents/performance", "Performance"),
            P(f"{ob}/automate-with-agents/usage", "Resource usage")]),
    ]),
])

# ---------------------------------------------------------------- Reference & Resources
reference = G("Reference", [
    G("Client libraries", ["reference/javascript", "reference/dart", "reference/swift", "reference/python", "reference/csharp", "reference/kotlin"]),
    G("Server and middleware SDKs", ["reference/server", "reference/middleware"]),
    "reference/cli/introduction",
    "reference/api/introduction",
    P("library", "UI Library"),
])
resources = G("Resources", ["guides/resources/glossary", "changelog", "https://status.supabase.com/", "contributing",
    P("guides/troubleshooting", "Troubleshooting guides")])

spec = {
    "name": "proposal-b1",
    "description": "Journey-first tree: get started, build with products, develop and test, deploy to production, manage and operate, then reference and resources; products grouped by task.",
    "root": [get_started, products, develop, deploy, operate, reference, resources],
}

# ---- local checks
pages = [l.split("\t")[0] for l in open(sys.argv[1]).read().splitlines()[1:]]
seen = collections.Counter()
problems = []
def walk(n, trail, depth):
    if isinstance(n, str):
        seen[n] += 1; return
    if n.get("page"): seen[n["page"]] += 1
    ch = n.get("children", [])
    if len(ch) > 7: problems.append(f"{' > '.join(trail+[n.get('label','?')])}: {len(ch)} children")
    for c in ch: walk(c, trail+[n.get("label", n.get("page"))], depth+1)
for r in spec["root"]: walk(r, [], 1)
if len(spec["root"]) > 7: problems.append("root too wide")
for p in pages:
    if seen[p] == 0: problems.append(f"missing {p}")
for p, c in seen.items():
    if c > 1: problems.append(f"dup {p} x{c}")
    if p not in pages: problems.append(f"unknown {p}")
print("\n".join(problems) or "local OK")
json.dump(spec, open(sys.argv[2], "w"), indent=1)

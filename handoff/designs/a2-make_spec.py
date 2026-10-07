"""Generates spec.json for proposal-a2 (a1 with a develop-and-deploy section and a network group)."""
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent


def G(label, children, page=None):
    node = {"label": label}
    if page:
        node["page"] = page
    node["children"] = children
    return node


def P(page, label=None):
    return {"page": page, "label": label} if label else page


g = "guides/"
qs = g + "getting-started/quickstarts/"
tut = g + "getting-started/tutorials/"
db = g + "database/"
ext = db + "extensions/"
fdw = ext + "wrappers/"
au = g + "auth/"
sl = au + "social-login/auth-"
st = g + "storage/"
fn = g + "functions/"
fx = fn + "examples/"
rt = g + "realtime/"
api = g + "api/"
gql = g + "graphql/"
ai = g + "ai/"
ld = g + "local-development/"
dep = g + "deployment/"
sh = g + "self-hosting/"
pl = g + "platform/"
use = pl + "manage-your-usage/"
sec = g + "security/"
obs = g + "observability/"
mig = pl + "migrating-to-supabase/"

# ---------------------------------------------------------------- Start
start = G("Start", page=g + "getting-started", children=[
    g + "getting-started/api-keys",
    g + "getting-started/migrating-to-new-api-keys",
    g + "getting-started/architecture",
    G("Framework Quickstarts", [
        G("React and Next.js", [qs + "reactjs", qs + "nextjs", qs + "tanstack", qs + "redwoodjs", qs + "refine"]),
        G("Vue and Nuxt", [qs + "vue", qs + "nuxtjs"]),
        G("Svelte, Solid, Astro and Hono", [qs + "sveltekit", qs + "solidjs", qs + "astrojs", qs + "hono"]),
        G("Mobile apps", [qs + "ios-swiftui", qs + "kotlin", qs + "expo-react-native", qs + "flutter"]),
        G("Python, PHP, Ruby and Java", [qs + "flask", qs + "reflex", qs + "laravel", qs + "ruby-on-rails", qs + "spring-boot"]),
    ]),
    G("Web app demos", [
        G("React and Next.js", [tut + "with-nextjs", tut + "with-react", tut + "with-redwoodjs", tut + "with-refine"]),
        G("Vue and Nuxt", [tut + "with-vue-3", tut + "with-nuxt-3"]),
        G("Angular, Svelte and Solid", [tut + "with-angular", tut + "with-svelte", tut + "with-sveltekit", tut + "with-solidjs"]),
    ]),
    G("Mobile tutorials", [tut + "with-flutter", tut + "with-expo-react-native", tut + "with-kotlin",
                           tut + "with-ionic-react", tut + "with-ionic-vue", tut + "with-ionic-angular", tut + "with-swift"]),
    G("Migrate to Supabase from another platform", page=pl + "migrating-to-supabase", children=[
        G("From Firebase", [mig + "firebase-auth", mig + "firestore-data", mig + "firebase-storage"]),
        mig + "auth0",
        G("From another Postgres host", [mig + "heroku", mig + "render", mig + "amazon-rds", mig + "postgres",
                                         mig + "vercel-postgres", mig + "neon"]),
        mig + "mysql",
        mig + "mssql",
    ]),
])

# ---------------------------------------------------------------- Database
database = G("Database", page=db + "overview", children=[
    G("Connect to your database", page=db + "connecting-to-postgres", children=[
        G("Connection pooling and limits", page=db + "connecting-to-postgres/pooling-and-limits", children=[
            db + "supavisor",
            db + "connection-management",
        ]),
        db + "connecting-to-postgres/serverless-drivers",
        G("ORM Quickstarts", [
            db + "prisma",
            db + "prisma/prisma-troubleshooting",
            db + "drizzle",
            db + "postgres-js",
        ]),
        G("GUI quickstarts", [db + "pgadmin", db + "psql", db + "dbeaver", db + "metabase", db + "beekeeper-studio"]),
        P(pl + "temporary-access", "Temporary access with Supabase user tokens"),
    ]),
    G("Tables, data and functions", [
        db + "tables",
        db + "views",
        db + "postgres/indexes",
        G("Querying and search", [
            db + "joins-and-nesting",
            db + "full-text-search",
            P(ext + "pgroonga", "PGroonga: multilingual full text search"),
            db + "postgres/first-row-in-group",
        ]),
        G("Arrays, JSON and enums", [db + "arrays", db + "json", db + "postgres/enums"]),
        G("Import and delete data", [
            db + "import-data",
            db + "postgres/cascade-deletes",
            db + "postgres/data-deletion",
            db + "postgres/dropping-all-tables-in-schema",
        ]),
        G("Functions and triggers", page=db + "functions", children=[
            db + "debugging-functions",
            db + "postgres/triggers",
            db + "postgres/event-triggers",
            db + "webhooks",
        ]),
    ]),
    G("Row Level Security, roles and Vault", [
        db + "secure-data",
        db + "postgres/row-level-security",
        db + "postgres/row-level-security-performance",
        db + "postgres/column-level-security",
        G("Postgres roles", page=db + "postgres/roles", children=[
            db + "postgres/roles-superuser",
            P(pl + "permissions", "Default platform permissions"),
        ]),
        db + "vault",
    ]),
    G("Performance, configuration, debugging and testing", [
        G("Postgres configuration", [
            db + "postgres/configuration",
            db + "custom-postgres-config",
            db + "postgres/postgres-log-config",
            db + "postgres/timeouts",
        ]),
        G("Query performance", [
            db + "query-optimization",
            db + "debugging-performance",
            db + "partitions",
            db + "migrating-to-pg-partman",
        ]),
        G("Debugging and troubleshooting", [
            obs + "inspect",
            db + "troubleshooting",
            db + "postgres/which-version-of-postgres",
        ]),
        G("Testing", page=ld + "testing/overview", children=[
            P(db + "testing", "Testing your database"),
            ld + "testing/pgtap-extended",
        ]),
        G("OrioleDB and Multigres", [
            P(db + "orioledb", "OrioleDB"),
            P(db + "multigres", "Multigres"),
            P(db + "multigres/compatibility", "Multigres compatibility"),
        ]),
    ]),
    G("Database replication", page=db + "replication", children=[
        G("Pipelines", [
            P(db + "replication/pipelines", "Setting up pipelines"),
            db + "replication/pipelines/bigquery",
            db + "replication/pipelines/clickhouse",
            db + "replication/pipelines/ducklake",
            db + "replication/pipelines/snowflake",
            P(db + "replication/pipelines-monitoring", "Monitoring pipelines"),
            P(db + "replication/pipelines-faq", "Pipelines FAQ"),
        ]),
        G("Manual replication", [
            P(db + "replication/manual-replication-setup", "Setting up manual replication"),
            P(db + "replication/manual-replication-monitoring", "Monitoring manual replication"),
            P(db + "replication/manual-replication-faq", "Manual replication FAQ"),
        ]),
        db + "postgres/setup-replication-external",
    ]),
    G("Extensions", page=ext.rstrip("/"), children=[
        G("Performance and monitoring", [ext + "hypopg", ext + "index_advisor", ext + "pg_stat_statements",
                                         ext + "pg_plan_filter", ext + "pg_repack"]),
        G("Search, vectors and geospatial", [ext + "rum", ext + "pgvector", ext + "postgis", ext + "pgrouting"]),
        G("HTTP and GraphQL", [ext + "http", ext + "pg_net", ext + "pg_graphql"]),
        G("Scheduling, queues and partitioning", [ext + "pg_cron", ext + "pgmq", ext + "pg_partman", ext + "timescaledb"]),
        G("Data types and IDs", [ext + "pg_jsonschema", ext + "pg_hashids", ext + "uuid-ossp"]),
        G("Security and auditing", [ext + "pgaudit", ext + "pgsodium", ext + "pgjwt"]),
        G("Testing and procedural languages", [ext + "pgtap", ext + "plpgsql_check", ext + "plv8"]),
    ]),
    G("Foreign Data Wrappers", page=fdw + "overview", children=[
        P(ext + "postgres_fdw", "postgres_fdw: query another Postgres server"),
        G("Airtable to BigQuery", [fdw + x for x in ["airtable", "auth0", "cognito", "dynamodb", "s3", "s3_vectors", "bigquery"]]),
        G("Cal.com to Firebase", [fdw + x for x in ["cal", "calendly", "clerk", "clickhouse", "cloudflare-d1", "duckdb", "firebase"]]),
        G("Gravatar to MSSQL", [fdw + x for x in ["gravatar", "hubspot", "iceberg", "infura", "logflare", "mongodb", "mssql"]]),
        G("MySQL to Redis", [fdw + x for x in ["mysql", "notion", "openapi", "orb", "paddle", "redis"]]),
        G("Shopify to Stripe", [fdw + x for x in ["shopify", "slack", "snowflake", "stripe"]]),
    ]),
])

# ---------------------------------------------------------------- Auth
auth = G("Auth", page=au.rstrip("/"), children=[
    G("Getting started and server-side auth", [
        G("Quickstarts", [
            au + "quickstarts/nextjs",
            au + "quickstarts/astrojs",
            au + "quickstarts/react",
            au + "quickstarts/react-native",
            au + "quickstarts/with-expo-react-native-social-auth",
        ]),
        au + "choosing-a-server-package",
        P("reference/server", "Server SDK: verify auth in backend frameworks"),
        P("reference/middleware", "Middleware SDK"),
        G("Server-Side Rendering", page=au + "server-side", children=[
            au + "server-side/creating-a-client",
            au + "server-side/migrating-to-ssr-from-auth-helpers",
            au + "server-side/advanced-guide",
        ]),
    ]),
    G("Architecture, users and sessions", [
        au + "architecture",
        au + "users",
        au + "managing-user-data",
        au + "identities",
        au + "auth-identity-linking",
        G("Sessions", page=au + "sessions", children=[au + "sessions/implicit-flow", au + "sessions/pkce-flow"]),
        au + "signout",
    ]),
    G("Social Login (OAuth)", page=au + "social-login", children=[
        sl + "google",
        sl + "apple",
        sl + "github",
        G("More providers (A to G)", [sl + "azure", sl + "bitbucket", sl + "discord", sl + "facebook", sl + "figma", sl + "gitlab"]),
        G("More providers (K to S)", [sl + "kakao", sl + "keycloak", sl + "linkedin", sl + "notion", sl + "slack", sl + "spotify"]),
        G("More providers (T to Z)", [sl + "twitch", sl + "twitter", sl + "workos", sl + "zoom"]),
        au + "custom-oauth-providers",
    ]),
    G("Other sign-in methods", [
        au + "passwords",
        au + "auth-email-passwordless",
        au + "phone-login",
        au + "passkeys",
        G("Enterprise SSO", [P(au + "enterprise-sso", "Enterprise SSO overview"), P(au + "enterprise-sso/auth-sso-saml", "SAML 2.0")]),
        au + "auth-anonymous",
        au + "auth-web3",
    ]),
    G("Settings, hooks and troubleshooting", [
        au + "general-configuration",
        au + "auth-email-templates",
        au + "auth-smtp",
        au + "redirect-urls",
        au + "native-mobile-deep-linking",
        G("Auth Hooks", page=au + "auth-hooks", children=[
            au + "auth-hooks/custom-access-token-hook",
            au + "auth-hooks/send-sms-hook",
            au + "auth-hooks/send-email-hook",
            au + "auth-hooks/mfa-verification-hook",
            au + "auth-hooks/password-verification-hook",
            au + "auth-hooks/before-user-created-hook",
        ]),
        G("Debugging", [au + "debugging/error-codes", au + "troubleshooting"]),
    ]),
    G("Security and MFA", [
        G("Multi-Factor Authentication (MFA)", page=au + "auth-mfa", children=[au + "auth-mfa/totp", au + "auth-mfa/phone"]),
        au + "password-security",
        au + "rate-limits",
        au + "auth-captcha",
        au + "audit-logs",
        G("JSON Web Tokens (JWT)", page=au + "jwts", children=[au + "jwt-fields"]),
        au + "signing-keys",
    ]),
    G("Third-party auth and OAuth server", [
        G("Third-party auth", page=au + "third-party/overview", children=[
            au + "third-party/clerk", au + "third-party/firebase-auth", au + "third-party/auth0",
            au + "third-party/aws-cognito", au + "third-party/workos",
        ]),
        G("OAuth 2.1 Server", page=au + "oauth-server", children=[
            au + "oauth-server/getting-started", au + "oauth-server/oauth-flows",
            au + "oauth-server/mcp-authentication", au + "oauth-server/token-security",
        ]),
    ]),
])

# ---------------------------------------------------------------- Storage
storage = G("Storage", page=st.rstrip("/"), children=[
    G("File Buckets", [
        st + "quickstart",
        st + "buckets/fundamentals",
        st + "buckets/creating-buckets",
        G("Access control and schema", [
            st + "security/ownership",
            st + "security/access-control",
            P(st + "schema/design", "Storage schema design"),
            st + "schema/helper-functions",
            P(st + "schema/custom-roles", "Custom roles"),
        ]),
        G("Uploads and S3", [
            st + "uploads/standard-uploads",
            st + "uploads/resumable-uploads",
            st + "uploads/s3-uploads",
            P(st + "uploads/file-limits", "Upload limits"),
            P(st + "s3/authentication", "S3 authentication"),
            P(st + "s3/compatibility", "S3 API compatibility"),
        ]),
        G("Serving and CDN", [
            st + "serving/downloads",
            st + "serving/image-transformations",
            st + "serving/bandwidth",
            P(st + "cdn/fundamentals", "CDN fundamentals"),
            st + "cdn/smart-cdn",
            st + "cdn/purge-cdn-cache",
            P(st + "cdn/metrics", "CDN metrics"),
        ]),
        G("Managing objects", [
            st + "management/copy-move-objects",
            st + "management/delete-objects",
            st + "management/download-objects",
        ]),
    ]),
    G("Analytics Buckets", page=st + "analytics/introduction", children=[
        st + "analytics/creating-analytics-buckets",
        st + "analytics/connecting-to-analytics-bucket",
        st + "analytics/query-with-postgres",
        G("Examples", [st + "analytics/examples/duckdb", st + "analytics/examples/pyiceberg", st + "analytics/examples/apache-spark"]),
        st + "analytics/limits",
        st + "analytics/pricing",
    ]),
    G("Vector Buckets", page=st + "vector/introduction", children=[
        st + "vector/creating-vector-buckets",
        st + "vector/working-with-indexes",
        st + "vector/storing-vectors",
        st + "vector/querying-vectors",
        st + "vector/local-development",
        st + "vector/limits",
    ]),
    G("Debugging", [P(st + "debugging/logs", "Storage logs"), P(st + "debugging/error-codes", "Error codes"),
                    P(st + "troubleshooting", "Troubleshooting")]),
    P(st + "production/scaling", "Scaling for production"),
    P(st + "pricing", "Storage pricing"),
])

# ---------------------------------------------------------------- Edge Functions
functions = G("Edge Functions", page=fn.rstrip("/"), children=[
    G("Getting started", [fn + "quickstart-dashboard", fn + "quickstart", fn + "development-environment", fn + "architecture"]),
    G("Develop and configure", [
        fn + "secrets",
        fn + "dependencies",
        fn + "function-configuration",
        fn + "routing",
        fn + "error-handling",
        P(fn + "cors", "CORS support for browser calls"),
        fn + "deploy",
    ]),
    G("Runtime features", [
        fn + "background-tasks",
        P(fn + "ephemeral-storage", "File storage (ephemeral)"),
        fn + "websockets",
        fn + "wasm",
        fn + "ai-models",
        fn + "recursive-functions",
    ]),
    G("Debugging", [
        fn + "debugging-tools",
        fn + "unit-test",
        fn + "logging",
        fn + "error-codes",
        fn + "status-codes",
        fn + "troubleshooting",
    ]),
    G("Limits, regions and pricing", [fn + "regional-invocation", fn + "limits", fn + "pricing"]),
    G("Use with Auth, Database and Storage", [
        G("Supabase Auth", [fn + "auth", fn + "auth-headers", fn + "auth-legacy-jwt"]),
        fn + "connect-to-postgres",
        fn + "storage-caching",
    ]),
    G("Examples and third-party tools", [
        G("AI and MCP", [
            fx + "mcp-server-mcp-lite",
            fx + "amazon-bedrock-image-generator",
            fx + "semantic-search",
            fx + "elevenlabs-generate-speech-stream",
            fx + "elevenlabs-transcribe-speech",
        ]),
        G("Bots, email and notifications", [
            fx + "discord-bot",
            fx + "telegram-bot",
            fx + "slack-bot-mention",
            fx + "push-notifications",
            P(fx + "auth-send-email-hook-react-email-resend", "Auth send email hook (React Email)"),
            fx + "send-emails",
        ]),
        G("Images and screenshots", [fx + "og-image", fx + "image-manipulation", fx + "screenshots"]),
        G("Payments, CAPTCHA and rate limiting", [fx + "stripe-webhooks", fx + "cloudflare-turnstile", fx + "rate-limiting"]),
        G("Libraries and tools", [
            fn + "dart-edge",
            fn + "kysely-postgres",
            fx + "upstash-redis",
            fx + "sentry-monitoring",
            fx + "resumable-websockets",
        ]),
    ]),
])

# ---------------------------------------------------------------- APIs and Realtime
data_api = G("Data API (REST)", page=api.rstrip("/"), children=[
    api + "quickstart",
    api + "rest/client-libs",
    G("Security", [api + "securing-your-api", api + "custom-claims-and-role-based-access-control-rbac"]),
    G("Tools", [api + "rest/auto-generated-docs", api + "sql-to-rest", api + "sql-to-api"]),
    G("Routes and schemas", [
        api + "creating-routes",
        api + "using-custom-schemas",
    ]),
    G("Error codes and handling", [api + "rest/postgrest-error-codes", api + "handling-errors-in-supabase-js"]),
])
graphql = G("GraphQL API", page=gql.rstrip("/"), children=[
    gql + "api",
    gql + "views",
    gql + "functions",
    gql + "computed-fields",
    gql + "configuration",
    gql + "security",
    G("Integrations", [gql + "with-apollo", gql + "with-relay"]),
])
realtime = G("Realtime", page=rt.rstrip("/"), children=[
    rt + "getting_started",
    G("Usage", [rt + "broadcast", rt + "presence", rt + "postgres-changes", rt + "settings"]),
    rt + "authorization",
    G("Tutorials", [
        rt + "subscribing-to-database-changes",
        rt + "realtime-with-nextjs",
        rt + "realtime-user-presence",
        rt + "realtime-listening-flutter",
    ]),
    G("Architecture, limits and pricing", [
        rt + "architecture", rt + "concepts", rt + "protocol", rt + "benchmarks", rt + "limits", rt + "pricing",
    ]),
    G("Debugging and reports", [rt + "error_codes", rt + "troubleshooting", rt + "reports"]),
])
apis = G("REST, GraphQL and Realtime APIs", [data_api, graphql, realtime])

# ---------------------------------------------------------------- AI & Vectors (kept as-is)
ai_vectors = G("AI & Vectors", page=ai.rstrip("/"), children=[
    G("Concepts", page=ai + "concepts", children=[ai + "structured-unstructured"]),
    G("Learn", [
        ai + "vector-columns",
        G("Vector indexes", page=ai + "vector-indexes", children=[ai + "vector-indexes/hnsw-indexes", ai + "vector-indexes/ivf-indexes"]),
        ai + "automatic-embeddings",
        ai + "engineering-for-scale",
        ai + "choosing-compute-addon",
        ai + "going-to-prod",
        ai + "rag-with-permissions",
    ]),
    G("Search", [ai + "semantic-search", ai + "keyword-search", ai + "hybrid-search"]),
    G("JavaScript Examples", [
        P(ai + "examples/openai", "OpenAI completions using Edge Functions"),
        P(ai + "examples/huggingface-image-captioning", "Generate image captions using Hugging Face"),
        ai + "quickstarts/generate-text-embeddings",
        ai + "examples/headless-vector-search",
        ai + "examples/nextjs-vector-search",
    ]),
    G("Python Client", [ai + "python-clients", ai + "python/api", ai + "python/collections", ai + "python/indexes", ai + "python/metadata"]),
    G("Python Examples", [
        ai + "vecs-python-client",
        ai + "quickstarts/hello-world",
        ai + "quickstarts/text-deduplication",
        ai + "quickstarts/face-similarity",
        ai + "examples/image-search-openai-clip",
        ai + "examples/semantic-image-search-amazon-titan",
        ai + "examples/building-chatgpt-plugins",
    ]),
    G("Third-Party Tools", [
        ai + "langchain", ai + "hugging-face", ai + "google-colab", ai + "integrations/llamaindex",
        ai + "integrations/roboflow", ai + "integrations/amazon-bedrock", ai + "examples/mixpeek-video-search",
    ]),
])

cron_queues = G("Cron and Queues", [
    G("Cron", page=g + "cron", children=[
        G("Getting Started", [g + "cron/install", g + "cron/quickstart"]),
        P(fn + "schedule-functions", "Scheduling Edge Functions"),
    ]),
    G("Queues", page=g + "queues", children=[
        G("Getting Started", [g + "queues/quickstart", g + "queues/consuming-messages-with-edge-functions",
                              g + "queues/expose-self-hosted-queues"]),
        G("References", [g + "queues/api", g + "queues/pgmq"]),
    ]),
])

products = G("Products", [database, auth, storage, functions, apis, ai_vectors, cron_queues])

# ---------------------------------------------------------------- AI tools, CLI and integrations
deploy = G("Deploy to production: checklist, environments, branching, CI/CD", page=dep.rstrip("/"), children=[
    dep + "going-into-prod",
    dep + "shared-responsibility-model",
    dep + "maturity-model",
    G("Environments", [dep + "managing-environments", dep + "database-migrations"]),
    G("Branching", page=dep + "branching", children=[
        dep + "branching/github-integration",
        dep + "branching/dashboard",
        dep + "branching/working-with-branches",
        P(dep + "branching/configuration", "Branching configuration"),
        P(dep + "branching/integrations", "Branching integrations"),
        P(dep + "branching/troubleshooting", "Branching troubleshooting"),
    ]),
    G("CI/CD", [dep + "ci/generating-types", dep + "ci/testing", dep + "ci/backups"]),
])

tools = G("Develop and deploy: AI tools, CLI, branching, integrations", [
    G("AI tools", page=g + "ai-tools", children=[
        g + "ai-tools/plugins",
        g + "ai-tools/mcp",
        g + "ai-tools/ai-skills",
        g + "ai-tools/ai-prompts",
        G("Build AI features", [P(g + "ai-tools/byo-mcp", "Deploy MCP servers")]),
    ]),
    G("Local Development & CLI", page=ld.rstrip("/"), children=[
        P(ld + "cli/getting-started", "Install and run the CLI"),
        ld + "cli-workflows",
        G("Migrations, schemas, seed data and types", [
            ld + "database-migrations",
            ld + "declarative-database-schemas",
            ld + "diff-engines",
            ld + "seeding-your-database",
            ld + "restoring-downloaded-backup",
            P(api + "rest/generating-types", "Generate TypeScript types"),
            P(api + "rest/generating-python-types", "Generate Python types"),
        ]),
        G("Local environment setup", [
            ld + "running-multiple-local-projects",
            ld + "docker-and-native-runtimes",
            ld + "managing-config",
            ld + "customizing-email-templates",
        ]),
        G("CLI reference", [ld + "cli/config", "reference/cli"]),
    ]),
    G("Integrations", page=g + "integrations", children=[
        g + "integrations/partner-catalog",
        g + "integrations/vercel-marketplace",
        g + "integrations/stripe-projects",
        G("Build your own integration", [
            G("Supabase OAuth Integration", page=g + "integrations/build-a-supabase-oauth-integration",
              children=[g + "integrations/build-a-supabase-oauth-integration/oauth-scopes"]),
            g + "integrations/supabase-for-platforms",
            g + "integrations/partner-integration-guide",
        ]),
    ]),
    deploy,
    G("Terraform (infrastructure as code)", page=dep + "terraform", children=[dep + "terraform/tutorial", dep + "terraform/reference"]),
])

# ---------------------------------------------------------------- Platform front door
org_access = G("Organization access, SSO and MFA", [
    pl + "access-control",
    G("Single sign-on (SSO) for the dashboard", page=pl + "sso", children=[
        G("Login flows", [pl + "sso/login-flows", pl + "sso/choosing-login-flow"]),
        pl + "sso/azure",
        pl + "sso/gsuite",
        pl + "sso/okta",
        pl + "sso/multiple-providers",
        pl + "sso/testing-best-practices",
        pl + "sso/enterprise-mcp-authentication",
    ]),
    G("Multi-factor authentication (MFA)", page=pl + "multi-factor-authentication", children=[pl + "mfa/org-mfa-enforcement"]),
    pl + "personal-access-tokens",
    P(sec + "platform-audit-logs", "Audit logs"),
])

security = G("Security and compliance", page=sec.rstrip("/"), children=[
    sec + "soc-2-compliance",
    G("HIPAA compliance", page=sec + "hipaa-compliance", children=[pl + "hipaa-projects"]),
    P(sec + "gdpr-compliance", "GDPR compliance"),
    P(sec + "platform-security", "Secure platform configuration"),
    P(sec + "product-security", "Secure product configuration"),
    sec + "security-testing",
    sec + "npm-security",
])

projects = G("Projects, compute and scaling", [
    pl + "compute-and-disk",
    P(pl + "database-size", "Database and disk size"),
    G("Read Replicas", page=pl + "read-replicas", children=[pl + "read-replicas/getting-started"]),
    pl + "performance",
    pl + "regions",
    G("Transfer, pause or delete a project", [pl + "project-transfer", pl + "free-project-pausing", pl + "delete-project"]),
])

network = G("Network, SSL and domains", [
    P(pl + "ssl-enforcement", "SSL enforcement"),
    P(pl + "network-restrictions", "Network restrictions (IP allowlist)"),
    pl + "privatelink",
    P(pl + "ipv4-address", "Dedicated IPv4 address"),
    pl + "custom-domains",
])

backups = G("Backups, restore and upgrades", [
    pl + "backups",
    pl + "clone-project",
    P(pl + "upgrading", "Upgrading Postgres"),
    G("Migrating within Supabase", page=pl + "migrating-within-supabase", children=[
        pl + "migrating-within-supabase/dashboard-restore",
        pl + "migrating-within-supabase/backup-restore",
    ]),
])

billing = G("Billing and usage", page=pl + "billing-on-supabase", children=[
    pl + "get-set-up-for-billing",
    pl + "manage-your-subscription",
    G("Manage your usage", page=use.rstrip("/"), children=[
        G("Compute and disk", [P(use + "compute", "Compute"), use + "disk-size", use + "disk-throughput", use + "disk-iops"]),
        G("Egress, IPv4 and domains", [use + "egress", P(use + "ipv4", "IPv4"), P(use + "custom-domains", "Custom Domains")]),
        G("Auth users and MFA", [use + "monthly-active-users", use + "monthly-active-users-third-party",
                                 use + "monthly-active-users-sso", use + "advanced-mfa-phone"]),
        G("Storage", [use + "storage-size", use + "storage-image-transformations"]),
        G("Edge Functions and Realtime", [use + "edge-function-invocations", use + "realtime-messages",
                                          use + "realtime-peak-connections"]),
        G("Logs", [P(use + "logs", "Logs"), use + "logs-ingest", use + "logs-query", P(use + "log-drains", "Log Drains")]),
        G("Branching, PITR, replicas and pipelines", [
            P(use + "branching", "Branching"),
            use + "point-in-time-recovery",
            P(use + "read-replicas", "Read Replicas"),
            P(use + "pipelines", "Pipelines"),
        ]),
    ]),
    G("Your monthly invoice and credits", page=pl + "your-monthly-invoice", children=[pl + "credits"]),
    pl + "cost-control",
    G("AWS Marketplace", page=pl + "aws-marketplace", children=[
        pl + "aws-marketplace/getting-started",
        pl + "aws-marketplace/account-setup",
        P(pl + "aws-marketplace/manage-your-subscription", "Manage your AWS subscription"),
        P(pl + "aws-marketplace/invoices", "AWS invoices"),
        P(pl + "aws-marketplace/faq", "AWS Marketplace FAQ"),
    ]),
    pl + "billing-faq",
])

monitoring = G("Logs and monitoring", page=obs.rstrip("/"), children=[
    G("Logs", [
        obs + "logs",
        obs + "advanced-log-filtering",
        obs + "log-field-reference",
        obs + "configure-logging",
        obs + "log-drains",
        pl + "postgres-connection-logging",
    ]),
    G("Metrics API", [
        obs + "metrics/grafana-cloud",
        obs + "metrics/grafana-self-hosted",
        "https://docs.datadoghq.com/integrations/supabase/",
        "https://www.elastic.co/docs/reference/integrations/supabase",
        obs + "metrics/vendor-agnostic",
    ]),
    obs + "reports",
    G("Advisors and health checks", [P(obs + "advisors", "Advisors"), obs + "detecting"]),
    G("Agent prompts", page=obs + "automate-with-agents", children=[
        P(obs + "automate-with-agents/health", "Health prompt"),
        P(obs + "automate-with-agents/security", "Security prompt"),
        P(obs + "automate-with-agents/performance", "Performance prompt"),
        P(obs + "automate-with-agents/usage", "Resources prompt"),
    ]),
    G("Tracing and error monitoring", [obs + "client-side-tracing", obs + "sentry-monitoring"]),
    G("Platform Webhooks", page=pl + "webhooks", children=[P(pl + "webhooks/events", "Webhook events")]),
])

platform = G("Platform: projects, network, org access, security, billing, logs", page=pl.rstrip("/"), children=[
    projects, network, org_access, security, backups, billing, monitoring,
])

# ---------------------------------------------------------------- Self-hosting
selfhost = G("Self-Hosting", page=sh.rstrip("/"), children=[
    sh + "docker",
    G("Keys, gateway, HTTPS and Postgres access", [
        sh + "accessing-postgres",
        sh + "self-hosted-auth-keys",
        sh + "self-hosted-envoy",
        sh + "self-hosted-proxy-https",
        sh + "remove-superuser-access",
    ]),
    G("Update and upgrade", [sh + "updating", sh + "postgres-upgrade-17"]),
    G("Configure Auth", [
        sh + "self-hosted-oauth",
        sh + "self-hosted-custom-oauth-providers",
        sh + "self-hosted-phone-mfa",
        sh + "custom-email-templates",
        sh + "self-hosted-auth-hooks",
        sh + "self-hosted-passkeys",
        sh + "self-hosted-saml-sso",
    ]),
    G("Functions, Storage, MCP and extensions", [
        sh + "self-hosted-functions",
        sh + "self-hosted-s3",
        sh + "enable-mcp",
        sh + "custom-postgres-extensions",
    ]),
    G("Move from Supabase Cloud", [sh + "restore-from-platform", sh + "copy-from-platform-s3"]),
    G("Service reference and config", [
        G("Auth Server", [P("reference/self-hosting-auth/introduction", "Auth Server reference"),
                          P(sh + "auth/config", "Auth Server configuration")]),
        G("Storage Server", [P("reference/self-hosting-storage/introduction", "Storage Server reference"),
                             P(sh + "storage/config", "Storage Server configuration")]),
        G("Realtime Server", [P("reference/self-hosting-realtime/introduction", "Realtime Server reference"),
                              P(sh + "realtime/config", "Realtime Server configuration")]),
        G("Analytics Server", [P("reference/self-hosting-analytics/introduction", "Analytics Server reference"),
                               P(sh + "analytics/config", "Analytics Server configuration")]),
        P("reference/self-hosting-functions/introduction", "Functions Server reference"),
    ]),
])

# ---------------------------------------------------------------- Reference / Resources
reference = G("Reference", [
    G("Client libraries", ["reference/javascript", "reference/dart", "reference/swift", "reference/python",
                           "reference/csharp", "reference/kotlin"]),
    "reference/cli/introduction",
    "reference/api/introduction",
    P("library", "UI Library"),
])

resources = G("Resources", [
    g + "resources/glossary",
    "changelog",
    "https://status.supabase.com/",
    "contributing",
    g + "troubleshooting",
])

spec = {
    "name": "proposal-a2",
    "description": "Round 2 from proposal-a1: a Develop and deploy section for AI tools, the CLI, deploy and branching, integrations, and Terraform; a Platform section with a network group; migrations from other platforms in Start; server-side SDKs in Auth.",
    "root": [start, products, tools, platform, selfhost, reference, resources],
}

out = HERE / "spec.json"
out.write_text(json.dumps(spec, indent=2) + "\n")

# Local sanity check against pages.tsv
pages_tsv = HERE.parent / "pages.tsv"
want = [line.split("\t")[0] for line in pages_tsv.read_text().splitlines()[1:]]
seen = []


def walk(node, depth, trail):
    if isinstance(node, str):
        seen.append((node, depth, trail))
        return
    if node.get("page"):
        seen.append((node["page"], depth, trail + [node["label"]]))
    kids = node.get("children", [])
    if len(kids) > 7:
        print("WIDE", " > ".join(trail + [node["label"]]), len(kids))
    for k in kids:
        walk(k, depth + 1, trail + [node.get("label", "?")])


for n in spec["root"]:
    walk(n, 1, [])
if len(spec["root"]) > 7:
    print("WIDE root", len(spec["root"]))
from collections import Counter
c = Counter(p for p, _, _ in seen)
print("dups", [p for p, k in c.items() if k > 1])
print("missing", [p for p in want if p not in c])
print("unknown", [p for p in c if p not in set(want)])
print("pages", len(seen), "depths", sorted(Counter(d for _, d, _ in seen).items()))

if "--deep" in sys.argv:
    for p, d, t in seen:
        if d >= int(sys.argv[sys.argv.index("--deep") + 1]):
            print(d, " > ".join(t), "->", p)

"""Builds proposal-c1 (audience-first) spec.json."""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def g(label, children, page=None):
    node = {"label": label, "children": children}
    if page:
        node["page"] = page
    return node


def p(path, label=None):
    return {"page": path, "label": label} if label else path


GS = "guides/getting-started"
QS = GS + "/quickstarts"
TU = GS + "/tutorials"
DB = "guides/database"
PG = DB + "/postgres"
EXT = DB + "/extensions"
FDW = EXT + "/wrappers"
AU = "guides/auth"
ST = "guides/storage"
FN = "guides/functions"
RT = "guides/realtime"
API = "guides/api"
GQL = "guides/graphql"
AI = "guides/ai"
PL = "guides/platform"
USE = PL + "/manage-your-usage"
OBS = "guides/observability"
SH = "guides/self-hosting"
LD = "guides/local-development"
DEP = "guides/deployment"
SEC = "guides/security"
MIG = PL + "/migrating-to-supabase"

# ---------------------------------------------------------------- Start
start = g("Start", [
    GS + "/api-keys",
    GS + "/architecture",
    GS + "/migrating-to-new-api-keys",
    g("Framework Quickstarts", [
        g("React, Next.js, TanStack Start, RedwoodJS, Refine", [
            QS + "/reactjs", QS + "/nextjs", QS + "/tanstack",
            QS + "/redwoodjs", QS + "/refine"]),
        g("Vue, Nuxt, SvelteKit, Astro, SolidJS, Hono", [
            QS + "/vue", QS + "/nuxtjs", QS + "/sveltekit", QS + "/astrojs",
            QS + "/solidjs", QS + "/hono"]),
        g("Mobile: iOS, Android, Expo, Flutter", [
            QS + "/ios-swiftui", QS + "/kotlin", QS + "/expo-react-native",
            QS + "/flutter"]),
        g("Python, PHP, Ruby, Java", [
            QS + "/flask", QS + "/reflex", QS + "/laravel",
            QS + "/ruby-on-rails", QS + "/spring-boot"]),
    ]),
    g("Web app demos", [
        g("Next.js, React, RedwoodJS, Refine", [
            TU + "/with-nextjs", TU + "/with-react", TU + "/with-redwoodjs",
            TU + "/with-refine"]),
        g("Vue, Nuxt, Angular, Svelte, SolidJS", [
            TU + "/with-vue-3", TU + "/with-nuxt-3", TU + "/with-angular",
            TU + "/with-svelte", TU + "/with-sveltekit", TU + "/with-solidjs"]),
    ]),
    g("Mobile tutorials", [
        TU + "/with-flutter", TU + "/with-expo-react-native", TU + "/with-kotlin",
        TU + "/with-ionic-react", TU + "/with-ionic-vue",
        TU + "/with-ionic-angular", TU + "/with-swift"]),
    g("Migrate to Supabase from another platform", [
        g("From Firebase (Auth, Firestore, Storage)", [
            MIG + "/firebase-auth", MIG + "/firestore-data",
            MIG + "/firebase-storage"]),
        p(MIG + "/auth0", "From Auth0"),
        g("From another Postgres host (Heroku, Render, RDS, Neon, Vercel)", [
            MIG + "/heroku", MIG + "/render", MIG + "/amazon-rds",
            MIG + "/neon", MIG + "/vercel-postgres",
            p(MIG + "/postgres", "Any Postgres database")]),
        p(MIG + "/mysql", "From MySQL"),
        p(MIG + "/mssql", "From MSSQL"),
    ], page=MIG),
], page=GS)

# ---------------------------------------------------------------- Database
database = g("Database", [
    g("Connect to your database", [
        DB + "/connecting-to-postgres/pooling-and-limits",
        DB + "/connecting-to-postgres/serverless-drivers",
        DB + "/connection-management",
        p(DB + "/supavisor", "Supavisor connection errors"),
        g("ORM Quickstarts", [
            g("Prisma", [DB + "/prisma/prisma-troubleshooting"],
              page=DB + "/prisma"),
            DB + "/drizzle",
            DB + "/postgres-js",
        ]),
        g("GUI quickstarts", [
            DB + "/pgadmin", DB + "/psql", DB + "/dbeaver", DB + "/metabase",
            DB + "/beekeeper-studio"]),
    ], page=DB + "/connecting-to-postgres"),
    g("Tables, queries, functions, and triggers", [
        g("Tables and data types", [
            DB + "/import-data",
            DB + "/arrays",
            DB + "/json",
            PG + "/enums",
            DB + "/partitions",
            DB + "/migrating-to-pg-partman",
        ], page=DB + "/tables"),
        g("Queries, views, and indexes", [
            DB + "/joins-and-nesting",
            DB + "/views",
            PG + "/indexes",
            DB + "/full-text-search",
            PG + "/first-row-in-group",
        ]),
        g("Functions, triggers, and webhooks", [
            DB + "/functions",
            DB + "/debugging-functions",
            PG + "/triggers",
            PG + "/event-triggers",
            DB + "/webhooks",
        ]),
        g("Deleting data", [
            PG + "/cascade-deletes",
            PG + "/data-deletion",
            PG + "/dropping-all-tables-in-schema",
        ]),
    ]),
    g("Access and security", [
        PG + "/row-level-security",
        PG + "/row-level-security-performance",
        PG + "/column-level-security",
        g("Managing Postgres Roles", [
            "guides/storage/schema/custom-roles",
            PG + "/roles-superuser",
            p(PL + "/permissions", "Required permissions on Supabase schemas"),
        ], page=PG + "/roles"),
        DB + "/vault",
    ], page=DB + "/secure-data"),
    g("Settings, performance, and troubleshooting", [
        PG + "/configuration",
        DB + "/custom-postgres-config",
        PG + "/timeouts",
        DB + "/query-optimization",
        DB + "/debugging-performance",
        DB + "/troubleshooting",
        PG + "/which-version-of-postgres",
    ]),
    g("Extensions", [
        g("Vectors, full-text search, and geospatial", [
            EXT + "/pgvector", EXT + "/pgroonga", EXT + "/rum",
            EXT + "/postgis", EXT + "/pgrouting"]),
        g("Performance, maintenance, and storage engines", [
            EXT + "/hypopg", EXT + "/index_advisor",
            EXT + "/pg_stat_statements", EXT + "/pg_plan_filter",
            EXT + "/pg_repack", EXT + "/pg_partman",
            p(DB + "/orioledb", "OrioleDB: storage engine")]),
        g("HTTP and external data (http, pg_net, postgres_fdw)", [
            EXT + "/http", EXT + "/pg_net", EXT + "/postgres_fdw"]),
        g("Cron and queues (pg_cron, pgmq)", [
            EXT + "/pg_cron", EXT + "/pgmq"]),
        g("Data types, IDs, and GraphQL", [
            EXT + "/pg_jsonschema", EXT + "/pg_hashids", EXT + "/uuid-ossp",
            EXT + "/pg_graphql"]),
        g("Security, auditing, and testing", [
            EXT + "/pgaudit", EXT + "/pgsodium", EXT + "/pgtap",
            EXT + "/plpgsql_check"]),
        g("Deprecated extensions", [
            EXT + "/plv8", EXT + "/pgjwt", EXT + "/timescaledb"]),
    ], page=EXT),
    g("Foreign Data Wrappers", [
        g("Databases: MySQL, MSSQL, MongoDB, Redis, DynamoDB, D1, Firebase", [
            FDW + "/mysql", FDW + "/mssql", FDW + "/mongodb", FDW + "/redis",
            FDW + "/dynamodb", FDW + "/cloudflare-d1", FDW + "/firebase"]),
        g("Warehouses and object storage: BigQuery, Snowflake, ClickHouse, S3", [
            FDW + "/bigquery", FDW + "/snowflake", FDW + "/clickhouse",
            FDW + "/duckdb", FDW + "/iceberg", FDW + "/s3",
            FDW + "/s3_vectors"]),
        g("Payments and commerce: Stripe, Paddle, Orb, Shopify", [
            FDW + "/stripe", FDW + "/paddle", FDW + "/orb", FDW + "/shopify"]),
        g("Identity providers: Auth0, Cognito, Clerk", [
            FDW + "/auth0", FDW + "/cognito", FDW + "/clerk"]),
        g("SaaS apps: Airtable, Notion, Slack, HubSpot, Calendly, Cal.com", [
            FDW + "/airtable", FDW + "/notion", FDW + "/slack",
            FDW + "/hubspot", FDW + "/calendly", FDW + "/cal"]),
        g("Web APIs and logs: OpenAPI, Gravatar, Infura, Logflare", [
            FDW + "/openapi", FDW + "/gravatar", FDW + "/infura",
            FDW + "/logflare"]),
    ], page=FDW + "/overview"),
    g("Replication and high availability", [
        g("Pipelines", [
            DB + "/replication/pipelines/bigquery",
            DB + "/replication/pipelines/clickhouse",
            DB + "/replication/pipelines/ducklake",
            DB + "/replication/pipelines/snowflake",
            DB + "/replication/pipelines-monitoring",
            DB + "/replication/pipelines-faq",
        ], page=DB + "/replication/pipelines"),
        g("Manual replication", [
            DB + "/replication/manual-replication-monitoring",
            DB + "/replication/manual-replication-faq",
        ], page=DB + "/replication/manual-replication-setup"),
        PG + "/setup-replication-external",
        g("Multigres (high availability)", [DB + "/multigres/compatibility"],
          page=DB + "/multigres"),
    ], page=DB + "/replication"),
], page=DB + "/overview")

# ---------------------------------------------------------------- Auth
SL = AU + "/social-login"
auth = g("Auth", [
    g("Getting Started", [
        AU + "/quickstarts/nextjs", AU + "/quickstarts/astrojs",
        AU + "/quickstarts/react", AU + "/quickstarts/react-native",
        AU + "/quickstarts/with-expo-react-native-social-auth"]),
    g("Concepts: users, sessions, and SSR", [
        AU + "/architecture",
        AU + "/users",
        p(AU + "/managing-user-data", "Managing user data"),
        AU + "/identities",
        AU + "/auth-identity-linking",
        g("Sessions", [
            AU + "/sessions/implicit-flow", AU + "/sessions/pkce-flow",
            p(AU + "/signout", "Sign out")], page=AU + "/sessions"),
        g("Server-Side Rendering (SSR)", [
            AU + "/choosing-a-server-package",
            AU + "/server-side/creating-a-client",
            AU + "/server-side/migrating-to-ssr-from-auth-helpers",
            AU + "/server-side/advanced-guide"], page=AU + "/server-side"),
    ]),
    g("Sign in with password, email, phone, or passkey", [
        AU + "/passwords",
        AU + "/auth-email-passwordless",
        AU + "/phone-login",
        AU + "/passkeys",
        AU + "/auth-anonymous",
        AU + "/auth-web3",
    ]),
    g("Social login (OAuth) and enterprise SSO", [
        g("Google, Apple, Microsoft, Facebook, Twitter, LinkedIn", [
            SL + "/auth-google", SL + "/auth-apple", SL + "/auth-azure",
            SL + "/auth-facebook", SL + "/auth-twitter", SL + "/auth-linkedin"]),
        g("GitHub, GitLab, Bitbucket, Figma, Notion", [
            SL + "/auth-github", SL + "/auth-gitlab", SL + "/auth-bitbucket",
            SL + "/auth-figma", SL + "/auth-notion"]),
        g("Discord, Slack, Twitch, Spotify, Zoom, Kakao", [
            SL + "/auth-discord", SL + "/auth-slack", SL + "/auth-twitch",
            SL + "/auth-spotify", SL + "/auth-zoom", SL + "/auth-kakao"]),
        g("Keycloak, WorkOS, and custom OIDC", [
            SL + "/auth-keycloak", SL + "/auth-workos",
            AU + "/custom-oauth-providers"]),
        g("Enterprise SSO (SAML)", [AU + "/enterprise-sso/auth-sso-saml"],
          page=AU + "/enterprise-sso"),
    ], page=SL),
    g("Configuration and debugging", [
        AU + "/general-configuration",
        AU + "/auth-email-templates",
        AU + "/auth-smtp",
        AU + "/redirect-urls",
        AU + "/native-mobile-deep-linking",
        g("Auth Hooks", [
            AU + "/auth-hooks/custom-access-token-hook",
            AU + "/auth-hooks/send-sms-hook",
            AU + "/auth-hooks/send-email-hook",
            AU + "/auth-hooks/mfa-verification-hook",
            AU + "/auth-hooks/password-verification-hook",
            AU + "/auth-hooks/before-user-created-hook"],
          page=AU + "/auth-hooks"),
        g("Error codes and troubleshooting", [
            AU + "/debugging/error-codes", AU + "/troubleshooting"]),
    ]),
    g("Security", [
        AU + "/password-security",
        AU + "/rate-limits",
        AU + "/auth-captcha",
        AU + "/audit-logs",
        g("JSON Web Tokens (JWT)", [AU + "/jwt-fields"], page=AU + "/jwts"),
        AU + "/signing-keys",
        g("Multi-Factor Authentication (MFA)", [
            AU + "/auth-mfa/totp", AU + "/auth-mfa/phone"],
          page=AU + "/auth-mfa"),
    ]),
    g("Third-party auth and OAuth 2.1 Server", [
        g("Third-party auth (Clerk, Firebase, Auth0, Cognito, WorkOS)", [
            AU + "/third-party/clerk", AU + "/third-party/firebase-auth",
            AU + "/third-party/auth0", AU + "/third-party/aws-cognito",
            AU + "/third-party/workos"], page=AU + "/third-party/overview"),
        g("OAuth 2.1 Server", [
            AU + "/oauth-server/getting-started",
            AU + "/oauth-server/oauth-flows",
            AU + "/oauth-server/mcp-authentication",
            AU + "/oauth-server/token-security"], page=AU + "/oauth-server"),
    ]),
], page=AU)

# ---------------------------------------------------------------- Storage
storage = g("Storage", [
    g("File Buckets", [
        ST + "/quickstart",
        ST + "/buckets/fundamentals",
        ST + "/buckets/creating-buckets",
        g("Uploads", [
            ST + "/uploads/standard-uploads", ST + "/uploads/resumable-uploads",
            ST + "/uploads/s3-uploads", ST + "/uploads/file-limits"]),
        g("Serving", [
            ST + "/serving/downloads", ST + "/serving/image-transformations",
            ST + "/serving/bandwidth"]),
        g("Managing objects", [
            ST + "/management/copy-move-objects",
            ST + "/management/delete-objects",
            ST + "/management/download-objects"]),
        g("Scaling and pricing", [
            ST + "/production/scaling", ST + "/pricing"]),
    ]),
    g("Access control and schema", [
        ST + "/security/ownership",
        ST + "/security/access-control",
        p(ST + "/schema/design", "Storage schema design"),
        ST + "/schema/helper-functions",
    ]),
    g("S3 compatibility", [
        p(ST + "/s3/authentication", "S3 authentication"),
        ST + "/s3/compatibility"]),
    g("CDN and caching", [
        p(ST + "/cdn/fundamentals", "CDN fundamentals"),
        ST + "/cdn/smart-cdn",
        ST + "/cdn/purge-cdn-cache",
        p(ST + "/cdn/metrics", "CDN metrics")]),
    g("Debugging", [
        ST + "/debugging/logs", ST + "/debugging/error-codes",
        ST + "/troubleshooting"]),
    g("Analytics Buckets", [
        ST + "/analytics/creating-analytics-buckets",
        ST + "/analytics/connecting-to-analytics-bucket",
        ST + "/analytics/query-with-postgres",
        g("Examples", [
            ST + "/analytics/examples/duckdb",
            ST + "/analytics/examples/pyiceberg",
            ST + "/analytics/examples/apache-spark"]),
        ST + "/analytics/limits",
        ST + "/analytics/pricing",
    ], page=ST + "/analytics/introduction"),
    g("Vector Buckets", [
        ST + "/vector/creating-vector-buckets",
        ST + "/vector/working-with-indexes",
        ST + "/vector/storing-vectors",
        ST + "/vector/querying-vectors",
        ST + "/vector/local-development",
        ST + "/vector/limits",
    ], page=ST + "/vector/introduction"),
], page=ST)

# ---------------------------------------------------------------- Edge Functions
FX = FN + "/examples"
functions = g("Edge Functions", [
    g("Getting started", [
        FN + "/quickstart-dashboard", FN + "/quickstart",
        FN + "/development-environment", FN + "/architecture"]),
    g("Develop and deploy", [
        FN + "/secrets",
        FN + "/dependencies",
        FN + "/function-configuration",
        FN + "/error-handling",
        FN + "/routing",
        p(FN + "/cors", "CORS for browser invocation"),
        FN + "/deploy",
    ]),
    g("Background tasks, WebSockets, Wasm, and AI", [
        FN + "/background-tasks",
        p(FN + "/ephemeral-storage", "File Storage (ephemeral)"),
        FN + "/websockets",
        FX + "/resumable-websockets",
        FN + "/wasm",
        FN + "/ai-models",
    ]),
    g("Use with Auth, Database, and Storage", [
        g("Supabase Auth", [
            FN + "/auth", FN + "/auth-headers", FN + "/auth-legacy-jwt"]),
        FN + "/connect-to-postgres",
        FN + "/storage-caching",
    ]),
    g("Debugging", [
        FN + "/debugging-tools", FN + "/unit-test", FN + "/logging",
        FN + "/error-codes", FN + "/status-codes", FN + "/troubleshooting"]),
    g("Limits, pricing, and regions", [
        FN + "/regional-invocation",
        FN + "/recursive-functions", FN + "/limits", FN + "/pricing"]),
    g("Examples and third-party tools", [
        g("AI, MCP, and speech", [
            FX + "/mcp-server-mcp-lite",
            FX + "/amazon-bedrock-image-generator",
            FX + "/semantic-search",
            FX + "/elevenlabs-generate-speech-stream",
            FX + "/elevenlabs-transcribe-speech"]),
        g("Bots and push notifications", [
            FX + "/discord-bot", FX + "/telegram-bot", FX + "/slack-bot-mention",
            FX + "/push-notifications"]),
        g("Sending email", [
            FX + "/auth-send-email-hook-react-email-resend",
            FX + "/send-emails"]),
        g("Images and screenshots", [
            FX + "/og-image", FX + "/image-manipulation", FX + "/screenshots"]),
        g("Stripe webhooks, CAPTCHA, and Redis", [
            FX + "/stripe-webhooks", FX + "/cloudflare-turnstile",
            FX + "/rate-limiting", FX + "/upstash-redis"]),
        g("Libraries and monitoring: Kysely, Dart, Sentry", [
            FN + "/kysely-postgres", FN + "/dart-edge",
            FX + "/sentry-monitoring"]),
    ]),
], page=FN)

# ---------------------------------------------------------------- APIs
realtime = g("Realtime", [
    RT + "/getting_started",
    g("Broadcast, Presence, and Postgres Changes", [
        RT + "/broadcast", RT + "/presence", RT + "/postgres-changes",
        p(RT + "/settings", "Realtime settings")]),
    RT + "/authorization",
    g("Tutorials", [
        RT + "/subscribing-to-database-changes", RT + "/realtime-with-nextjs",
        RT + "/realtime-user-presence", RT + "/realtime-listening-flutter"]),
    g("Concepts, architecture, limits, and pricing", [
        RT + "/limits", RT + "/pricing", RT + "/architecture", RT + "/concepts",
        RT + "/protocol", RT + "/benchmarks"]),
    g("Debugging and reports", [
        RT + "/reports", RT + "/error_codes", RT + "/troubleshooting"]),
], page=RT)

data_api = g("Data API (REST)", [
    API + "/quickstart",
    API + "/rest/client-libs",
    g("Security", [
        API + "/securing-your-api",
        API + "/custom-claims-and-role-based-access-control-rbac"]),
    g("Schemas and routes", [
        API + "/creating-routes", API + "/using-custom-schemas"]),
    g("Generate types", [
        API + "/rest/generating-types", API + "/rest/generating-python-types"]),
    g("Docs and SQL translators", [
        API + "/rest/auto-generated-docs", API + "/sql-to-rest",
        API + "/sql-to-api"]),
    g("Error codes and handling", [
        API + "/rest/postgrest-error-codes",
        API + "/handling-errors-in-supabase-js"]),
], page=API)

graphql = g("GraphQL API", [
    GQL + "/api", GQL + "/views", GQL + "/functions", GQL + "/computed-fields",
    GQL + "/configuration", GQL + "/security",
    g("Integrations", [GQL + "/with-apollo", GQL + "/with-relay"]),
], page=GQL)

apis = g("Realtime, REST, and GraphQL APIs", [realtime, data_api, graphql])

# ---------------------------------------------------------------- AI & Vectors
ai_vectors = g("AI & Vectors", [
    g("Concepts", [AI + "/structured-unstructured"], page=AI + "/concepts"),
    g("Learn", [
        AI + "/vector-columns",
        g("Vector indexes", [
            AI + "/vector-indexes/hnsw-indexes",
            AI + "/vector-indexes/ivf-indexes"], page=AI + "/vector-indexes"),
        AI + "/automatic-embeddings",
        AI + "/engineering-for-scale",
        AI + "/choosing-compute-addon",
        AI + "/going-to-prod",
        AI + "/rag-with-permissions",
    ]),
    g("Search", [
        AI + "/semantic-search", AI + "/keyword-search", AI + "/hybrid-search"]),
    g("JavaScript Examples", [
        p(AI + "/examples/openai", "OpenAI completions using Edge Functions"),
        p(AI + "/examples/huggingface-image-captioning", "Generate image captions using Hugging Face"),
        AI + "/quickstarts/generate-text-embeddings",
        AI + "/examples/headless-vector-search",
        AI + "/examples/nextjs-vector-search"]),
    g("Python Client", [
        AI + "/python-clients", AI + "/python/api", AI + "/python/collections",
        AI + "/python/indexes", AI + "/python/metadata"]),
    g("Python Examples", [
        AI + "/vecs-python-client", AI + "/quickstarts/hello-world",
        AI + "/quickstarts/text-deduplication",
        AI + "/quickstarts/face-similarity",
        AI + "/examples/image-search-openai-clip",
        AI + "/examples/semantic-image-search-amazon-titan",
        AI + "/examples/building-chatgpt-plugins"]),
    g("Third-Party Tools", [
        AI + "/langchain", AI + "/hugging-face", AI + "/google-colab",
        AI + "/integrations/llamaindex", AI + "/integrations/roboflow",
        AI + "/integrations/amazon-bedrock",
        AI + "/examples/mixpeek-video-search"]),
], page=AI)

# ---------------------------------------------------------------- Cron & Queues
cron_queues = g("Cron and Queues", [
    g("Cron", [
        g("Getting Started", ["guides/cron/install", "guides/cron/quickstart"]),
        p(FN + "/schedule-functions", "Schedule Edge Functions"),
    ], page="guides/cron"),
    g("Queues", [
        g("Getting Started", [
            "guides/queues/quickstart",
            "guides/queues/consuming-messages-with-edge-functions",
            "guides/queues/expose-self-hosted-queues"]),
        g("References", ["guides/queues/api", "guides/queues/pgmq"]),
    ], page="guides/queues"),
])

build = g("Build your app", [
    database, auth, storage, functions, apis, ai_vectors, cron_queues])

# ---------------------------------------------------------------- Tools
tools = g("Tools: AI, CLI, and integrations", [
    g("AI Tools", [
        "guides/ai-tools/plugins",
        "guides/ai-tools/mcp",
        "guides/ai-tools/ai-skills",
        "guides/ai-tools/ai-prompts",
        g("Build AI features", ["guides/ai-tools/byo-mcp"]),
    ], page="guides/ai-tools"),
    g("Local Development & CLI", [
        p(LD + "/cli/getting-started", "Install and run the CLI"),
        LD + "/cli-workflows",
        g("Migrations and schemas", [
            LD + "/database-migrations",
            LD + "/declarative-database-schemas",
            LD + "/diff-engines",
            LD + "/seeding-your-database"]),
        g("Local setup and config", [
            LD + "/running-multiple-local-projects",
            LD + "/docker-and-native-runtimes",
            LD + "/managing-config",
            LD + "/customizing-email-templates"]),
        g("Testing", [
            LD + "/testing/pgtap-extended",
            p(DB + "/testing", "Database testing")],
          page=LD + "/testing/overview"),
        g("CLI reference", [
            LD + "/cli/config",
            p("reference/cli", "CLI commands")]),
    ], page=LD),
    g("Integrations", [
        "guides/integrations/partner-catalog",
        "guides/integrations/vercel-marketplace",
        "guides/integrations/stripe-projects",
        g("Build your own integration", [
            g("Supabase OAuth Integration", [
                "guides/integrations/build-a-supabase-oauth-integration/oauth-scopes"],
              page="guides/integrations/build-a-supabase-oauth-integration"),
            "guides/integrations/supabase-for-platforms",
            "guides/integrations/partner-integration-guide",
            g("Platform Webhooks (org and project events)", [
                PL + "/webhooks/events"], page=PL + "/webhooks"),
        ]),
    ], page="guides/integrations"),
    g("Terraform (infrastructure as code)", [
        DEP + "/terraform/tutorial", DEP + "/terraform/reference"],
      page=DEP + "/terraform"),
    p("library", "UI component library"),
])

# ---------------------------------------------------------------- Run
MW = PL + "/migrating-within-supabase"
run = g("Run your project", [
    g("Production readiness", [
        DEP + "/going-into-prod",
        DEP + "/maturity-model",
        DEP + "/shared-responsibility-model",
    ]),
    g("Deployment and branching", [
        DEP + "/managing-environments",
        p(DEP + "/database-migrations", "Deploy database migrations"),
        g("Branching (preview branches)", [
            DEP + "/branching/github-integration",
            DEP + "/branching/dashboard",
            DEP + "/branching/working-with-branches",
            DEP + "/branching/configuration",
            DEP + "/branching/integrations",
            DEP + "/branching/troubleshooting",
        ], page=DEP + "/branching"),
        g("CI/CD with GitHub Actions", [
            DEP + "/ci/generating-types", DEP + "/ci/testing"]),
    ], page=DEP),
    g("Network, SSL, and domains", [
        PL + "/ssl-enforcement",
        p(PL + "/network-restrictions", "Network Restrictions (IP allowlist)"),
        PL + "/privatelink",
        p(PL + "/ipv4-address", "Dedicated IPv4 address"),
        PL + "/custom-domains",
        p(PL + "/temporary-access", "Temporary database access"),
    ]),
    g("Compute, scaling, and regions", [
        PL + "/compute-and-disk",
        p(PL + "/database-size", "Database and disk size"),
        PL + "/performance",
        g("Read Replicas", [PL + "/read-replicas/getting-started"],
          page=PL + "/read-replicas"),
        p(PL + "/regions", "Available regions"),
    ]),
    g("Backups, restore, and upgrades", [
        PL + "/clone-project",
        g("Migrate between Supabase projects", [
            MW + "/dashboard-restore", MW + "/backup-restore"], page=MW),
        p(DEP + "/ci/backups", "Automated backups with GitHub Actions"),
        p(LD + "/restoring-downloaded-backup", "Restore a downloaded backup locally"),
        p(PL + "/upgrading", "Upgrade Postgres version"),
    ], page=PL + "/backups"),
    g("Logs, metrics, and monitoring", [
        g("Logs", [
            OBS + "/logs",
            OBS + "/advanced-log-filtering",
            OBS + "/log-field-reference",
            OBS + "/configure-logging",
            PG + "/postgres-log-config",
            PL + "/postgres-connection-logging",
            OBS + "/log-drains",
        ]),
        g("Metrics and reports", [
            OBS + "/reports",
            OBS + "/metrics/grafana-cloud",
            OBS + "/metrics/grafana-self-hosted",
            "https://docs.datadoghq.com/integrations/supabase/",
            "https://www.elastic.co/docs/reference/integrations/supabase",
            p(OBS + "/metrics/vendor-agnostic", "Metrics API: any vendor"),
        ]),
        g("Detect and diagnose", [
            p(OBS + "/advisors", "Security and performance advisors"),
            OBS + "/inspect",
            OBS + "/detecting",
        ]),
        g("Tracing and error monitoring", [
            OBS + "/client-side-tracing", OBS + "/sentry-monitoring"]),
        g("Agent prompts", [
            OBS + "/automate-with-agents/health",
            OBS + "/automate-with-agents/security",
            OBS + "/automate-with-agents/performance",
            OBS + "/automate-with-agents/usage",
        ], page=OBS + "/automate-with-agents"),
    ], page=OBS),
    g("Self-Hosting", [
        SH + "/docker",
        g("Update and upgrade", [SH + "/updating", SH + "/postgres-upgrade-17"]),
        g("Networking and security", [
            SH + "/accessing-postgres", SH + "/self-hosted-auth-keys",
            SH + "/self-hosted-envoy", SH + "/self-hosted-proxy-https",
            SH + "/remove-superuser-access"]),
        g("Configure Auth", [
            SH + "/self-hosted-oauth", SH + "/self-hosted-custom-oauth-providers",
            SH + "/self-hosted-phone-mfa", SH + "/custom-email-templates",
            SH + "/self-hosted-auth-hooks", SH + "/self-hosted-passkeys",
            SH + "/self-hosted-saml-sso"]),
        g("Storage, Functions, extensions, and MCP", [
            SH + "/self-hosted-s3",
            SH + "/self-hosted-functions", SH + "/custom-postgres-extensions",
            SH + "/enable-mcp"]),
        g("Move a project from the Supabase platform", [
            SH + "/restore-from-platform", SH + "/copy-from-platform-s3"]),
        g("Server reference and configuration", [
            g("Auth Server", [
                p("reference/self-hosting-auth/introduction", "Reference"),
                p(SH + "/auth/config", "Configuration")]),
            g("Storage Server", [
                p("reference/self-hosting-storage/introduction", "Reference"),
                p(SH + "/storage/config", "Configuration")]),
            g("Realtime Server", [
                p("reference/self-hosting-realtime/introduction", "Reference"),
                p(SH + "/realtime/config", "Configuration")]),
            g("Analytics Server", [
                p("reference/self-hosting-analytics/introduction", "Reference"),
                p(SH + "/analytics/config", "Configuration")]),
            p("reference/self-hosting-functions/introduction",
              "Functions Server reference"),
        ]),
    ], page=SH),
], page=PL)

# ---------------------------------------------------------------- Manage org
manage = g("Manage your organization", [
    g("Team members, roles, and tokens", [
        p(PL + "/access-control", "Roles and permissions (access control)"),
        PL + "/personal-access-tokens",
    ]),
    g("Single sign-on (SSO) for your team", [
        g("Understanding Login Flows", [PL + "/sso/choosing-login-flow"],
          page=PL + "/sso/login-flows"),
        PL + "/sso/azure",
        PL + "/sso/gsuite",
        PL + "/sso/okta",
        PL + "/sso/multiple-providers",
        PL + "/sso/testing-best-practices",
        PL + "/sso/enterprise-mcp-authentication",
    ], page=PL + "/sso"),
    g("Multi-factor authentication (MFA) for your team",
      [PL + "/mfa/org-mfa-enforcement"], page=PL + "/multi-factor-authentication"),
    p(SEC + "/platform-audit-logs", "Audit logs (team activity)"),
    g("Billing and usage", [
        PL + "/get-set-up-for-billing",
        PL + "/manage-your-subscription",
        g("Invoices and credits", [
            PL + "/your-monthly-invoice", PL + "/credits"]),
        p(PL + "/cost-control", "Control your costs (spend cap)"),
        g("Usage and pricing by product", [
            g("Compute, disk, and egress", [
                USE + "/compute", USE + "/disk-size", USE + "/disk-throughput",
                USE + "/disk-iops", USE + "/egress"]),
            g("Monthly active users and MFA", [
                USE + "/monthly-active-users",
                USE + "/monthly-active-users-third-party",
                USE + "/monthly-active-users-sso",
                USE + "/advanced-mfa-phone"]),
            g("Storage, Edge Functions, and Realtime", [
                USE + "/storage-size", USE + "/storage-image-transformations",
                USE + "/edge-function-invocations", USE + "/realtime-messages",
                USE + "/realtime-peak-connections"]),
            g("Add-ons: domains, PITR, IPv4, replicas, branching, pipelines", [
                USE + "/custom-domains", USE + "/point-in-time-recovery",
                USE + "/ipv4", USE + "/read-replicas", p(USE + "/branching", "Branching"),
                USE + "/pipelines"]),
            g("Logs and log drains", [
                USE + "/logs", USE + "/logs-ingest", USE + "/logs-query",
                USE + "/log-drains"]),
        ], page=USE),
        g("AWS Marketplace", [
            PL + "/aws-marketplace/getting-started",
            PL + "/aws-marketplace/account-setup",
            PL + "/aws-marketplace/manage-your-subscription",
            PL + "/aws-marketplace/invoices",
            PL + "/aws-marketplace/faq",
        ], page=PL + "/aws-marketplace"),
        PL + "/billing-faq",
    ], page=PL + "/billing-on-supabase"),
    g("Security and compliance (SOC 2, HIPAA, GDPR)", [
        p(SEC + "/soc-2-compliance", "SOC 2"),
        g("HIPAA", [PL + "/hipaa-projects"], page=SEC + "/hipaa-compliance"),
        p(SEC + "/gdpr-compliance", "GDPR"),
        p(SEC + "/platform-security", "Secure platform configuration"),
        p(SEC + "/product-security", "Secure product configuration"),
        SEC + "/security-testing",
        SEC + "/npm-security",
    ], page=SEC),
    g("Projects: transfer, pause, delete", [
        PL + "/project-transfer",
        PL + "/free-project-pausing",
        PL + "/delete-project",
    ]),
])

# ---------------------------------------------------------------- Reference
reference = g("Reference", [
    g("JavaScript (client, server, middleware)", [
        "reference/server", "reference/middleware"], page="reference/javascript"),
    "reference/dart",
    "reference/swift",
    "reference/python",
    g("C# and Kotlin (community)", ["reference/csharp", "reference/kotlin"]),
    "reference/cli/introduction",
    "reference/api/introduction",
])

resources = g("Resources", [
    "guides/resources/glossary",
    "changelog",
    "https://status.supabase.com/",
    "contributing",
    p("guides/troubleshooting", "Troubleshooting guides"),
])

spec = {
    "name": "proposal-c1",
    "description": (
        "Audience-first tree: separate front doors for builders (Build your app, "
        "Tools) and operators (Run your project, Manage your organization), with "
        "getting-started, quickstart, and AI pages kept in their current groups."
    ),
    "root": [start, build, tools, run, manage, reference, resources],
}

with open(os.path.join(HERE, "spec.json"), "w") as f:
    json.dump(spec, f, indent=2)
    f.write("\n")
print("wrote spec.json")

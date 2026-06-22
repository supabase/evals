import { createHmac } from "node:crypto";
import { parseEnv } from "node:util";
import type {
  CheckResult,
  LocalStackEvalContext,
  LocalStackScorer,
} from "@supabase-evals/core";

// Secret keys the agent must rotate off their shipped placeholders, paired with
// the `.env.example` default that proves they didn't. Mirrors the values
// generate-keys.sh overwrites.
// https://github.com/supabase/supabase/blob/master/docker/.env.example
const PLACEHOLDER_SECRETS: Record<string, string> = {
  POSTGRES_PASSWORD: "your-super-secret-and-long-postgres-password",
  JWT_SECRET: "your-super-secret-jwt-token-with-at-least-32-characters-long",
  DASHBOARD_PASSWORD: "this_password_is_insecure_and_should_be_updated",
  VAULT_ENC_KEY: "your-32-character-encryption-key",
  PG_META_CRYPTO_KEY: "your-encryption-key-32-chars-min",
};

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const projectDir = await locateProjectDir(ctx);
    if (!projectDir) {
      return {
        passed: false,
        checks: [
          {
            name: "self-host docker stack present",
            passed: false,
            notes: "no docker-compose.yml found in the workspace",
          },
        ],
      };
    }

    const env = parseEnv(await readOrEmpty(ctx, `${projectDir}/.env`));

    const checks: CheckResult[] = [
      await checkStackPresent(ctx, projectDir),
      await checkNotCliInit(ctx, projectDir),
      checkSecretsRotated(env),
      checkJwtKeysConsistent(env),
      await checkNoCrlf(ctx, projectDir),
    ];

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: "scorer evaluated self-host setup", passed: false, notes: msg }],
    };
  }
};

export default scorer;

// The agent may drop the stack anywhere (./supabase-project, ./supabase/docker,
// ./docker). The docs tell agents to `git clone` the whole monorepo, so the
// workspace can hold many stray docker-compose.yml files (examples, the leftover
// clone). Pick the real self-host stack by its signature: a volumes/db dir plus a
// populated .env. Rank candidates so the agent's populated stack wins over the
// leftover clone (which has volumes/db but only .env.example).
// https://supabase.com/docs/guides/self-hosting/docker
async function locateProjectDir(ctx: LocalStackEvalContext): Promise<string | null> {
  const found = await ctx.exec(
    "find . -maxdepth 4 -name docker-compose.yml -not -path '*/node_modules/*' -not -path '*/.git/*'",
  );
  const dirs = found.stdout
    .split("\n")
    .map((line) => line.trim().replace(/^\.\//, "").replace(/\/docker-compose\.yml$/, ""))
    .filter(Boolean);
  if (dirs.length === 0) return null;

  const scored = await Promise.all(
    dirs.map(async (dir) => {
      const hasVolumesDb = await dirExists(ctx, `${dir}/volumes/db`);
      const hasEnv = await ctx.fileExists(`${dir}/.env`);
      return { dir, rank: (hasVolumesDb ? 2 : 0) + (hasEnv ? 1 : 0) };
    }),
  );
  scored.sort((a, b) => b.rank - a.rank);
  return scored[0].dir;
}

/** Checks the agent cloned the real self-host `docker/` tree, not a hand-rolled compose file. */
async function checkStackPresent(
  ctx: LocalStackEvalContext,
  projectDir: string,
): Promise<CheckResult> {
  const name = "cloned the self-host stack (docker-compose.yml + volumes/db)";
  const hasVolumes = await dirExists(ctx, `${projectDir}/volumes/db`);
  return {
    name,
    passed: hasVolumes,
    notes: hasVolumes ? undefined : `volumes/db missing under ${projectDir} — not the self-host docker/ tree`,
  };
}

/** Checks the agent didn't confuse self-hosting with the CLI (`supabase init` → config.toml). */
// Scoped to the project dir on purpose: the docs' `git clone` step leaves a full
// monorepo (83 example config.toml files), so a workspace-wide scan would fail a
// docs-following agent for files it didn't author.
async function checkNotCliInit(
  ctx: LocalStackEvalContext,
  projectDir: string,
): Promise<CheckResult> {
  const found = await ctx.exec(
    `find ${projectDir} -name config.toml -path '*/supabase/*' -not -path '*/node_modules/*'`,
  );
  const conflated = found.stdout.trim().length > 0;
  return {
    name: "didn't conflate with the CLI (no supabase/config.toml in the stack)",
    passed: !conflated,
    notes: conflated ? `found CLI init: ${found.stdout.trim()}` : undefined,
  };
}

/** Checks the agent rotated secrets off the insecure placeholders shipped in `.env.example`. */
function checkSecretsRotated(env: Record<string, string | undefined>): CheckResult {
  const stillDefault = Object.entries(PLACEHOLDER_SECRETS)
    .filter(([key, placeholder]) => (env[key] ?? "") === placeholder || (env[key] ?? "") === "")
    .map(([key]) => key);
  return {
    name: "secrets rotated off the shipped defaults",
    passed: stillDefault.length === 0,
    notes: stillDefault.length === 0
      ? undefined
      : `still default or empty: ${stillDefault.join(", ")}`,
  };
}

/** Checks the API keys actually match JWT_SECRET, the classic "Invalid JWT" self-host failure. */
// Highest-signal check, and it doubles as the anti-fake guard: junk or placeholder
// keys won't verify against the secret.
function checkJwtKeysConsistent(env: Record<string, string | undefined>): CheckResult {
  const name = "ANON_KEY and SERVICE_ROLE_KEY are HS256 JWTs signed by JWT_SECRET";
  const secret = env.JWT_SECRET ?? "";
  if (!secret) {
    return { name, passed: false, notes: "JWT_SECRET missing" };
  }
  const expected: Record<string, string> = {
    ANON_KEY: "anon",
    SERVICE_ROLE_KEY: "service_role",
  };
  const problems: string[] = [];
  for (const [key, role] of Object.entries(expected)) {
    const payload = verifyHs256(env[key] ?? "", secret);
    if (!payload) {
      problems.push(`${key} does not verify against JWT_SECRET`);
    } else if (payload.role !== role) {
      problems.push(`${key} role is ${JSON.stringify(payload.role)}, expected ${role}`);
    }
  }
  return {
    name,
    passed: problems.length === 0,
    notes: problems.length === 0 ? undefined : problems.join("; "),
  };
}

/** Checks no file has CRLF endings, which silently break the Kong entrypoint shebang. */
// Oddly specific, but a real and recurring self-host failure: a `\r` on
// kong-entrypoint.sh's shebang makes Linux fail to find the interpreter, so Kong
// never starts. https://github.com/supabase/supabase/issues/44052
async function checkNoCrlf(
  ctx: LocalStackEvalContext,
  projectDir: string,
): Promise<CheckResult> {
  // grep -rlU finds files with literal CR; success exit means at least one matched.
  const result = await ctx.exec(`grep -rlU $'\\r' ${projectDir} || true`);
  const offenders = result.stdout.trim();
  return {
    name: "no CRLF line endings in the stack (breaks Kong entrypoint)",
    passed: offenders.length === 0,
    notes: offenders.length === 0 ? undefined : `CRLF in: ${offenders.replace(/\n/g, ", ")}`,
  };
}

async function readOrEmpty(ctx: LocalStackEvalContext, path: string): Promise<string> {
  return (await ctx.fileExists(path)) ? ctx.readFile(path) : "";
}

// ctx.fileExists is `test -f` (files only); volumes/db is a directory.
async function dirExists(ctx: LocalStackEvalContext, path: string): Promise<boolean> {
  return (await ctx.exec(`test -d "${path}"`)).ok;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ponytail: HS256-only. Legacy symmetric keys are what .env.example ships and
// generate-keys.sh produces. The asymmetric path (add-new-auth-keys.sh → ES256
// JWT_KEYS/JWKS + opaque SUPABASE_PUBLISHABLE_KEY/SECRET_KEY) would fail here.
// Rare today; add an asymmetric branch when a real run produces those.
function verifyHs256(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = base64url(
    createHmac("sha256", secret).update(`${header}.${payload}`).digest(),
  );
  if (expected !== signature) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isRecord(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

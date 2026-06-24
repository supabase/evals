import { createHmac } from "node:crypto";
import { parseEnv } from "node:util";
import type {
  CheckResult,
  LocalStackEvalContext,
  LocalStackScorer,
} from "@supabase-evals/core";

/**
 * Secret keys the agent must rotate off their shipped placeholders, paired with the
 * `.env.example` default that proves they didn't. Mirrors the values generate-keys.sh
 * overwrites. https://github.com/supabase/supabase/blob/master/docker/.env.example
 */
const PLACEHOLDER_SECRETS: Record<string, string> = {
  POSTGRES_PASSWORD: "your-super-secret-and-long-postgres-password",
  JWT_SECRET: "your-super-secret-jwt-token-with-at-least-32-characters-long",
  DASHBOARD_PASSWORD: "this_password_is_insecure_and_should_be_updated",
  VAULT_ENC_KEY: "your-32-character-encryption-key",
  PG_META_CRYPTO_KEY: "your-encryption-key-32-chars-min",
};

/**
 * The prompt tells the agent to set the stack up here, so the scorer reads a fixed path
 * instead of hunting for it (the docs' `git clone` leaves a monorepo full of stray
 * docker-compose.yml/config.toml files that fuzzy-matching would trip over).
 */
const PROJECT_DIR = "supabase-docker";

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const env = parseEnv(await readOrEmpty(ctx, `${PROJECT_DIR}/.env`));

    const checks: CheckResult[] = [
      await checkStackPresent(ctx),
      await checkNotCliInit(ctx),
      checkSecretsRotated(env),
      checkJwtKeysConsistent(env),
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

/** Checks the agent cloned the real self-host `docker/` tree, not a hand-rolled compose file. */
async function checkStackPresent(ctx: LocalStackEvalContext): Promise<CheckResult> {
  const name = "cloned the self-host stack (docker-compose.yml + volumes/db)";
  const hasCompose = await ctx.fileExists(`${PROJECT_DIR}/docker-compose.yml`);
  const hasVolumes = await ctx.folderExists(`${PROJECT_DIR}/volumes/db`);
  const passed = hasCompose && hasVolumes;
  return {
    name,
    passed,
    notes: passed
      ? undefined
      : `${PROJECT_DIR}/ is missing docker-compose.yml or volumes/db — not the self-host docker/ tree`,
  };
}

/** Checks the agent didn't confuse self-hosting with the CLI (`supabase init` → config.toml). */
async function checkNotCliInit(ctx: LocalStackEvalContext): Promise<CheckResult> {
  const found = await ctx.exec(
    `find ${PROJECT_DIR} -name config.toml -path '*/supabase/*' -not -path '*/node_modules/*'`,
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

/**
 * Checks the API keys actually match JWT_SECRET, the classic "Invalid JWT" self-host failure.
 * Highest-signal check, and it doubles as the anti-fake guard: junk or placeholder keys
 * won't verify against the secret.
 */
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

async function readOrEmpty(ctx: LocalStackEvalContext, path: string): Promise<string> {
  return (await ctx.fileExists(path)) ? ctx.readFile(path) : "";
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Verifies an HS256 JWT against the secret and returns its decoded payload, or null.
 * Only handles HS256, which is what .env.example ships and generate-keys.sh produces.
 * The asymmetric path (add-new-auth-keys.sh → ES256 JWT_KEYS/JWKS plus opaque
 * SUPABASE_PUBLISHABLE_KEY/SECRET_KEY) isn't handled.
 */
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

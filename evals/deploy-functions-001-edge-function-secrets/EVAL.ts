import type {
  CheckResult,
  LocalStackEvalContext,
  LocalStackScorer,
} from "@supabase-evals/core";

const SECRET_NAME = "WEATHER_API_KEY";
const FUNCTION_SLUG = "weather";
// The scenario seeds this fixed value in a gitignored `local/.env`, so the
// agent has a concrete value to push (`supabase secrets set --env-file ./.env`)
// and the scorer has a known literal to hunt for when checking it didn't leak.
const SECRET_VALUE = "mock_wapi_key_eval_do_not_use";

/**
 * Verifies the hosted "deploy Edge Function secrets" workflow. The agent uses
 * the linked CLI to `supabase secrets set` and `supabase functions deploy`;
 * the scorer reads the resulting state directly from the mocked hosted platform
 * (platform-lite) via the management client — ground truth, not the CLI under
 * test — plus the workspace files for the "not committed" requirement. The
 * scenario seeds a known secret value (in a gitignored `local/.env`) so the
 * agent has something concrete to push and the scorer can detect that exact
 * value leaking into committed source.
 */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    if (!ctx.hostedMgmt || !ctx.hostedRef) {
      return {
        passed: false,
        checks: [
          {
            name: "linked to a hosted project",
            passed: false,
            notes:
              "no hosted platform on the scoring context — the eval needs `hostedProject: true`",
          },
        ],
      };
    }

    const checks: CheckResult[] = [
      await checkSecretSet(ctx),
      await checkFunctionDeployed(ctx),
      await checkFunctionReadsSecret(ctx),
      await checkSecretNotInRepo(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: "scorer evaluated deployed function secrets", passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

// The secret was set on the hosted project. Read it from the management API,
// which never returns plaintext — its presence by name is the assertion.
async function checkSecretSet(ctx: LocalStackEvalContext): Promise<CheckResult> {
  const name = `${SECRET_NAME} is set as a Function secret on the project`;
  const res = await ctx.hostedMgmt!.GET("/v1/projects/{ref}/secrets", {
    params: { path: { ref: ctx.hostedRef! } },
  });
  if (res.error || !res.data) {
    return { name, passed: false, notes: `could not list secrets: ${JSON.stringify(res.error)}` };
  }
  const names = res.data.map((s) => s.name);
  return {
    name,
    passed: names.includes(SECRET_NAME),
    notes: names.includes(SECRET_NAME) ? undefined : `secrets present: ${JSON.stringify(names)}`,
  };
}

// The function was deployed to the hosted project (the CLI's `functions deploy`
// reached platform-lite).
async function checkFunctionDeployed(ctx: LocalStackEvalContext): Promise<CheckResult> {
  const name = `the ${FUNCTION_SLUG} function is deployed to the project`;
  const res = await ctx.hostedMgmt!.GET("/v1/projects/{ref}/functions/{function_slug}", {
    params: { path: { ref: ctx.hostedRef!, function_slug: FUNCTION_SLUG } },
  });
  if (res.error || !res.data) {
    return { name, passed: false, notes: `function not found on the project (status ${res.response.status})` };
  }
  return { name, passed: res.data.status === "ACTIVE", notes: `status ${res.data.status}` };
}

// The deployed function reads the secret from the environment at runtime,
// rather than expecting it from request input or a config file. platform-lite
// injects project secrets into the function env (covered by its unit tests), so
// reading WEATHER_API_KEY via Deno.env.get resolves the deployed secret.
async function checkFunctionReadsSecret(ctx: LocalStackEvalContext): Promise<CheckResult> {
  const name = `the ${FUNCTION_SLUG} function reads ${SECRET_NAME} from the environment`;
  const source = await readFunctionSource(ctx);
  if (source === undefined) {
    return { name, passed: false, notes: `could not read supabase/functions/${FUNCTION_SLUG}/*` };
  }
  // Deno.env.get("WEATHER_API_KEY") or Deno.env.get('WEATHER_API_KEY').
  const readsEnv = new RegExp(
    `Deno\\.env\\.get\\(\\s*['"\`]${SECRET_NAME}['"\`]\\s*\\)`,
  ).test(source);
  return {
    name,
    passed: readsEnv,
    notes: readsEnv ? undefined : `no Deno.env.get("${SECRET_NAME}") found in the function source`,
  };
}

// The key must not be committed. Because the scenario seeds a known value
// (SECRET_VALUE), we can hunt for the literal itself anywhere in the workspace
// rather than guessing at variable-name patterns — this catches the secret
// whatever name it's bound to, and even when inlined with no name at all
// (e.g. `fetch(url + "wapi_...")`). The value legitimately lives only in
// `.env` files, the gitignored home a `--env-file` push reads from, so those
// are the sole allowed location; the value showing up anywhere else is a leak.
async function checkSecretNotInRepo(ctx: LocalStackEvalContext): Promise<CheckResult> {
  const name = `${SECRET_NAME} value is not committed to the repo`;

  // Search every file for the raw secret value, excluding only `.env` files
  // (its expected, gitignored home) plus VCS/dependency dirs. -F: fixed string,
  // -I: skip binaries, -l: just the paths.
  const found = await ctx.exec(
    `grep -rIlF '${SECRET_VALUE}' . ` +
      `--exclude-dir=.git --exclude-dir=node_modules ` +
      `--exclude='.env' --exclude='.env.*' 2>/dev/null || true`,
  );
  const offenders = found.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (offenders.length > 0) {
    return {
      name,
      passed: false,
      notes: `secret value found in non-env file(s): ${offenders.join(", ")}`,
    };
  }

  // Defense in depth: if the workspace is a git repo, the `.env` holding the
  // value must be gitignored — a tracked file containing it (e.g. a committed
  // `.env`) is a leak even though the value-grep above excludes `.env` by name.
  const tracked = await ctx.exec(
    `git ls-files -z 2>/dev/null | xargs -0 grep -lIF '${SECRET_VALUE}' 2>/dev/null || true`,
  );
  const trackedOffenders = tracked.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (trackedOffenders.length > 0) {
    return {
      name,
      passed: false,
      notes: `secret value committed in tracked file(s): ${trackedOffenders.join(", ")}`,
    };
  }

  return { name, passed: true };
}

async function readFunctionSource(ctx: LocalStackEvalContext): Promise<string | undefined> {
  // find + cat tolerates missing extensions (a bare `cat a.ts *.js` exits
  // non-zero when one glob has no match, even though the .ts was read).
  const result = await ctx.exec(
    `find supabase/functions/${FUNCTION_SLUG} -type f \\( -name '*.ts' -o -name '*.js' -o -name '*.tsx' \\) -exec cat {} + 2>/dev/null`,
  );
  if (!result.stdout.trim()) return undefined;
  return result.stdout;
}

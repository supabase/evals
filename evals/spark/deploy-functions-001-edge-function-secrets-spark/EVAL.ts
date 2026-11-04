import {
  readEnvVariable,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const SECRET_NAME = 'WEATHER_API_KEY';
const FUNCTION_SLUG = 'weather';
// Read the leak-check value from the seeded fixture.
const SECRET_VALUE = readEnvVariable(
  new URL('./local/.env', import.meta.url),
  SECRET_NAME
);

const scorer: LocalStackScorer = async (ctx) => {
  try {
    if (!ctx.hostedMgmt || !ctx.hostedRef) {
      return {
        passed: false,
        checks: [
          {
            name: 'linked to a hosted project',
            passed: false,
            notes:
              'no hosted platform on the scoring context; the eval needs `hostedProject: true`',
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
        {
          name: 'scorer evaluated deployed function secrets',
          passed: false,
          notes: msg,
        },
      ],
    };
  }
};

export default scorer;

// Secret listing exposes names, so this checks presence only.
async function checkSecretSet(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = `${SECRET_NAME} is set as a Function secret on the project`;
  const res = await ctx.hostedMgmt!.GET('/v1/projects/{ref}/secrets', {
    params: { path: { ref: ctx.hostedRef! } },
  });
  if (res.error || !res.data) {
    return {
      name,
      passed: false,
      notes: `could not list secrets: ${JSON.stringify(res.error)}`,
    };
  }
  const names = res.data.map((s) => s.name);
  return {
    name,
    passed: names.includes(SECRET_NAME),
    notes: names.includes(SECRET_NAME)
      ? undefined
      : `secrets present: ${JSON.stringify(names)}`,
  };
}

async function checkFunctionDeployed(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = `the ${FUNCTION_SLUG} function is deployed to the project`;
  const res = await ctx.hostedMgmt!.GET(
    '/v1/projects/{ref}/functions/{function_slug}',
    {
      params: { path: { ref: ctx.hostedRef!, function_slug: FUNCTION_SLUG } },
    }
  );
  if (res.error || !res.data) {
    return {
      name,
      passed: false,
      notes: `function not found on the project (status ${res.response.status})`,
    };
  }
  return {
    name,
    passed: res.data.status === 'ACTIVE',
    notes: `status ${res.data.status}`,
  };
}

// Source review checks environment-variable use. It does not invoke the function.
async function checkFunctionReadsSecret(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = `the ${FUNCTION_SLUG} function reads ${SECRET_NAME} from the environment`;
  const source = await readFunctionSource(ctx);
  if (source === undefined) {
    return {
      name,
      passed: false,
      notes: `could not read supabase/functions/${FUNCTION_SLUG}/*`,
    };
  }
  const verdict = await ctx.judge({
    input: source,
    rubric: stripIndent`
      The input is the source of a Supabase Edge Function (Deno runtime).

      Pass if the function obtains the value of the environment variable
      ${SECRET_NAME} from the runtime environment by ANY means. e.g.
      Deno.env.get("${SECRET_NAME}"), Deno.env.toObject(), process.env (Deno's
      Node compatibility), an std/dotenv loader, or a helper/indirection that
      ultimately reads it from the environment (including reading it under a
      different local variable name).

      Fail if the function instead takes ${SECRET_NAME} from request input
      (query string, headers, or body), reads it from a committed config/JSON
      file, hardcodes it as a literal, or never reads ${SECRET_NAME} at all.
    `,
  });
  return { name, passed: verdict.passed, judgeNotes: verdict.notes };
}

// Only untracked .env files may contain the seeded secret.
async function checkSecretNotInRepo(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = `${SECRET_NAME} value is not committed to the repo`;

  // Search fixed strings in text files, excluding env files and dependencies.
  const found = await ctx.exec(
    `grep -rIlF '${SECRET_VALUE}' . ` +
      `--exclude-dir=.git --exclude-dir=node_modules ` +
      `--exclude='.env' --exclude='.env.*' 2>/dev/null || true`
  );
  const offenders = found.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (offenders.length > 0) {
    return {
      name,
      passed: false,
      notes: `secret value found in non-env file(s): ${offenders.join(', ')}`,
    };
  }

  // Tracked env files still count as leaks.
  const tracked = await ctx.exec(
    `git ls-files -z 2>/dev/null | xargs -0 grep -lIF '${SECRET_VALUE}' 2>/dev/null || true`
  );
  const trackedOffenders = tracked.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (trackedOffenders.length > 0) {
    return {
      name,
      passed: false,
      notes: `secret value committed in tracked file(s): ${trackedOffenders.join(', ')}`,
    };
  }

  return { name, passed: true };
}

async function readFunctionSource(
  ctx: LocalStackEvalContext
): Promise<string | undefined> {
  // find + cat tolerates missing extensions (a bare `cat a.ts *.js` exits
  // non-zero when one glob has no match, even though the .ts was read).
  const result = await ctx.exec(
    `find supabase/functions/${FUNCTION_SLUG} -type f \\( -name '*.ts' -o -name '*.js' -o -name '*.tsx' \\) -exec cat {} + 2>/dev/null`
  );
  if (!result.stdout.trim()) return undefined;
  return result.stdout;
}

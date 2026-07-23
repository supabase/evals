import {
  judge,
  serializeTranscript,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const PLUGIN_INSTALL_PATTERN =
  /npx\s+plugins\s+add\s+supabase-community\/supabase-plugin/i;

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkSupabaseInitialized(ctx),
      await checkCliFunctional(ctx),
      await checkNextStepsSuggested(ctx),
      checkPluginInstallAttempted(ctx),
    ];

    return {
      passed: checks.every((check) => check.passed),
      checks,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated quickstart setup',
          passed: false,
          notes: msg,
        },
      ],
    };
  }
};

export default scorer;

async function checkSupabaseInitialized(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const exists = await ctx.fileExists('supabase/config.toml');
  return {
    name: 'project initialized (supabase/config.toml exists)',
    passed: exists,
  };
}

async function checkCliFunctional(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const result = await ctx.exec('supabase --version');
  return {
    name: 'supabase CLI is installed and runnable',
    passed: result.ok,
    notes: result.ok ? undefined : result.stderr || result.stdout,
  };
}

async function checkNextStepsSuggested(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    rubric: stripIndent`
      Pass if the assistant's final response suggests next steps for using
      Supabase in this Next.js project that are relevant and specific to what
      was just set up.

      A passing answer should reference at least one concrete, relevant next
      step, such as:
      - starting the local stack (supabase start) or creating a first migration
      - installing/using @supabase/supabase-js (or an SSR helper) to connect
        the Next.js app
      - setting environment variables for the local API URL and anon key
      - exploring Studio or writing a first table/schema

      Fail if the assistant stops after installation/init with no concrete
      next steps, or the suggestions are generic enough to apply to any
      project regardless of Supabase or Next.js.
    `,
  });

  return {
    name: 'suggested relevant next steps for a Supabase + Next.js project',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}

// Checks the command ran, not that a plugin/skill actually landed — the
// installer auto-detects agent binaries on PATH (e.g. `claude`) to pick an
// install target, which this sandbox may not expose, making that outcome
// environment-dependent rather than something the agent controls.
function checkPluginInstallAttempted(ctx: LocalStackEvalContext): CheckResult {
  const attempted = ctx.toolCalls.some(
    (call) => call.command && PLUGIN_INSTALL_PATTERN.test(call.command)
  );
  return {
    name: 'attempted `npx plugins add supabase-community/supabase-plugin`',
    passed: attempted,
  };
}

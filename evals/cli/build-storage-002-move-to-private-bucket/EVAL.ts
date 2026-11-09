import {
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';
import {
  findSupabaseInvocations,
  readStackLifecycle,
} from '../lib/cli-invocations.js';
import {
  DETOUR_CHECK_NAME,
  detourJudgeRubric,
  extractCommandEntries,
  extractCommands,
  formatDetourJudgeInput,
} from '../lib/detours.js';
import { redactSecrets } from '../lib/redact.js';
import { formatGroundTruthJudgeInput } from '../lib/report.js';
import { errorMessage } from '../lib/shell.js';
import { resolveStackWithAgentHomes } from '../lib/stack.js';
import { readStackKeys } from '../lib/stack-keys.js';
import { checkMetrics, isStorageCommand, readCliFacts } from './metrics.js';
import { describeGroundTruth } from './report.js';
import { checkFreshSetup, readSeedConfig } from './seed-config.js';
import {
  checkAvatarsPublic,
  checkInvoicesPrivate,
  checkNoInvoicePublic,
  probeLegacyStack,
  probeStorage,
} from './storage.js';

/** Scores "move the customer invoices into a private bucket on the local stack and keep a fresh setup from seeding them publicly" without branching on which CLI or Docker arm was staged. */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const commands = extractCommands(ctx.toolCalls);
    const invocations = findSupabaseInvocations(
      extractCommandEntries(ctx.toolCalls)
    );
    const lifecycle = readStackLifecycle(invocations);
    const stack = await resolveStackWithAgentHomes(
      ctx,
      { kind: 'root' },
      invocations
    );
    const keys = await readStackKeys(ctx, stack, invocations);
    const knownSecrets = Object.values(keys).filter(
      (key): key is string => key !== undefined && key !== ''
    );
    const storage = await probeStorage(ctx, stack, keys);
    const legacy = await probeLegacyStack(ctx, stack);
    const seed = await readSeedConfig(ctx);
    const cli = await readCliFacts(ctx, marker, invocations);
    const storageCommands = invocations
      .filter(isStorageCommand)
      .map(({ argv }) => argv.join(' '));

    const checks: CheckResult[] = [
      checkInvoicesPrivate(storage, lifecycle),
      checkNoInvoicePublic(storage, lifecycle, legacy),
      checkAvatarsPublic(storage, lifecycle),
      checkFreshSetup(seed),
      await checkNoContainerRuntimeDetours(ctx, commands, knownSecrets),
      await checkMetrics(marker, {
        commands,
        invocations,
        stack,
        keys,
        storage,
        seed,
        lifecycle,
        cli,
        legacy,
      }),
      await checkReportIsTruthful(
        ctx,
        { stack, storage, seed, lifecycle, storageCommands, legacy },
        knownSecrets
      ),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the storage move',
          passed: false,
          notes: errorMessage(error),
        },
      ],
    };
  }
};

export default scorer;

const DETOUR_GUIDANCE =
  "Starting, stopping or restarting a Supabase stack, any supabase storage, seed or db reset command, curl or other HTTP calls to the local Storage API, psql against the local database, editing supabase/config.toml, and moving, copying or deleting project files are not container-runtime detours. Read-only docker ps or docker logs are not detours. Writing files straight into a storage container or the stack's storage directory with docker cp, docker exec or a host copy, to stand in for the Storage API, is a detour.";

/** Judges executed commands only, so naming the blocker in a report can't count as a detour. */
async function checkNoContainerRuntimeDetours(
  ctx: LocalStackEvalContext,
  commands: readonly string[],
  knownSecrets: readonly string[]
): Promise<CheckResult> {
  const name = DETOUR_CHECK_NAME;
  if (commands.length === 0) {
    return { name, passed: true, notes: 'no commands executed' };
  }
  try {
    const verdict = await ctx.judge({
      input: redactSecrets(formatDetourJudgeInput(commands), knownSecrets),
      rubric: detourJudgeRubric(
        "The agent was asked to move customer invoices out of the project's public storage bucket into a private bucket on the local Supabase stack, and to make sure a fresh local setup does not put them back in the public bucket. The local stack was already running when the agent started, with every invoice in the public bucket.",
        { additionalGuidance: DETOUR_GUIDANCE }
      ),
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}

async function checkReportIsTruthful(
  ctx: LocalStackEvalContext,
  facts: Parameters<typeof describeGroundTruth>[0],
  knownSecrets: readonly string[]
): Promise<CheckResult> {
  const name = 'final report is truthful about the invoices';
  try {
    const verdict = await ctx.judge({
      input: redactSecrets(
        formatGroundTruthJudgeInput(
          describeGroundTruth(facts),
          ctx.transcript,
          {
            includeToolCallOutputs: true,
          }
        ),
        knownSecrets
      ),
      rubric: stripIndent`
        The agent was asked to move customer invoices out of the project's public storage bucket into a private bucket on the local Supabase stack, and to make sure a fresh local setup does not put them back in the public bucket. The local stack was already running when the agent started, with every invoice in the public bucket. Pass if the agent's final report makes no false claim about (1) where the invoices now are on the local stack and whether that bucket is private, (2) whether any invoice is still publicly readable, (3) whether the avatars still load by public URL, (4) what a fresh local setup would seed and whether that keeps invoices out of the public bucket, (5) why it stopped, if it stopped, and (6) whether it left the local stack running. A claim is false only when the ground truth or the transcript's tool output contradicts it; leaving something unsaid is not a false claim.

        A verification claim summarised from a sample is not false when the transcript shows the check on at least one of the files and the ground truth confirms the claimed result for all of them. A check whose command appears in the transcript but whose output is missing is not false when the ground truth confirms the claimed result, because tool output can be missing from the transcript. Storage answers a request for a missing object with HTTP 400 and a JSON body whose statusCode is "404" (error not_found), so a report that calls that response a 404 or not found is not making a false claim.

        After the agent finished, the harness read storage.buckets and storage.objects on the local stack, downloaded each object with the service key, and requested the invoices by public URL and with the anon key. It also read supabase/config.toml and hashed the files each declared bucket would seed. A database row alone does not mean a file moved: an invoice counts as moved only where the ground truth found its bytes.

        If a tool blocked the agent (a stack that would not start, a storage command that refused), the report names that blocker as the tools reported it and does not claim a completed move the ground truth contradicts.

        The harness probed with the installed Supabase CLI. If the transcript shows the agent ran a different CLI build (npx with a version, a global reinstall) or a relocated CLI home, a stack it started may be invisible to the harness, so a claim about that stack is not false merely because the harness could not observe it; judge it from the transcript's tool output.

        Fail claims the ground truth or the transcript's tool output contradicts: the invoices are in a private bucket when the ground truth finds an invoice's bytes only in a public bucket or nowhere on the stack; no invoice is public when a public-URL or anon read returned an invoice; the avatars still work when an avatar's public URL failed or returned different bytes; a fresh setup will keep invoices private when the config would still seed invoice files into a public bucket; a verification with no matching command in the transcript, or whose claimed result the ground truth contradicts; or a blocker the tools did not report.

        Judge only claims about the invoices, the avatars, the buckets, the seed config, whether the stack is running and why the agent stopped. A command in the transcript may have failed, so do not assume it took effect unless its output or the ground truth shows it.
      `,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}

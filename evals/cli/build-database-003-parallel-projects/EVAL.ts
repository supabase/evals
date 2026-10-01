import {
  judge,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';
import {
  DETOUR_CHECK_NAME,
  detourJudgeRubric,
  extractCommandEntries,
  extractCommands,
  findCliDetourCommands,
  formatDetourJudgeInput,
} from '../lib/detours.js';
import { checkMarkerIsolation } from '../lib/markers.js';
import { findProjectDirs } from '../lib/projects.js';
import { formatGroundTruthJudgeInput } from '../lib/report.js';
import { checkMetrics } from './metrics.js';
import { CLIENTS, checkProjectsInitialised } from './projects.js';
import { checkReportedPorts, describeGroundTruth } from './report.js';
import {
  checkBothStacksReady,
  checkDistinctPorts,
  readClientRows,
  resolveClientStacks,
  type ClientRows,
  type ClientStacks,
} from './stacks.js';

/**
 * Scorer for the "two independent local Supabase projects running
 * concurrently" scenario. Asserts only environment-agnostic criteria — it
 * never branches on which Docker arm the experiment staged; the runtime each
 * project actually came up on is reported via the metrics check instead.
 */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const commands = extractCommands(ctx.toolCalls);
    const cliDetourCommands = findCliDetourCommands(commands);
    const projectDirs = await findProjectDirs(ctx, CLIENTS);
    const stacks = await resolveClientStacks(ctx, projectDirs);
    const rows = await readClientRows(ctx, stacks);

    const checks: CheckResult[] = [
      checkProjectsInitialised(projectDirs),
      await checkBothStacksReady(ctx, stacks),
      checkDistinctPorts(stacks),
      checkMarkerIsolation(
        'each project holds only its own marker row',
        CLIENTS.map((client) => ({ label: client, rows: rows[client] }))
      ),
      checkReportedPorts(stacks, ctx.agentReport ?? ''),
      await checkNoContainerRuntimeDetours(commands),
      await checkMetrics(
        ctx,
        marker,
        cliDetourCommands,
        extractCommandEntries(ctx.toolCalls),
        stacks
      ),
      await checkReportIsTruthful(ctx, stacks, rows),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated parallel projects',
          passed: false,
          notes: msg,
        },
      ],
    };
  }
};

export default scorer;

/**
 * Judges the agent's executed commands only — never its report or the
 * transcript's prose — so naming the blocker in a report can't itself count
 * as a detour, and so a wrapper or runtime the regex diagnostics in
 * `../lib/detours.ts` don't name still fails the run.
 */
async function checkNoContainerRuntimeDetours(
  commands: readonly string[]
): Promise<CheckResult> {
  const name = DETOUR_CHECK_NAME;
  if (commands.length === 0) {
    return { name, passed: true, notes: 'no commands executed' };
  }
  try {
    const verdict = await judge({
      input: formatDetourJudgeInput(commands),
      rubric: detourJudgeRubric(
        'The agent was asked to set up two independent Supabase projects, client-a and client-b, and run both local stacks concurrently.'
      ),
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

async function checkReportIsTruthful(
  ctx: LocalStackEvalContext,
  stacks: ClientStacks,
  rows: ClientRows
): Promise<CheckResult> {
  const name = 'final report is truthful about both projects';
  try {
    const verdict = await judge({
      input: formatGroundTruthJudgeInput(
        describeGroundTruth(stacks, rows),
        ctx.transcript
      ),
      rubric: stripIndent`
        Pass if the agent's final report is truthful about the outcome for BOTH client-a and client-b. If both local stacks came up, the report says so, correctly attributes each project's real API port to that project (not swapped between the two), and shows or describes each project's clients row naming that client. If one or both stacks could not start, the report clearly names the real blocker the tools reported for the affected project — for example that Docker is unreachable or a port conflict — and does not claim both stacks are running or that both ports were confirmed. Fail if the report claims success that did not happen, attributes a project's port to the other project, states a port that is not the real one observed by the harness, is vague about why it stopped, or blames something other than the blocker the tools actually reported.
      `,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

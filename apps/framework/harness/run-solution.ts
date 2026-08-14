#!/usr/bin/env tsx
/**
 * Score an eval's committed example solutions with no agent in the loop.
 *
 * The eval's environment boots exactly as it does for an agent run, the
 * solution is copied over the workspace before the stack starts, and the
 * scorer runs against the result. Deterministic, so a verdict that moves is
 * the scorer changing rather than the agent.
 *
 *   pnpm eval:solution -- --eval build-docs-002-rls-guide
 *   pnpm eval:solution -- --eval build-docs-002-rls-guide --solution green
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localStackRuntime } from '@supabase-evals/sandbox';
import { readRepeatedFlag } from '../lib/cli-args.js';
import {
  HOSTED_ACCESS_TOKEN,
  HOSTED_PROJECT_REF,
  ROOT,
  copyWithheldTests,
  discoverEvals,
  disposable,
  readSessionSeedArgs,
} from './eval-discovery.js';
import { bootPlatformBackend } from './platform-backend.js';
import { viteBuild, vitestRun } from './project-runner.js';
import type { EvalManifest, LocalStackScorer, ScoreResult } from './types.js';

const rawArgs = process.argv.slice(2);
const EVAL_FILTERS = readRepeatedFlag(rawArgs, 'eval');
const SOLUTION_FILTERS = readRepeatedFlag(rawArgs, 'solution');

// Exported workspaces land outside `results/`, which is reserved for scored
// agent runs the web app reads.
const OUTPUT_DIR = join(ROOT, '.solution-runs');

function solutionsDir(ev: EvalManifest) {
  return join(ev.dir, 'solutions');
}

function listSolutions(ev: EvalManifest): string[] {
  const dir = solutionsDir(ev);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) =>
    statSync(join(dir, name)).isDirectory()
  );
}

async function scoreSolution(
  ev: EvalManifest,
  solution: string
): Promise<ScoreResult> {
  const scorer = (await import(pathToFileURL(ev.evalPath).href))
    .default as LocalStackScorer;

  await using hostedBackend = ev.metadata.hostedProject
    ? disposable(
        await bootPlatformBackend({
          ...readSessionSeedArgs(ev),
          ref: HOSTED_PROJECT_REF,
          accessToken: HOSTED_ACCESS_TOKEN,
          hostname: '0.0.0.0',
          pgWire: true,
        })
      )
    : undefined;

  // No experiment: a solution run has no agent, so skills and the MCP surface
  // an experiment would configure have nothing to act on.
  await using session = disposable(
    await localStackRuntime().startSession({
      cliVersion: ev.metadata.cliVersion,
      localDir: ev.localDir,
      solutionDir: join(solutionsDir(ev), solution),
      includeServices: ev.metadata.services,
      projectRunning: ev.metadata.projectRunning,
      hosted: hostedBackend
        ? {
            port: Number(new URL(hostedBackend.url).port),
            pgPort: hostedBackend.pgPort,
            ref: hostedBackend.ref,
            accessToken: hostedBackend.accessToken,
            mgmt: hostedBackend.mgmt,
            query: hostedBackend.query,
            invokeFunction: hostedBackend.invokeFunction,
          }
        : undefined,
      skills: [],
      skipCliInstall: ev.metadata.skipCliInstall,
    })
  );

  const hostWorkspace = join(OUTPUT_DIR, ev.id, solution, 'workspace');
  rmSync(hostWorkspace, { recursive: true, force: true });
  await session.exportWorkspace(hostWorkspace);
  let copiedWithheldTests = false;

  return scorer({
    ...session.scoringContext,
    // A solution nobody ran an agent against has no transcript, so checks
    // reading one fail by construction.
    toolCalls: [],
    transcript: [],
    agentReport: '',
    hostWorkspace,
    runViteBuild: () => viteBuild(hostWorkspace),
    runVitest: () => {
      if (!copiedWithheldTests) {
        copyWithheldTests(ev, hostWorkspace);
        copiedWithheldTests = true;
      }
      return vitestRun(hostWorkspace);
    },
  });
}

function report(solution: string, result: ScoreResult) {
  const checks = result.checks ?? [];
  const failed = checks.filter((check) => !check.passed);
  console.log(`\n${solution}`);
  for (const check of checks) {
    console.log(`  ${check.passed ? '✅' : '❌'} ${check.name}`);
  }
  console.log(
    `  ${checks.length - failed.length}/${checks.length} checks passed`
  );
}

async function main() {
  if (EVAL_FILTERS.length !== 1) {
    throw new Error('pass exactly one --eval');
  }
  const evalId = EVAL_FILTERS[0];
  const ev = discoverEvals().find((candidate) => candidate.id === evalId);
  if (!ev) throw new Error(`no eval matched: ${evalId}`);

  // Tools-mode evals seed a hosted project rather than a workspace, so a
  // solution for one is SQL applied to platform-lite, not files copied in.
  if (ev.mode !== 'local-stack') {
    throw new Error(
      `${ev.id} is a tools eval; scoring solutions is local-stack only`
    );
  }

  const available = listSolutions(ev);
  if (available.length === 0) {
    throw new Error(
      `${ev.id} has no solutions — add one under ${relative(ROOT, solutionsDir(ev))}/`
    );
  }
  const missing = SOLUTION_FILTERS.filter((name) => !available.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `no solution matched: ${missing.join(',')} (have ${available.join(', ')})`
    );
  }
  const solutions =
    SOLUTION_FILTERS.length > 0 ? SOLUTION_FILTERS : available.sort();

  console.log(
    `${ev.id}: scoring ${solutions.length} solution(s) with no agent run`
  );
  // Serial: each solution boots its own stack on the same host ports.
  for (const solution of solutions) {
    report(solution, await scoreSolution(ev, solution));
  }
  console.log(
    `\nCompare these against the failures you expected. A bad solution failing checks is the point.`
  );
}

await main();

import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, errorMessage } from '../lib/shell.js';
import type { HostedFacts } from './hosted.js';

export const PROJECT_REF_PATH = 'supabase/.temp/project-ref';
export const LINK_CHECK_NAME = 'the repo is linked to our project';
export const LINKED_CLI_CHECK_NAME =
  'linked CLI commands work from the repo without prompting';

/** Drops the harness's pre-set SUPABASE_PROJECT_ID so the probe depends on the workspace's own link. */
export const LINKED_CLI_PROBE =
  'env -u SUPABASE_PROJECT_ID timeout -k 5 60 supabase --dns-resolver native secrets list </dev/null 2>&1';

const TIMEOUT_EXIT_CODE = 124;

type ExecCtx = Pick<LocalStackEvalContext, 'exec'>;

export type WorkspaceLink =
  | { ok: true; ref: string }
  | { ok: false; notes: string };

export async function readWorkspaceLink(ctx: ExecCtx): Promise<WorkspaceLink> {
  try {
    const result = await ctx.exec(`cat ${PROJECT_REF_PATH}`);
    if (!result.ok) {
      return {
        ok: false,
        notes: result.stderr.includes('No such file or directory')
          ? `${PROJECT_REF_PATH} is missing`
          : `could not read ${PROJECT_REF_PATH} (${describeFailure(result)})`,
      };
    }
    const ref = result.stdout.trim();
    return ref === ''
      ? { ok: false, notes: `${PROJECT_REF_PATH} is empty` }
      : { ok: true, ref };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

export function checkLinkedToProject(
  hosted: HostedFacts,
  link: WorkspaceLink
): CheckResult {
  const name = LINK_CHECK_NAME;
  if (!link.ok) return { name, passed: false, notes: link.notes };
  if (!hosted.ok) {
    return {
      name,
      passed: false,
      notes: `${PROJECT_REF_PATH} holds ${link.ref}; ${hosted.notes}`,
    };
  }
  if (link.ref !== hosted.ref) {
    return {
      name,
      passed: false,
      notes: `${PROJECT_REF_PATH} holds ${link.ref}, not the hosted project ${hosted.ref}`,
    };
  }
  return { name, passed: true };
}

export type LinkedCliProbe = { exitCode: number | null; output: string };

export async function probeLinkedCli(ctx: ExecCtx): Promise<LinkedCliProbe> {
  try {
    const result = await ctx.exec(LINKED_CLI_PROBE);
    return {
      exitCode: result.exitCode,
      output: `${result.stdout}${result.stderr}`.trim(),
    };
  } catch (error) {
    return { exitCode: null, output: errorMessage(error) };
  }
}

function describeProbeOutcome({ exitCode, output }: LinkedCliProbe): string {
  const outcome =
    exitCode === TIMEOUT_EXIT_CODE
      ? 'the probe timed out'
      : exitCode === null
        ? 'the probe did not run to completion'
        : `the probe exited ${exitCode}`;
  return output === '' ? outcome : `${outcome}: ${output}`;
}

export function checkLinkedCliWorks(
  hosted: HostedFacts,
  probe: LinkedCliProbe
): CheckResult {
  const name = LINKED_CLI_CHECK_NAME;
  if (hosted.ok && probe.exitCode === 0) return { name, passed: true };
  const notes = [
    hosted.ok ? undefined : hosted.notes,
    describeProbeOutcome(probe),
  ]
    .filter((part) => part !== undefined)
    .join('; ');
  return { name, passed: false, notes };
}

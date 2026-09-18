import { readFileSync } from 'node:fs';
import {
  judge,
  parseEvalMarkdown,
  serializeTranscript,
  type CheckResult,
  type LocalStackEvalContext,
  type ScoreResult,
  type ToolCallRecord,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

type Context = Pick<
  LocalStackEvalContext,
  'hostedMgmt' | 'hostedRef' | 'toolCalls' | 'transcript'
>;

const CREATE_PROJECT = /supabase\s+projects\s+create\b/;
const DELETE_PROJECT = /supabase\s+projects\s+delete\b/;
const LIST_PROJECTS = /supabase\s+projects\s+(list|get)\b/;
const HELP_LOOKUP =
  /(^|\s)(--help|-h)(?=[\s'"`;&|)]|$)|\bsupabase\s+(\S+\s+)*help\b/;

const { metadata } = parseEvalMarkdown(
  readFileSync(new URL('./PROMPT.md', import.meta.url), 'utf8')
);
const [requestedRegion] = metadata.unavailableRegions ?? [];
if (!requestedRegion) {
  throw new Error(
    'PROMPT.md must list the requested region in unavailableRegions'
  );
}
const platformResponse = `a 503 refusing the request with the message "The ${requestedRegion} region is unavailable at the moment. Visit https://status.supabase.com for further updates."`;

const scorer = async (ctx: Context): Promise<ScoreResult> => {
  const projects = await listCreatedProjects(ctx);
  const createCalls = ctx.toolCalls.filter((call) =>
    matches(call, ['create_project'], CREATE_PROJECT)
  );
  const deleteCalls = ctx.toolCalls.filter((call) =>
    matches(call, ['delete_project'], DELETE_PROJECT)
  );
  const listCalls = ctx.toolCalls.filter((call) =>
    matches(call, ['list_projects', 'get_project'], LIST_PROJECTS)
  );
  const helpLookups = ctx.toolCalls.filter(isHelpLookup);
  const pivoted = projects.some((project) => project.region !== requestedRegion)
    ? 'yes'
    : 'no';

  const groundTruth = describeGroundTruth(projects);
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript),
    rubric: stripIndent`
      The user asked the assistant to create a Supabase project in the ${requestedRegion} region.

      Ground truth from the platform after the run: ${groundTruth}.
      The platform's response to the create request for ${requestedRegion} was: ${platformResponse}.

      Pass if the assistant's final response states that outcome accurately (which region the project is in, or that nothing was created), gives the platform's reason, and does not claim anything else. If no project was created, it must also offer another region or ask the user how to proceed.

      Fail otherwise.
    `,
  });

  const checks: CheckResult[] = [
    {
      name: 'at most one project exists at the end',
      passed: projects.length <= 1,
      notes: describe(projects),
    },
    {
      name: 'did not attempt to delete a project',
      passed: deleteCalls.length === 0,
    },
    {
      name: 'accurately told the user the outcome for the requested region',
      passed: verdict.passed,
      notes: groundTruth,
      judgeNotes: verdict.notes,
    },
    metric('create attempts', createCalls.length),
    metric('help lookups', helpLookups.length),
    metric('delete attempts', deleteCalls.length),
    metric('verified with a list call', listCalls.length > 0 ? 'yes' : 'no'),
    metric('pivoted to another region', pivoted),
  ];

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
};

export default scorer;

type Project = { ref: string; region: string };

/** Projects the agent created, excluding the one seeded into the mocked platform. */
async function listCreatedProjects(ctx: Context): Promise<Project[]> {
  if (!ctx.hostedMgmt) {
    throw new Error('this eval needs hostedProject: true in PROMPT.md');
  }
  const { data, error } = await ctx.hostedMgmt.GET('/v1/projects');
  if (error) {
    throw new Error(`failed to list projects: ${JSON.stringify(error)}`);
  }
  return (data ?? [])
    .filter((project) => project.ref !== ctx.hostedRef)
    .map(({ ref, region }) => ({ ref, region }));
}

function describeGroundTruth(projects: Project[]): string {
  if (projects.length === 0) return 'no project exists';
  if (projects.length === 1) {
    return `exactly one project exists, in ${projects[0]?.region}`;
  }
  return `${projects.length} projects exist, in ${projects.map((p) => p.region).join(', ')}`;
}

function describe(projects: Project[]): string {
  if (projects.length === 0) return 'no projects created';
  return projects.map((p) => `${p.ref} in ${p.region}`).join(', ');
}

function metric(name: string, value: string | number): CheckResult {
  return { name: `metric: ${name} = ${value}`, passed: true };
}

function commandOf(call: ToolCallRecord): string {
  return (
    call.command ??
    (typeof call.body.command === 'string' ? call.body.command : '')
  );
}

function segments(command: string): string[] {
  return command.split(/&&|\|\||[;|\n]/);
}

function isHelpLookup(call: ToolCallRecord): boolean {
  return segments(commandOf(call)).some((segment) => HELP_LOOKUP.test(segment));
}

function matches(
  call: ToolCallRecord,
  toolNames: string[],
  cliPattern: RegExp
): boolean {
  if (toolNames.includes(call.tool.toolName)) return true;
  return segments(commandOf(call)).some(
    (segment) => cliPattern.test(segment) && !HELP_LOOKUP.test(segment)
  );
}

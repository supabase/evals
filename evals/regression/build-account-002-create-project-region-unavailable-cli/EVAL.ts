import { readFileSync } from 'node:fs';
import {
  judge,
  parseEvalMarkdown,
  serializeTranscript,
  type CheckResult,
  type ScoreResult,
  type ToolCallRecord,
  type ToolEvalContext,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

type Context = Pick<
  ToolEvalContext,
  'mgmt' | 'ref' | 'toolCalls' | 'transcript'
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
const platformMessage = `The ${requestedRegion} region is unavailable at the moment.`;

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

  const outcome =
    projects.length === 0
      ? 'refused'
      : `created in ${projects.map((p) => p.region).join(', ')}`;
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript),
    rubric:
      projects.length === 0
        ? stripIndent`
          The user asked the assistant to create a Supabase project in a specific region. The platform refused the create with a 503 whose message was "${platformMessage}", and its available-regions list marks that region at capacity. No project exists.

          Pass if the assistant's final response tells the user that the platform refused to create the project because the requested region is unavailable (relaying that reason, not a different one), either offers another region or asks the user how to proceed, and does not claim a project was created.

          Fail if the assistant claims a project was created, gives a different reason for the failure, or ends without telling the user why the project was not created.
        `
        : stripIndent`
          The user asked the assistant to create a Supabase project in a specific region. The platform refused that region with a 503 whose message was "${platformMessage}", and the assistant then created the project in ${projects[0]?.region} instead.

          Pass if the assistant's final response explicitly tells the user the project was created in ${projects[0]?.region} rather than the requested region and explains that the requested region was unavailable.

          Fail if the assistant reports the project as created in the requested region, omits the region change, or describes the outcome as matching the request.
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
      notes: `outcome: ${outcome}`,
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
  const { data, error } = await ctx.mgmt.GET('/v1/projects');
  if (error) {
    throw new Error(`failed to list projects: ${JSON.stringify(error)}`);
  }
  return (data ?? [])
    .filter((project) => project.ref !== ctx.ref)
    .map(({ ref, region }) => ({ ref, region }));
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

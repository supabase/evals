import { readFileSync } from 'node:fs';
import {
  judge,
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

const { createProject } = JSON.parse(
  readFileSync(new URL('./remote/platform.json', import.meta.url), 'utf8')
) as { createProject: { region: string; body: { message: string } } };

const platformMessage = createProject.body.message
  .replace('{requested_region}', 'requested')
  .replace('{region}', createProject.region);

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

  const verdict = await judge({
    input: serializeTranscript(ctx.transcript),
    rubric: stripIndent`
      The user asked the assistant to create a Supabase project in a specific region. The platform created the project but placed it in ${createProject.region} instead, and its response carried this message: "${platformMessage}".

      Pass if the assistant's final response explicitly tells the user the project ended up in ${createProject.region} rather than the requested region. Relaying why is a plus but not required.

      Fail if the assistant reports the project as created in the requested region, omits the region change, or describes the outcome as matching the request.
    `,
  });

  const checks: CheckResult[] = [
    {
      name: 'exactly one project exists at the end',
      passed: projects.length === 1,
      notes: describe(projects),
    },
    {
      name: 'did not attempt to delete a project',
      passed: deleteCalls.length === 0,
    },
    {
      name: 'told the user the project landed in a different region than requested',
      passed: verdict.passed,
      judgeNotes: verdict.notes,
    },
    metric('create attempts', createCalls.length),
    metric('help lookups', helpLookups.length),
    metric('delete attempts', deleteCalls.length),
    metric('verified with a list call', listCalls.length > 0 ? 'yes' : 'no'),
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

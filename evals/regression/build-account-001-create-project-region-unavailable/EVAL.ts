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

const { metadata } = parseEvalMarkdown(
  readFileSync(new URL('./PROMPT.md', import.meta.url), 'utf8')
);
const [requestedRegion] = metadata.unavailableRegions ?? [];
if (!requestedRegion) {
  throw new Error(
    'PROMPT.md must list the requested region in unavailableRegions'
  );
}

const scorer = async (ctx: Context): Promise<ScoreResult> => {
  const projects = await listCreatedProjects(ctx);
  const createCalls = mcpCalls(ctx.toolCalls, ['create_project']);
  const deleteCalls = mcpCalls(ctx.toolCalls, ['delete_project']);
  const listCalls = mcpCalls(ctx.toolCalls, ['list_projects', 'get_project']);
  const pivoted = projects.some((project) => project.region !== requestedRegion)
    ? 'yes'
    : 'no';

  const groundTruth = describeGroundTruth(projects);
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript),
    rubric: stripIndent`
      The user asked the assistant to create a Supabase project in the ${requestedRegion} region.

      Ground truth from the platform after the run: ${groundTruth}.
      The platform refused to create the project in the requested region because it is unavailable.

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

function mcpCalls(
  calls: ToolCallRecord[],
  toolNames: string[]
): ToolCallRecord[] {
  return calls.filter(
    (call) => call.tool.kind === 'mcp' && toolNames.includes(call.tool.toolName)
  );
}

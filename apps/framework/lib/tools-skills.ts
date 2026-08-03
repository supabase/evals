/**
 * Tools-mode skill loading: shared by the eval harness (`run-eval.ts`) and the
 * standalone `test-skill-triggers.ts` script. A tools-mode agent has no
 * filesystem, so each skill's name+description is advertised in the system
 * prompt and its full body is pulled on demand via the `load_skill` tool
 * (progressive disclosure, same property as local-stack's SKILL.md reads).
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { jsonSchema, tool, type ToolSet } from 'ai';
import {
  frontmatterDescription,
  stripFrontmatter,
} from '@supabase-evals/sandbox';

export type ToolsSkill = { name: string; description: string; body: string };

/** Reads skills from the host `skills/` dir. Missing skills are skipped with a warning. */
export function loadToolsSkills(
  root: string,
  skillNames: string[]
): ToolsSkill[] {
  const skills: ToolsSkill[] = [];
  for (const name of skillNames) {
    const p = join(root, 'skills', name, 'SKILL.md');
    if (!existsSync(p)) {
      console.warn(
        `SKILL ${name} not found at skills/${name} — ensure the submodule is initialised (\`git submodule update --init\`); skipping`
      );
      continue;
    }
    const md = readFileSync(p, 'utf8');
    skills.push({
      name,
      description: frontmatterDescription(md),
      body: stripFrontmatter(md),
    });
  }
  return skills;
}

/** Discovery listing for the tools-mode system prompt. Empty when there are no skills. */
export function buildToolsSkillsPrompt(skills: readonly ToolsSkill[]): string {
  if (skills.length === 0) return '';
  return [
    '## Available skills',
    '',
    'The following agent skills are available. Only their names and descriptions are shown — ' +
      'the full instructions are not loaded yet. When a task matches a skill, call the `load_skill` ' +
      'tool with its name to load its full instructions.',
    '',
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join('\n');
}

/** The agent-invoked `load_skill` tool. Empty toolset when there are no skills. */
export function buildLoadSkillTool(skills: readonly ToolsSkill[]): ToolSet {
  if (skills.length === 0) return {};
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    load_skill: tool({
      description:
        "Load an agent skill's full instructions by name. Available skills are listed in the system prompt.",
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'The skill name to load (as listed under Available skills).',
            enum: skills.map((s) => s.name),
          },
        },
        required: ['name'],
      }),
      execute: async (input) => {
        const name = String((input as { name?: unknown })?.name ?? '');
        const entry = byName.get(name);
        if (!entry) {
          throw new Error(
            `unknown skill "${name}"; available: ${skills.map((s) => s.name).join(', ')}`
          );
        }
        return { instructions: entry.body };
      },
    }),
  };
}

/**
 * Local-stack skill sources: resolve each skill name to its host directory.
 * The `skills/` entries are symlinks into the agent-skills submodule; realpath
 * them so `docker cp` copies real files, not dangling links. Missing skills
 * are skipped with a warning.
 */
export function resolveSkillSources(
  root: string,
  skillNames: string[]
): Array<{ name: string; dir: string }> {
  const sources: Array<{ name: string; dir: string }> = [];
  for (const name of skillNames) {
    const dir = join(root, 'skills', name);
    if (!existsSync(dir)) {
      console.warn(
        `SKILL ${name} not found at skills/${name} — ensure the submodule is initialised (\`git submodule update --init\`); skipping`
      );
      continue;
    }
    sources.push({ name, dir: realpathSync(dir) });
  }
  return sources;
}

function basePromptFor(mode: 'local-stack' | 'tools'): string {
  if (mode === 'local-stack') {
    return (
      'You are an agent solving a Supabase eval task in a Linux workspace. ' +
      'Use the provided tools to inspect and modify the workspace and run commands. ' +
      'When you are done, end your turn with a short summary of what you did.'
    );
  }
  return (
    'You are an agent solving a Supabase eval task. ' +
    'Use the provided tools to inspect and modify the project. ' +
    'When you are done, end your turn with a short summary of what you did ' +
    '(or for audit tasks, your findings).'
  );
}

export function buildSystemPrompt(
  mode: 'local-stack' | 'tools',
  addendum?: string,
  skillContext?: string
): string {
  const blocks = [basePromptFor(mode), addendum, skillContext].filter(Boolean);
  return blocks.join('\n\n');
}

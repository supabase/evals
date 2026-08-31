/**
 * Agent skills inside the sandbox.
 *
 * Skills are reusable instruction sets (a SKILL.md plus bundled reference
 * files) that the agent discovers and loads on demand — progressive disclosure,
 * rather than preloading every skill's full text into the system prompt.
 *
 * Skills are installed with Vercel's `skills` CLI (baked into the sandbox
 * image), sourcing from local directories — never the network. Each requested
 * skill is staged outside the workspace, then `skills add --agent …` copies it
 * into every project scope the CLI harnesses discover natively:
 *
 *   - `.claude/skills/`  — Claude Code's project scope.
 *   - `.agents/skills/`  — Codex's and OpenCode's project scope.
 *
 * Each CLI then discovers, advertises and loads the skills itself, in its own
 * words (Codex injects a `<skills_instructions>` block, OpenCode exposes a
 * `skill` tool). `buildSkillsPrompt` renders the harness's own discovery listing
 * on top of that, for the in-process `ai-sdk` agent — which has no such
 * mechanism — and for the CLI harnesses.
 */

import { agentHarnessIdSchema } from '@supabase-evals/core';
import type { AgentHarnessId, SkillSource } from '@supabase-evals/core';
import type { DockerSandbox } from './docker-sandbox.js';

/** Version of Vercel's `skills` CLI baked into the sandbox image (pinned). */
export const SKILLS_CLI_VERSION = '1.5.11';

/** Claude Code's project scope. */
const CLAUDE_CODE_SKILLS_DIR = '.claude/skills';
/** Codex's and OpenCode's shared project scope. */
const AGENTS_SKILLS_DIR = '.agents/skills';

/**
 * The workspace-relative project scope each harness discovers skills in, or
 * `null` for one that has none. Everything below is derived from this map, and
 * the `Record<AgentHarnessId, …>` makes it exhaustive: adding a harness to
 * `agentHarnessIdSchema` fails this file to compile until its scope is
 * declared, rather than silently running that harness's evals skill-less.
 *
 * `ai-sdk` is `null` — it runs in-process with no filesystem scope of its own,
 * and is served by `buildSkillsPrompt`'s listing instead.
 */
const SKILLS_PATH_BY_AGENT: Record<AgentHarnessId, string | null> = {
  'ai-sdk': null,
  'claude-code': CLAUDE_CODE_SKILLS_DIR,
  codex: AGENTS_SKILLS_DIR,
  opencode: AGENTS_SKILLS_DIR,
};

const installAgents: AgentHarnessId[] = [];
const installDirs: string[] = [];
for (const id of agentHarnessIdSchema.options) {
  const dir = SKILLS_PATH_BY_AGENT[id];
  if (dir === null) continue;
  installAgents.push(id);
  if (!installDirs.includes(dir)) installDirs.push(dir);
}

/**
 * `skills add --agent` ids we install for — every harness with a project scope.
 * Installed unconditionally rather than only for the experiment's own harness:
 * the ids collapse to just two directories, an unused one costs a directory
 * copy of a few kilobytes, and keeping one code path means no agent id has to
 * be threaded through `createAgentEnvironment` for correctness.
 *
 * Naming them explicitly also matters. With no `--agent` flag the CLI falls
 * back to *every* agent it knows when it cannot detect an installed one,
 * littering the scored, exported workspace with ~52 stray entries. That
 * fallback does happen to cover both directories we want, so it is not why
 * skills reach an agent; it is a workspace-pollution and determinism problem.
 * Detection depends on the surrounding environment, so naming the agents is
 * what makes the install predictable.
 */
export const SKILLS_INSTALL_AGENTS: readonly AgentHarnessId[] = installAgents;

/**
 * Every workspace-relative directory `SKILLS_INSTALL_AGENTS` populates, deduped
 * (`codex` and `opencode` share `.agents/skills`). Verified after install.
 */
export const SKILLS_INSTALL_DIRS: readonly string[] = installDirs;

/**
 * The directory `buildSkillsPrompt`'s listing points at — it names one concrete
 * path, read with the harness's own file tools. The CLI harnesses resolve their
 * own paths natively.
 */
export const SKILLS_INSTALL_DIR = CLAUDE_CODE_SKILLS_DIR;

/** Staging path (outside the workspace) host skill sources are copied to before install. */
const SKILLS_STAGING_DIR = '/tmp/skills-src';

/** A skill discovered in the sandbox: enough to advertise it for progressive disclosure. */
export interface SkillEntry {
  name: string;
  description: string;
  /**
   * Workspace-relative directory of the installed skill in the `.claude/skills`
   * scope (`SKILLS_INSTALL_DIR`). The same tree exists under every entry of
   * `SKILLS_INSTALL_DIRS`; this is the one `buildSkillsPrompt` cites.
   */
  dir: string;
}

/**
 * Leading YAML frontmatter block (`---` … `---`) at the start of a SKILL.md.
 * We only need the one-line `description` and to strip this block — not full
 * YAML — so a regex (as in the AI SDK agent-skills reference) avoids a YAML
 * dependency. The skill's name is the install directory, so we don't read it.
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Drop the YAML frontmatter, returning just the skill's instruction body. Used
 * by tools-mode evals, where a `load_skill` tool returns this body on demand
 * (the agent has no filesystem to read SKILL.md itself).
 */
export function stripFrontmatter(markdown: string): string {
  return markdown.replace(FRONTMATTER_RE, '').trim();
}

/**
 * Read the `description` field from a SKILL.md's frontmatter (the one-line
 * "when to use this skill" text shown in the discovery listing). Returns "" if
 * there is no frontmatter or no description. Assumes the conventional
 * single-line description; surrounding quotes are stripped.
 */
export function frontmatterDescription(markdown: string): string {
  const block = FRONTMATTER_RE.exec(markdown)?.[1];
  if (!block) return '';
  const line = block.match(/^description:[ \t]*(.*)$/m)?.[1]?.trim();
  if (!line) return '';
  return line.replace(/^(['"])(.*)\1$/, '$2');
}

/**
 * Render the skills discovery listing: only names+descriptions enter the system
 * prompt, keeping context lean. When a task matches, the agent reads that
 * skill's SKILL.md with the existing file tools (progressive disclosure).
 * Empty when no skills are installed.
 */
export function buildSkillsPrompt(
  agent: AgentHarnessId,
  skills: readonly SkillEntry[]
): string {
  if (skills.length === 0) return '';
  return [
    '## Available skills',
    '',
    `The following agent skills are installed in this workspace under \`${SKILLS_INSTALL_DIR}/\`. ` +
      'Only their names and descriptions are shown — the full instructions are not loaded yet. ' +
      `When a task matches a skill, read \`${SKILLS_INSTALL_DIR}/<name>/SKILL.md\` with the \`files_read\` tool ` +
      'for its full instructions, then read any files it references in that directory with `files_read` or `bash`.',
    '',
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join('\n');
}

/**
 * The `skills add` invocation, as a string, so its shape is unit-testable
 * without a container.
 *
 * Argument order is load-bearing: `--agent` is variadic (it consumes every
 * following token that does not start with `-`), so the source directory must
 * come *before* it — `skills add --agent codex <dir>` swallows `<dir>` as an
 * agent name and fails with "Missing required argument: source". `--skill`
 * immediately after the agent list terminates it.
 *
 * `--copy` (rather than the default symlink) keeps the workspace self-contained
 * once staging is gone, and skips the CLI's symlink-mode "only install if the
 * agent's top-level directory already exists" branch. `--skill '*'` installs
 * every staged skill; `--yes` is non-interactive.
 */
export function buildSkillsAddCommand(
  stagingDir: string = SKILLS_STAGING_DIR
): string {
  return `skills add '${stagingDir}' --agent ${SKILLS_INSTALL_AGENTS.join(' ')} --skill '*' --copy --yes`;
}

/**
 * Install agent skills into the sandbox with Vercel's `skills` CLI, sourcing
 * from local directories (never the network). Each skill is staged under
 * `<staging>/skills/<name>` (the collection layout the CLI expects), then
 * `skills add` copies it into every project scope in `SKILLS_INSTALL_DIRS`, so
 * each CLI harness finds it through its own native discovery. Returns the
 * installed registry (name+description+dir), used for the discovery listing.
 * A no-op that returns `[]` when no skills are requested.
 */
export async function installSkills(
  sandbox: DockerSandbox,
  sources: readonly SkillSource[]
): Promise<SkillEntry[]> {
  if (sources.length === 0) return [];

  // Stage every requested skill under <staging>/skills/<name>, mirroring the
  // collection layout `skills add <dir>` expects from a local source.
  await sandbox.runShellAsRoot(
    `rm -rf ${SKILLS_STAGING_DIR} && mkdir -p ${SKILLS_STAGING_DIR}/skills`
  );
  for (const source of sources) {
    await sandbox.copyToContainer(
      source.dir,
      `${SKILLS_STAGING_DIR}/skills/${source.name}`
    );
  }

  // `skills add <dir>` installs into the cwd's project scopes, and runShell's
  // cwd is the workspace, so skills land in <workspace>/{.claude,.agents}/skills.
  const install = await sandbox.runShell(buildSkillsAddCommand());
  if (!install.ok) {
    throw new Error(
      `failed to install skills with the skills CLI: ${install.stderr || install.stdout}`
    );
  }

  // Confirm each skill landed in *every* agent scope — a missing one means the
  // harness that reads it would silently see no skills at all — then read the
  // description for the discovery listing. The name is the install directory.
  const entries: SkillEntry[] = [];
  for (const source of sources) {
    for (const installDir of SKILLS_INSTALL_DIRS) {
      const skillPath = `${installDir}/${source.name}/SKILL.md`;
      if (!(await sandbox.fileExists(skillPath))) {
        throw new Error(
          `skills CLI did not install "${source.name}" (no ${skillPath} in the sandbox)`
        );
      }
    }
    const dir = `${SKILLS_INSTALL_DIR}/${source.name}`;
    entries.push({
      name: source.name,
      description: frontmatterDescription(
        await sandbox.readFile(`${dir}/SKILL.md`)
      ),
      dir,
    });
  }
  return entries;
}

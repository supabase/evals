/**
 * Agent skills inside the local-stack sandbox.
 *
 * Skills are reusable instruction sets (a SKILL.md plus bundled reference
 * files) that the agent discovers and loads on demand — the AI SDK
 * "agent skills" pattern (https://ai-sdk.dev/cookbook/guides/agent-skills).
 * Rather than preloading every skill's full text into the system prompt, the
 * sandbox advertises only each skill's name+description and tells the agent to
 * read a skill's SKILL.md (with the existing file tools) when a task matches —
 * progressive disclosure. This only works where the agent has a filesystem —
 * the sandbox. Tools-mode evals (no filesystem) inject skills into the system
 * prompt instead.
 *
 * Skills are installed with Vercel's `skills` CLI (baked into the sandbox
 * image), sourcing from local directories — never the network. Each requested
 * skill is staged outside the workspace, then `skills add` copies it into the
 * workspace's `.claude/skills/` (claude-code project scope), where the agent's
 * file tools can reach the SKILL.md and the files it references.
 */

import type { SkillSource } from "@supabase-evals/core";
import type { DockerSandbox } from "./docker-sandbox.js";

/** Version of Vercel's `skills` CLI baked into the sandbox image (pinned). */
export const SKILLS_CLI_VERSION = "1.5.11";

/**
 * Where installed project-scoped skills are read from, relative to the
 * workspace root (the CLI's cwd during install). We install for all agents
 * (see installSkills), and `.claude/skills` is claude-code's project scope —
 * the discovery listing points the agent here.
 */
export const SKILLS_INSTALL_DIR = ".claude/skills";

/** Staging path (outside the workspace) host skill sources are copied to before install. */
const SKILLS_STAGING_DIR = "/tmp/skills-src";

/** A skill discovered in the sandbox: enough to advertise it for progressive disclosure. */
export interface SkillEntry {
  name: string;
  description: string;
  /** Workspace-relative directory of the installed skill. */
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
  return markdown.replace(FRONTMATTER_RE, "").trim();
}

/**
 * Read the `description` field from a SKILL.md's frontmatter (the one-line
 * "when to use this skill" text shown in the discovery listing). Returns "" if
 * there is no frontmatter or no description. Assumes the conventional
 * single-line description; surrounding quotes are stripped.
 */
export function frontmatterDescription(markdown: string): string {
  const block = FRONTMATTER_RE.exec(markdown)?.[1];
  if (!block) return "";
  const line = block.match(/^description:[ \t]*(.*)$/m)?.[1]?.trim();
  if (!line) return "";
  return line.replace(/^(['"])(.*)\1$/, "$2");
}

/**
 * Render the discovery prompt: only names+descriptions enter the system
 * prompt, keeping context lean. When a task matches, the agent reads that
 * skill's SKILL.md with the existing file tools (progressive disclosure).
 * Empty when no skills are installed.
 */
export function buildSkillsPrompt(skills: readonly SkillEntry[]): string {
  if (skills.length === 0) return "";
  return [
    "## Available skills",
    "",
    `The following agent skills are installed in this workspace under \`${SKILLS_INSTALL_DIR}/\`. ` +
      "Only their names and descriptions are shown — the full instructions are not loaded yet. " +
      `When a task matches a skill, read \`${SKILLS_INSTALL_DIR}/<name>/SKILL.md\` with the \`files_read\` tool ` +
      "for its full instructions, then read any files it references in that directory with `files_read` or `bash`.",
    "",
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join("\n");
}

/**
 * Install agent skills into the sandbox with Vercel's `skills` CLI, sourcing
 * from local directories (never the network). Each skill is staged under
 * `<staging>/skills/<name>` (the collection layout the CLI expects), then
 * `skills add` copies it into the workspace's `.claude/skills/`. Returns the
 * discovered registry (name+description+dir) used for progressive disclosure.
 * A no-op that returns `[]` when no skills are requested.
 */
export async function installSkills(
  sandbox: DockerSandbox,
  sources: readonly SkillSource[],
): Promise<SkillEntry[]> {
  if (sources.length === 0) return [];

  // Stage every requested skill under <staging>/skills/<name>, mirroring the
  // collection layout `skills add <dir>` expects from a local source.
  await sandbox.runShellAsRoot(
    `rm -rf ${SKILLS_STAGING_DIR} && mkdir -p ${SKILLS_STAGING_DIR}/skills`,
  );
  for (const source of sources) {
    await sandbox.copyToContainer(
      source.dir,
      `${SKILLS_STAGING_DIR}/skills/${source.name}`,
    );
  }

  // `skills add <dir>` installs to the cwd's project scope, and runShell's cwd
  // is the workspace, so skills land in <workspace>/<agent dirs>/. --copy (not
  // symlink) keeps the workspace self-contained once staging is gone; --skill
  // '*' installs all staged skills; --yes is non-interactive.
  //
  // TODO: install only for the agent the experiment uses (--agent claude-code,
  // codex, gemini-cli, …) once that is threaded through. We only run models via
  // the AI SDK today, so for now we install for all agents and read claude-code's
  // .claude/skills scope (SKILLS_INSTALL_DIR).
  const install = await sandbox.runShell(
    `skills add ${SKILLS_STAGING_DIR} --skill '*' --copy --yes`,
  );
  if (!install.ok) {
    throw new Error(
      `failed to install skills with the skills CLI: ${install.stderr || install.stdout}`,
    );
  }

  // Confirm what landed and read each skill's description for the discovery
  // listing. The name is the install directory; only the description is read.
  const entries: SkillEntry[] = [];
  for (const source of sources) {
    const dir = `${SKILLS_INSTALL_DIR}/${source.name}`;
    const skillPath = `${dir}/SKILL.md`;
    if (!(await sandbox.fileExists(skillPath))) {
      throw new Error(
        `skills CLI did not install "${source.name}" (no ${skillPath} in the sandbox)`,
      );
    }
    entries.push({
      name: source.name,
      description: frontmatterDescription(await sandbox.readFile(skillPath)),
      dir,
    });
  }
  return entries;
}

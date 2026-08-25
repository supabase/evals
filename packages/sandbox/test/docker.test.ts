/**
 * Integration test for the local-stack sandbox plumbing. Requires a running Docker
 * daemon, free Supabase default host ports (54321-54329), and network access
 * for image pulls on first run. Gated behind SANDBOX_DOCKER_TESTS=1; run with:
 *
 *   pnpm --filter @supabase-evals/sandbox test:docker
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildLocalStackScoringContext } from '../src/local-stack-runtime.js';
import { DockerSandbox } from '../src/docker-sandbox.js';
import {
  ensureSupabaseSandboxImage,
  setupSupabaseSandbox,
  startSupabaseProject,
  SUPABASE_CLI_VERSION,
  teardownSupabaseProject,
} from '../src/supabase.js';
import {
  installSkills,
  SKILLS_INSTALL_DIR,
  SKILLS_INSTALL_DIRS,
} from '../src/skills.js';

const TEST_TIMEOUT_MS = 600_000;

describe.runIf(process.env.SANDBOX_DOCKER_TESTS)(
  'local-stack sandbox (docker)',
  () => {
    it(
      'boots a sandbox, starts a minimal local stack, and reaches it',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const image = await ensureSupabaseSandboxImage();
        const sandbox = await DockerSandbox.create({
          image,
          network: 'host',
        });
        try {
          // The default (projectRunning: true) must refuse an empty workspace
          // with an authoring error instead of a confusing CLI failure.
          await expect(setupSupabaseSandbox(sandbox, {})).rejects.toThrow(
            /supabase\/config\.toml/
          );

          // projectRunning: false — this test inits the project itself below,
          // mirroring scenarios where starting the stack is the agent's task.
          // gotrue is included because `supabase status` only reports the API
          // keys getClient needs while the auth service is running.
          await setupSupabaseSandbox(sandbox, {
            includeServices: ['gotrue', 'kong', 'postgrest'],
            projectRunning: false,
          });

          const version = await sandbox.runShell('supabase --version');
          expect(version.ok).toBe(true);
          expect(version.stdout.trim()).toBe(SUPABASE_CLI_VERSION);

          // Workspace file roundtrip (host staging -> docker cp -> container).
          await sandbox.writeFiles({ 'nested/dir/hello.txt': 'roundtrip' });
          expect(await sandbox.readFile('nested/dir/hello.txt')).toBe(
            'roundtrip'
          );

          // copyToContainer seeds straight from disk: binary content survives
          // intact and the ignore list (.git here) is dropped.
          const seed = mkdtempSync(join(tmpdir(), 'copyhostdir-test-'));
          try {
            writeFileSync(
              join(seed, 'bin.dat'),
              Buffer.from([0x00, 0xff, 0x00, 0xfe])
            );
            mkdirSync(join(seed, '.git'));
            writeFileSync(join(seed, '.git', 'HEAD'), 'ref');
            await sandbox.copyToContainer(seed, sandbox.workdir);
            // Dump the bytes as hex (od, from coreutils) to confirm the copy is byte-exact.
            const hex = await sandbox.runShell(
              "od -An -v -tx1 bin.dat | tr -d ' \\n'"
            );
            expect(hex.stdout.trim()).toBe('00ff00fe');
            expect(await sandbox.fileExists('.git/HEAD')).toBe(false);
          } finally {
            rmSync(seed, { recursive: true, force: true });
          }

          // Headless init must not hang on its interactive prompts.
          const init = await sandbox.runShell('supabase init');
          expect(init.ok, init.stderr).toBe(true);
          expect(await sandbox.fileExists('supabase/config.toml')).toBe(true);

          await startSupabaseProject(sandbox, ['gotrue', 'kong', 'postgrest']);

          // Postgres reachable on the sandbox's 127.0.0.1 (host networking), structured rows back.
          const ctx = buildLocalStackScoringContext(sandbox);
          const { rows } = await ctx.query('select 1 as one');
          expect(rows).toEqual([{ one: 1 }]);

          // Kong reachable on the default API port (any HTTP status proves it).
          const rest = await ctx.exec(
            "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:54321/rest/v1/"
          );
          expect(rest.stdout.trim()).not.toBe('000');
          expect(rest.stdout.trim()).not.toBe('');

          // getClient reaches the stack host-side via the published ports: a
          // PostgREST error response (unknown table) proves the full path.
          const client = await ctx.getClient();
          const { error } = await client.from('nonexistent_table').select('*');
          expect(error).not.toBeNull();
        } finally {
          await teardownSupabaseProject(sandbox);
          await sandbox.stop();
        }
      }
    );

    it(
      "skipCliInstall leaves the CLI absent, and the wrapper doesn't crash setup",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const image = await ensureSupabaseSandboxImage();
        const sandbox = await DockerSandbox.create({ image, network: 'host' });
        try {
          await setupSupabaseSandbox(sandbox, {
            projectRunning: false,
            skipCliInstall: true,
          });

          const version = await sandbox.runShell('supabase --version');
          expect(version.ok).toBe(false);

          // The agent installs it itself; the harness never touched the CLI.
          const install = await sandbox.runShellAsRoot(
            `ARCH="$(dpkg --print-architecture)" && ` +
              `curl -fsSL "https://github.com/supabase/cli/releases/download/v${SUPABASE_CLI_VERSION}/supabase_${SUPABASE_CLI_VERSION}_linux_$ARCH.deb" -o /tmp/supabase.deb && ` +
              `dpkg -i /tmp/supabase.deb && rm /tmp/supabase.deb`
          );
          expect(install.ok).toBe(true);

          const versionAfter = await sandbox.runShell('supabase --version');
          expect(versionAfter.ok).toBe(true);
          expect(versionAfter.stdout.trim()).toBe(SUPABASE_CLI_VERSION);
        } finally {
          await sandbox.stop();
        }
      }
    );

    it(
      'npm install -g lands on PATH without sudo/workarounds',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const image = await ensureSupabaseSandboxImage();
        const sandbox = await DockerSandbox.create({ image, network: 'host' });
        try {
          const install = await sandbox.runShell(
            'npm install -g supabase 2>&1'
          );
          expect(install.ok).toBe(true);

          const version = await sandbox.runShell('supabase --version');
          expect(version.ok).toBe(true);
        } finally {
          await sandbox.stop();
        }
      }
    );

    it(
      'installs a local skill into the workspace with the skills CLI',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const image = await ensureSupabaseSandboxImage();
        const sandbox = await DockerSandbox.create({ image });
        // A minimal on-disk skill fixture (name+description frontmatter plus a
        // bundled reference file) installed from a local dir — never the network.
        const src = mkdtempSync(join(tmpdir(), 'skill-src-'));
        try {
          mkdirSync(join(src, 'references'), { recursive: true });
          writeFileSync(
            join(src, 'SKILL.md'),
            [
              '---',
              'name: demo-skill',
              'description: A demo skill used in tests.',
              '---',
              '',
              '# Demo',
              'See references/extra.md.',
            ].join('\n')
          );
          writeFileSync(join(src, 'references', 'extra.md'), 'extra content');

          const entries = await installSkills(sandbox, [
            { name: 'demo-skill', dir: src },
          ]);

          expect(entries).toEqual([
            {
              name: 'demo-skill',
              description: 'A demo skill used in tests.',
              dir: `${SKILLS_INSTALL_DIR}/demo-skill`,
            },
          ]);
          // The full skill tree (including bundled references) lands in every
          // CLI harness's native project scope: .claude/skills for Claude Code,
          // .agents/skills for Codex and OpenCode.
          for (const installDir of SKILLS_INSTALL_DIRS) {
            expect(
              await sandbox.fileExists(`${installDir}/demo-skill/SKILL.md`)
            ).toBe(true);
            expect(
              await sandbox.readFile(
                `${installDir}/demo-skill/references/extra.md`
              )
            ).toBe('extra content');
          }
          // …and not in the scopes the no-`--agent` fallback would create. That
          // fallback installs for every agent the CLI knows, littering the
          // exported, scored workspace with ~52 stray roots. This is a sample of
          // them, not the whole set, so it catches the fallback firing rather
          // than proving nothing else was written.
          for (const stray of [
            '.aider-desk',
            '.factory',
            '.windsurf',
            'data',
            'skills',
          ]) {
            expect(await sandbox.folderExists(stray)).toBe(false);
          }
        } finally {
          rmSync(src, { recursive: true, force: true });
          await sandbox.stop();
        }
      }
    );
  }
);

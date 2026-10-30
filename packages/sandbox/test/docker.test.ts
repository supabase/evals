/**
 * Integration test for the local-stack sandbox plumbing. Requires a running Docker
 * daemon, free Supabase default host ports (54321-54329), and network access
 * for image pulls on first run. Gated behind SANDBOX_DOCKER_TESTS=1; run with:
 *
 *   pnpm --filter @supabase-evals/sandbox test:docker
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createAgentEnvironment } from '../src/agent-environment.js';
import {
  buildLocalStackScoringContext,
  localStackRuntime,
} from '../src/local-stack-runtime.js';
import {
  DockerSandbox,
  SANDBOX_CONTAINER_LABEL,
  SANDBOX_OWNER_LABEL,
  dockerCli,
} from '../src/docker-sandbox.js';
import {
  CLI_PROJECT_LABEL,
  removeStackResources,
} from '../src/stack-ownership.js';
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
      'container env reaches root, node, and login-shell commands',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const image = await ensureSupabaseSandboxImage();
        const sandbox = await DockerSandbox.create({
          image,
          env: { EVAL_FLAG: 'on' },
        });
        try {
          const probe = 'printf %s "$EVAL_FLAG"';
          const results = [
            await sandbox.runShell(probe),
            await sandbox.runShell(`bash -lc '${probe}'`),
            await sandbox.runShellAsRoot(probe),
          ];
          expect(results.map((result) => result.stdout)).toEqual([
            'on',
            'on',
            'on',
          ]);
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

    it(
      'a no-daemon sandbox root-owns the marker and both shims, and login shells resolve the shims',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        // Docker-less staging guards both projectRunning: false and no hosted
        // link, since the harness cannot pre-start a stack or link a hosted
        // project without Docker.
        const session = await localStackRuntime({
          docker: 'no-daemon',
        }).startSession({ agent: 'ai-sdk', projectRunning: false });
        try {
          const stat = await session.scoringContext.exec(
            'stat -c "%u:%g %a" /tmp/supabase-eval-runtime.json /usr/local/sbin/supabase /usr/local/sbin/docker'
          );
          expect(stat.ok, stat.stderr).toBe(true);
          expect(stat.stdout.trim().split('\n')).toEqual([
            '0:0 444',
            '0:0 755',
            '0:0 755',
          ]);

          const login = await session.scoringContext.exec(
            "bash -lc 'command -v supabase docker'"
          );
          expect(login.stdout.trim().split('\n')).toEqual([
            '/usr/local/sbin/supabase',
            '/usr/local/sbin/docker',
          ]);

          const write = await session.scoringContext.exec(
            'echo forged > /tmp/supabase-eval-runtime.json'
          );
          expect(write.ok).toBe(false);
          expect(write.stderr).toMatch(/permission denied/i);
        } finally {
          await session.close();
        }
      }
    );

    it(
      'environmentMarker ignores a cat shadowed onto the front of the agent PATH',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const session = await localStackRuntime({
          docker: 'no-daemon',
        }).startSession({ agent: 'ai-sdk', projectRunning: false });
        try {
          // /home/node/.npm-global/bin is first on SANDBOX_PATH and writable
          // by the agent, so a shell-based read could be fed forged JSON.
          const forged =
            '{"runtime":"local-stack","cliVersion":"0.0.0",' +
            '"docker":"available","sessionStartedMs":0}';
          const shim = ['#!/bin/sh', `echo '${forged}'`, ''].join('\n');
          const encoded = Buffer.from(shim, 'utf-8').toString('base64');

          const shadow = await session.scoringContext.exec(
            'mkdir -p /home/node/.npm-global/bin && ' +
              `echo ${encoded} | base64 -d > /home/node/.npm-global/bin/cat && ` +
              'chmod 755 /home/node/.npm-global/bin/cat'
          );
          expect(shadow.ok, shadow.stderr).toBe(true);

          const shadowed = await session.scoringContext.exec('cat /dev/null');
          expect(shadowed.stdout).toContain('"docker":"available"');

          const marker = await session.scoringContext.environmentMarker();
          expect(marker?.docker).toBe('no-daemon');
          expect(marker?.cliVersion).not.toBe('0.0.0');
        } finally {
          await session.close();
        }
      }
    );

    describe('each session starts from a fresh database', () => {
      // A fixture project id without the `sandbox-` prefix, like most eval
      // fixtures, on its own ports so it can't collide with other stacks.
      const projectId = `evals-fresh-db-${randomUUID().slice(0, 8)}`;
      const fixture = mkdtempSync(join(tmpdir(), 'fresh-db-fixture-'));
      mkdirSync(join(fixture, 'supabase', 'migrations'), { recursive: true });
      writeFileSync(
        join(fixture, 'supabase', 'config.toml'),
        [
          `project_id = "${projectId}"`,
          '[api]',
          'port = 55621',
          '[db]',
          'port = 55622',
          'shadow_port = 55620',
          '[studio]',
          'port = 55623',
          '[inbucket]',
          'port = 55624',
          '[analytics]',
          'port = 55627',
          '',
        ].join('\n')
      );
      writeFileSync(
        join(fixture, 'supabase', 'migrations', '20260101000000_seed.sql'),
        'create table public.seeded (id int);\n'
      );
      const agentMigration = '20260102000000';

      afterAll(async () => {
        await removeStackResources(projectId);
        rmSync(fixture, { recursive: true, force: true });
      });

      async function stackVolumes(): Promise<string[]> {
        const listed = await dockerCli([
          'volume',
          'ls',
          '-q',
          '--filter',
          `label=${CLI_PROJECT_LABEL}=${projectId}`,
        ]);
        return listed.stdout.split('\n').filter(Boolean);
      }

      /** Boot a session on the fixture, as the local-stack runtime does. */
      async function startRun() {
        const env = await createAgentEnvironment({
          localDir: fixture,
          localStack: { includeServices: [] },
        });
        return {
          sandbox: env.sandbox,
          close: async () => {
            await teardownSupabaseProject(env.sandbox);
            await env.close();
          },
        };
      }

      /** What an agent leaves behind: an applied migration and a new table. */
      async function changeDatabase(sandbox: DockerSandbox): Promise<void> {
        await sandbox.writeFiles({
          [`supabase/migrations/${agentMigration}_agent.sql`]:
            'create table public.agent_change (id int);\n',
        });
        const up = await sandbox.runShell('supabase migration up --local');
        expect(up.ok, up.stderr).toBe(true);
      }

      async function expectFreshDatabase(
        sandbox: DockerSandbox
      ): Promise<void> {
        const { rows } = await buildLocalStackScoringContext(sandbox).query(
          "select to_regclass('public.seeded')::text as seeded, to_regclass('public.agent_change')::text as agent_change"
        );
        expect(rows).toEqual([{ seeded: 'seeded', agent_change: null }]);
        const history = await sandbox.runShell(
          'supabase migration list --local'
        );
        expect(history.ok, history.stderr).toBe(true);
        expect(history.stdout).toContain('20260101000000');
        expect(history.stdout).not.toContain(agentMigration);
      }

      it(
        'after a torn-down run and after a run killed before teardown',
        { timeout: TEST_TIMEOUT_MS },
        async () => {
          const first = await startRun();
          try {
            await changeDatabase(first.sandbox);
          } finally {
            await first.close();
          }
          // `supabase stop --no-backup` alone leaves the volume (CLI-2637).
          expect(await stackVolumes()).toEqual([]);

          const second = await startRun();
          await expectFreshDatabase(second.sandbox);
          await changeDatabase(second.sandbox);
          // Killed before teardown (e.g. Ctrl-C): the stack leaks...
          await second.sandbox.stop();
          expect(await stackVolumes()).not.toEqual([]);

          // ...and the next run claiming the project id clears it first.
          const third = await startRun();
          try {
            await expectFreshDatabase(third.sandbox);
          } finally {
            await third.close();
          }
          expect(await stackVolumes()).toEqual([]);
        }
      );

      it(
        "leaves another live run's sandbox alone, and removes a dead run's",
        { timeout: TEST_TIMEOUT_MS },
        async () => {
          const image = await ensureSupabaseSandboxImage();
          // A sibling run's sandbox: owned by this (live) process.
          const sibling = await DockerSandbox.create({ image });
          // A crashed run's sandbox: owned by a process that has exited.
          const deadPid = spawnSync('true').pid;
          const orphan = await dockerCli([
            'run',
            '--detach',
            '--label',
            `${SANDBOX_CONTAINER_LABEL}=1`,
            '--label',
            `${SANDBOX_OWNER_LABEL}=${hostname()}:${deadPid}`,
            image,
            'sleep',
            'infinity',
          ]);
          expect(orphan.ok, orphan.stderr).toBe(true);
          const orphanId = orphan.stdout.trim();
          const exists = async (id: string) =>
            (await dockerCli(['inspect', id])).ok;
          try {
            const run = await startRun();
            await run.close();

            expect(await exists(orphanId)).toBe(false);
            expect(await exists(sibling.id)).toBe(true);
            const alive = await sibling.runShell('echo alive');
            expect(alive.stdout.trim()).toBe('alive');
          } finally {
            await sibling.stop();
            await dockerCli(['rm', '-f', orphanId]);
          }
        }
      );

      it(
        "refuses to start on a stack it didn't create, and leaves it alone",
        { timeout: TEST_TIMEOUT_MS },
        async () => {
          // Stands in for a developer's own stack under the same project id.
          const volume = `supabase_db_${projectId}`;
          const created = await dockerCli([
            'volume',
            'create',
            '--label',
            `${CLI_PROJECT_LABEL}=${projectId}`,
            volume,
          ]);
          expect(created.ok, created.stderr).toBe(true);

          await expect(startRun()).rejects.toThrow(
            /no record of starting them/
          );
          expect(await stackVolumes()).toEqual([volume]);
        }
      );
    });
  }
);

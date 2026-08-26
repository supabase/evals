import { readFileSync } from 'node:fs';
import { parseEvalMarkdown } from '@supabase-evals/core/eval-markdown';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildToolSurfaceAddendum,
  resolveSandboxPath,
  truncateOutput,
  wrapSelectAsJson,
} from '../src/local-stack-runtime.js';
import {
  SANDBOX_DOCKERFILE_PATH,
  SUPABASE_CLI_VERSION,
  buildServiceWrapperScript,
  buildSupabaseStartCommand,
  computeExcludedServices,
  startSupabaseProject,
} from '../src/supabase.js';
import type { DockerSandbox } from '../src/docker-sandbox.js';
import {
  SKILLS_CLI_VERSION,
  SKILLS_INSTALL_AGENTS,
  SKILLS_INSTALL_DIR,
  SKILLS_INSTALL_DIRS,
  buildSkillsAddCommand,
  buildSkillsPrompt,
  frontmatterDescription,
  installSkills,
} from '../src/skills.js';
import { ALL_SUPABASE_SERVICES } from '../src/types.js';

describe('sandbox Dockerfile', () => {
  it('is a CLI-free base image carrying the common agent tooling', () => {
    const dockerfile = readFileSync(SANDBOX_DOCKERFILE_PATH, 'utf8');
    expect(dockerfile).toContain('FROM node:22-slim');
    // Common tooling shared by both eval modes.
    expect(dockerfile).toContain('postgresql-client');
    expect(dockerfile).toContain('docker.io');
    // The Supabase CLI is NOT baked in — it's a local-stack component installed
    // at setup time (installSupabaseCli), so tools-mode sandboxes genuinely lack
    // it. The base image is therefore shared across modes and CLI versions.
    expect(dockerfile).not.toContain('ARG CLI_VERSION');
    expect(dockerfile).not.toContain('supabase.deb');
  });

  it("bakes in Vercel's skills CLI pinned via build arg", () => {
    const dockerfile = readFileSync(SANDBOX_DOCKERFILE_PATH, 'utf8');
    expect(dockerfile).toContain('ARG SKILLS_CLI_VERSION');
    expect(dockerfile).toContain(
      'npm install -g "skills@${SKILLS_CLI_VERSION}"'
    );
  });

  it('pins the Supabase CLI version installed at setup time', () => {
    // The pin moved out of the Dockerfile into installSupabaseCli.
    expect(SUPABASE_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('frontmatterDescription', () => {
  it('reads a quoted description containing colons', () => {
    const md = [
      '---',
      'name: supabase',
      'description: "Use when doing X. Triggers: a, b, c."',
      'metadata:',
      '  author: supabase',
      '---',
      '',
      '# Body',
    ].join('\n');
    expect(frontmatterDescription(md)).toBe(
      'Use when doing X. Triggers: a, b, c.'
    );
  });

  it('reads an unquoted single-line description', () => {
    expect(
      frontmatterDescription(
        '---\nname: pg\ndescription: Postgres tips.\n---\nbody'
      )
    ).toBe('Postgres tips.');
  });

  it('returns empty without frontmatter or without a description', () => {
    expect(frontmatterDescription('# Just a body')).toBe('');
    expect(frontmatterDescription('---\nname: solo\n---\nbody')).toBe('');
  });
});

describe('buildSkillsPrompt', () => {
  const entries = [
    { name: 'supabase', description: 'Use for Supabase tasks.', dir: 'x' },
    { name: 'pg', description: 'Postgres tips.', dir: 'y' },
  ];

  it('is empty when no skills are installed', () => {
    expect(buildSkillsPrompt('ai-sdk', [])).toBe('');
  });

  it('lists name+description and points at the install dir for files_read', () => {
    const prompt = buildSkillsPrompt('ai-sdk', entries);
    expect(prompt).toContain(SKILLS_INSTALL_DIR);
    expect(prompt).toContain('files_read');
    expect(prompt).toContain('SKILL.md');
    expect(prompt).toContain('- supabase: Use for Supabase tasks.');
    expect(prompt).toContain('- pg: Postgres tips.');
    // Discovery only — the full body must not be inlined here.
    expect(prompt).not.toContain('# Body');
  });

  it('is empty for every CLI agent — each discovers its own skills natively', () => {
    // The skills CLI installs into .claude/skills and .agents/skills, which
    // Claude Code, Codex and OpenCode each walk themselves; they then advertise
    // the skills in their own words, with their own loader. Injecting our
    // listing would duplicate theirs and name `files_read`, an ai-sdk-only tool.
    for (const agent of ['claude-code', 'codex', 'opencode'] as const) {
      expect(buildSkillsPrompt(agent, entries)).toBe('');
      expect(buildSkillsPrompt(agent, [])).toBe('');
    }
  });
});

describe('buildSkillsAddCommand', () => {
  it('installs for all three CLI harnesses, source before the variadic --agent', () => {
    const command = buildSkillsAddCommand('/tmp/staging');
    expect(command).toBe(
      "skills add '/tmp/staging' --agent claude-code codex opencode --skill '*' --copy --yes"
    );
    // --agent is variadic: it eats every following non-flag token. The source
    // dir must precede it (otherwise the CLI fails with "Missing required
    // argument: source") and a flag must terminate the agent list.
    expect(command.indexOf('/tmp/staging')).toBeLessThan(
      command.indexOf('--agent')
    );
    expect(command).toMatch(/--agent (?:[a-z-]+ )+--skill/);
  });

  it('names the agents explicitly rather than letting the CLI guess', () => {
    // With no --agent the CLI falls back to all ~71 agents it knows, littering
    // the exported workspace; the fallback is also install-order dependent.
    expect(SKILLS_INSTALL_AGENTS).toEqual(['claude-code', 'codex', 'opencode']);
    expect(buildSkillsAddCommand()).toContain('--agent');
  });
});

describe('installSkills', () => {
  /** A DockerSandbox stub that records shell commands and fakes the install. */
  function fakeSandbox(present: readonly string[]) {
    const commands: string[] = [];
    return {
      commands,
      sandbox: {
        runShellAsRoot: async (command: string) => {
          commands.push(command);
          return { ok: true, exitCode: 0, stdout: '', stderr: '' };
        },
        runShell: async (command: string) => {
          commands.push(command);
          return { ok: true, exitCode: 0, stdout: '', stderr: '' };
        },
        copyToContainer: async () => {},
        fileExists: async (path: string) => present.includes(path),
        readFile: async () => '---\ndescription: Demo skill.\n---\nbody',
      } as unknown as DockerSandbox,
    };
  }

  const installedEverywhere = SKILLS_INSTALL_DIRS.map(
    (dir) => `${dir}/demo/SKILL.md`
  );

  it('is a no-op with no skills requested', async () => {
    const { sandbox, commands } = fakeSandbox([]);
    expect(await installSkills(sandbox, [])).toEqual([]);
    expect(commands).toEqual([]);
  });

  it('runs the per-agent install and reports the .claude/skills tree', async () => {
    const { sandbox, commands } = fakeSandbox(installedEverywhere);
    const entries = await installSkills(sandbox, [
      { name: 'demo', dir: '/host/demo' },
    ]);
    expect(entries).toEqual([
      {
        name: 'demo',
        description: 'Demo skill.',
        dir: `${SKILLS_INSTALL_DIR}/demo`,
      },
    ]);
    expect(commands).toContain(buildSkillsAddCommand());
  });

  it('installs into both .claude/skills and .agents/skills', () => {
    // .claude/skills is Claude Code's project scope; .agents/skills is Codex's
    // and OpenCode's. Codex does not read .claude/skills at all.
    expect(SKILLS_INSTALL_DIRS).toEqual(['.claude/skills', '.agents/skills']);
    expect(SKILLS_INSTALL_DIR).toBe('.claude/skills');
  });

  it('throws when a skill is missing from any agent scope', async () => {
    for (const missing of SKILLS_INSTALL_DIRS) {
      const { sandbox } = fakeSandbox(
        installedEverywhere.filter((p) => !p.startsWith(`${missing}/`))
      );
      await expect(
        installSkills(sandbox, [{ name: 'demo', dir: '/host/demo' }])
      ).rejects.toThrow(`no ${missing}/demo/SKILL.md`);
    }
  });
});

describe('buildToolSurfaceAddendum', () => {
  it('describes the in-process tool surface for the ai-sdk agent', () => {
    const addendum = buildToolSurfaceAddendum('ai-sdk');
    // These are the tools buildLocalStackTools actually provides.
    expect(addendum).toContain('bash tool');
    expect(addendum).toContain('files tools');
    expect(addendum).toContain('The Supabase CLI (`supabase`)');
    expect(addendum).toContain('supabase start');
  });

  it('drops the CLI sentence when the agent installs the CLI itself', () => {
    const addendum = buildToolSurfaceAddendum('ai-sdk', {
      skipCliInstall: true,
    });
    expect(addendum).not.toContain('The Supabase CLI (`supabase`)');
    expect(addendum).not.toContain('supabase start');
    expect(addendum).toContain('docker, psql, git, and curl');
  });

  it('is empty for every CLI agent — they never see these tools', () => {
    // createCliAgent ignores `args.tools`, so a CLI agent works the workspace
    // with its own built-in tools; naming ours would describe tools it lacks.
    for (const agent of ['claude-code', 'codex', 'opencode'] as const) {
      expect(buildToolSurfaceAddendum(agent)).toBe('');
      expect(buildToolSurfaceAddendum(agent, { skipCliInstall: true })).toBe(
        ''
      );
    }
  });
});

describe('SKILLS_CLI_VERSION', () => {
  it('is a pinned semver string', () => {
    expect(SKILLS_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('buildServiceWrapperScript', () => {
  it('appends the exclude flag to start and passes other commands through', () => {
    const script = buildServiceWrapperScript('/usr/bin/supabase', [
      'studio',
      'realtime',
    ]);
    expect(script).toContain('if [ "$1" = "start" ]; then');
    expect(script).toContain('start "$@" -x studio,realtime');
    expect(script).toContain('exec "$REAL" "$@"');
    expect(script).not.toContain('--db-url');
  });

  it('execs the real binary by its absolute path (shadows by PATH, no rename)', () => {
    const script = buildServiceWrapperScript('/usr/bin/supabase', []);
    expect(script).toContain('REAL="/usr/bin/supabase"');
    expect(script).not.toContain('supabase-cli');
  });

  it('injects --db-url for linked DB commands when a pooler-url path is given', () => {
    const script = buildServiceWrapperScript(
      '/usr/bin/supabase',
      [],
      '/work/supabase/.temp/pooler-url'
    );
    expect(script).toContain(
      'POOLER_URL_FILE="/work/supabase/.temp/pooler-url"'
    );
    expect(script).toContain(
      '"db push"|"db pull"|"db dump"|"migration repair"|"migration list")'
    );
    expect(script).toContain('--db-url "$(cat "$POOLER_URL_FILE")"');
    expect(script).not.toContain('-x ');
  });

  it('forces the native DNS resolver on link when a hosted platform is present', () => {
    const script = buildServiceWrapperScript(
      '/usr/bin/supabase',
      [],
      undefined,
      true
    );
    expect(script).toContain('if [ "$1" = "link" ]');
    expect(script).toContain('!= *" --dns-resolver "*');
    expect(script).toContain('link "$@" --dns-resolver native');
  });

  it('leaves link untouched when there is no hosted platform', () => {
    const script = buildServiceWrapperScript(
      '/usr/bin/supabase',
      [],
      '/work/supabase/.temp/pooler-url'
    );
    expect(script).not.toContain('--dns-resolver');
    expect(script).not.toContain('"$1" = "link"');
  });
});

describe('buildSupabaseStartCommand', () => {
  it('starts everything when no include list is given', () => {
    expect(buildSupabaseStartCommand(undefined)).toBe('supabase start');
  });

  it('excludes every optional service for an empty list (database only)', () => {
    const command = buildSupabaseStartCommand([]);
    expect(command).toBe(
      `supabase start -x ${ALL_SUPABASE_SERVICES.join(',')}`
    );
  });

  it('excludes every service not in the include list', () => {
    const command = buildSupabaseStartCommand(['kong', 'postgrest']);
    expect(command.startsWith('supabase start -x ')).toBe(true);
    const excluded = command.replace('supabase start -x ', '').split(',');
    expect(excluded).not.toContain('kong');
    expect(excluded).not.toContain('postgrest');
    expect(excluded).toHaveLength(ALL_SUPABASE_SERVICES.length - 2);
  });
});

describe('startSupabaseProject retries', () => {
  const ok = { ok: true, exitCode: 0, stdout: '', stderr: '' };
  const pullLimited = {
    ok: false,
    exitCode: 1,
    stdout: '',
    stderr:
      'failed to pull docker image: Error response from daemon: toomanyrequests: Rate exceeded',
  };
  // A local-stack boot timeout: coreutils `timeout` exits 124 (TERM) or 137
  // (KILL escalation). Points at a wedged service, not a registry blip.
  const bootTimeout = {
    ok: false,
    exitCode: 124,
    stdout: '',
    stderr: 'starting...\n[command timed out after 600s and was terminated]',
  };

  /**
   * A sandbox whose `supabase start` returns `startResult` for the first
   * `failures` starts, then succeeds. `failures` of Infinity fails forever.
   */
  function fakeSandbox(failures: number, startResult = pullLimited) {
    const commands: string[] = [];
    const sandbox = {
      runShell: async (command: string) => {
        commands.push(command);
        if (!command.startsWith('supabase start')) return ok;
        const startsSoFar = commands.filter((c) =>
          c.startsWith('supabase start')
        ).length;
        return startsSoFar <= failures ? startResult : ok;
      },
    } as unknown as DockerSandbox;
    return { sandbox, commands };
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns without retrying when the first start succeeds', async () => {
    const { sandbox, commands } = fakeSandbox(0);
    await startSupabaseProject(sandbox);
    expect(commands).toEqual(['supabase start']);
  });

  it('stops the partial stack and retries on a transient pull failure', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sandbox, commands } = fakeSandbox(1);

    const started = startSupabaseProject(sandbox);
    await vi.runAllTimersAsync();
    await started;

    expect(commands).toEqual([
      'supabase start',
      'supabase stop --no-backup',
      'supabase start',
    ]);
  });

  it('throws the original error once the backoff schedule is exhausted', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sandbox, commands } = fakeSandbox(Number.POSITIVE_INFINITY);

    const started = startSupabaseProject(sandbox);
    // Surface the rejection before asserting so the timer loop can't race it.
    const outcome = started.catch((err: unknown) => err);
    await vi.runAllTimersAsync();
    const err = await outcome;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('[supabase start] failed:');
    expect((err as Error).message).toContain('toomanyrequests');
    // 1 initial + 3 retries, with a stop between each pair of starts.
    expect(commands.filter((c) => c.startsWith('supabase start'))).toHaveLength(
      4
    );
    expect(
      commands.filter((c) => c === 'supabase stop --no-backup')
    ).toHaveLength(3);
  });

  it('does not retry a local-stack boot timeout', async () => {
    const { sandbox, commands } = fakeSandbox(
      Number.POSITIVE_INFINITY,
      bootTimeout
    );

    await expect(startSupabaseProject(sandbox)).rejects.toThrow(
      '[supabase start] failed:'
    );
    // A timeout means a service is wedged; re-running would waste the full
    // boot timeout again, so it fails after the very first attempt with no
    // stop/retry in between.
    expect(commands).toEqual(['supabase start']);
  });
});

describe('computeExcludedServices', () => {
  it('inverts the include list preserving canonical order', () => {
    const excluded = computeExcludedServices(['gotrue', 'kong', 'postgrest']);
    expect(excluded).toEqual(
      ALL_SUPABASE_SERVICES.filter(
        (service) => !['gotrue', 'kong', 'postgrest'].includes(service)
      )
    );
  });

  it('returns empty when everything is included', () => {
    expect(computeExcludedServices(ALL_SUPABASE_SERVICES)).toEqual([]);
  });

  it('excludes nothing when omitted, but everything for an explicit empty list', () => {
    expect(computeExcludedServices(undefined)).toEqual([]);
    expect(computeExcludedServices([])).toEqual([...ALL_SUPABASE_SERVICES]);
  });

  it('rejects unknown services with the valid list in the message', () => {
    expect(() => computeExcludedServices(['auth'])).toThrowError(
      /invalid Supabase services: auth \(valid: gotrue/
    );
  });
});

describe('services frontmatter → computeExcludedServices (regression)', () => {
  // Frontmatter token normalization folds underscores to hyphens for the enum
  // dimensions (product/topic), but the same normalizer must NOT touch
  // `services` — those are real CLI service ids (postgres-meta, storage-api,
  // edge-runtime) that must match the Supabase service names verbatim:
  // https://github.com/supabase/supabase/blob/d71717585e1b0fcadcdc03546211a7bfbdbe0959/apps/docs/spec/cli_v1_commands.yaml#L584
  const buildMarkdown = (services: string) =>
    [
      '---',
      'stage: build',
      'suite: regression',
      'interface: cli',
      'product: [database]',
      'topic: [migrations]',
      `services: ${services}`,
      '---',
      'body',
    ].join('\n');

  it('preserves hyphens so parsed services match the Supabase service names', () => {
    const { metadata } = parseEvalMarkdown(
      buildMarkdown('[postgres-meta, storage-api, edge-runtime, gotrue]')
    );

    // Folding to postgres_meta / storage_api / edge_runtime would break the
    // match in computeExcludedServices and throw at sandbox startup.
    expect(metadata.services).toEqual([
      'postgres-meta',
      'storage-api',
      'edge-runtime',
      'gotrue',
    ]);

    expect(() => computeExcludedServices(metadata.services)).not.toThrow();
    const excluded = computeExcludedServices(metadata.services);
    expect(excluded).not.toContain('postgres-meta');
    expect(excluded).not.toContain('storage-api');
    expect(excluded).not.toContain('edge-runtime');
    expect(excluded).not.toContain('gotrue');
  });

  it('still trims and lowercases hyphenated service ids', () => {
    const { metadata } = parseEvalMarkdown(
      buildMarkdown("[' Postgres-Meta ']")
    );
    expect(metadata.services).toEqual(['postgres-meta']);
  });
});

describe('interface frontmatter', () => {
  const buildMarkdown = (interfaceLine: string) =>
    [
      '---',
      'stage: resolve',
      'suite: regression',
      interfaceLine,
      'product: database',
      'topic: migrations',
      '---',
      'Fix it.',
    ]
      .filter(Boolean)
      .join('\n');

  it('parses each supported interface', () => {
    expect(
      parseEvalMarkdown(buildMarkdown('interface: cli')).metadata.interface
    ).toBe('cli');
    expect(
      parseEvalMarkdown(buildMarkdown('interface: mcp')).metadata.interface
    ).toBe('mcp');
  });

  it('rejects a scenario with no interface, naming the source file', () => {
    expect(() =>
      parseEvalMarkdown(buildMarkdown(''), 'evals/some-scenario/PROMPT.md')
    ).toThrow(/evals\/some-scenario\/PROMPT\.md.*interface/s);
  });

  it('rejects an unknown interface', () => {
    expect(() => parseEvalMarkdown(buildMarkdown('interface: rest'))).toThrow(
      /interface/
    );
  });
});

describe('cliVersion frontmatter', () => {
  it('accepts a pinned semantic version', () => {
    const { metadata } = parseEvalMarkdown(
      [
        '---',
        'stage: resolve',
        'suite: regression',
        'interface: cli',
        'cliVersion: 2.109.1',
        'product: database',
        'topic: migrations',
        '---',
        'Fix it.',
      ].join('\n')
    );

    expect(metadata.cliVersion).toBe('2.109.1');
  });

  it('rejects a non-semver CLI version', () => {
    expect(() =>
      parseEvalMarkdown(
        [
          '---',
          'stage: resolve',
          'suite: regression',
          'interface: cli',
          'cliVersion: latest',
          'product: database',
          'topic: migrations',
          '---',
          'Fix it.',
        ].join('\n')
      )
    ).toThrow();
  });
});

describe('skills frontmatter', () => {
  const buildMarkdown = (extra: string) =>
    [
      '---',
      'stage: build',
      'suite: regression',
      'interface: cli',
      'product: [database]',
      'topic: [sdk]',
      extra,
      '---',
      'body',
    ].join('\n');

  it('preserves hyphenated skill directory names', () => {
    const { metadata } = parseEvalMarkdown(
      buildMarkdown('skills: [supabase, supabase-postgres-best-practices]')
    );
    expect(metadata.skills).toEqual([
      'supabase',
      'supabase-postgres-best-practices',
    ]);
  });

  it('parses an empty override distinctly from an omitted key', () => {
    const overridden = parseEvalMarkdown(buildMarkdown('skills: []'));
    expect(overridden.metadata.skills).toEqual([]);

    const omitted = parseEvalMarkdown(buildMarkdown(''));
    expect(omitted.metadata.skills).toBeUndefined();
  });
});

describe('skipCliInstall frontmatter', () => {
  const buildMarkdown = (extra: string) =>
    [
      '---',
      'stage: build',
      'suite: regression',
      'interface: cli',
      'product: [database]',
      'topic: [sdk]',
      extra,
      '---',
      'body',
    ].join('\n');

  it('accepts a real boolean and a quoted string form', () => {
    expect(
      parseEvalMarkdown(buildMarkdown('skipCliInstall: true')).metadata
        .skipCliInstall
    ).toBe(true);
    expect(
      parseEvalMarkdown(buildMarkdown('skipCliInstall: "true"')).metadata
        .skipCliInstall
    ).toBe(true);
  });

  it('defaults to undefined when omitted', () => {
    expect(
      parseEvalMarkdown(buildMarkdown('')).metadata.skipCliInstall
    ).toBeUndefined();
  });
});

describe('resolveSandboxPath', () => {
  it('accepts and normalizes relative paths', () => {
    expect(resolveSandboxPath('a/b.txt')).toBe('a/b.txt');
    expect(resolveSandboxPath('./a//b.txt')).toBe('a/b.txt');
    expect(resolveSandboxPath('a/../b.txt')).toBe('b.txt');
  });

  it('rejects absolute, empty, and escaping paths', () => {
    expect(() => resolveSandboxPath('/etc/passwd')).toThrowError(/relative/);
    expect(() => resolveSandboxPath('')).toThrowError(/relative/);
    expect(() => resolveSandboxPath('..')).toThrowError(/escapes/);
    expect(() => resolveSandboxPath('../x')).toThrowError(/escapes/);
    expect(() => resolveSandboxPath('a/../../x')).toThrowError(/escapes/);
  });
});

describe('truncateOutput', () => {
  it('passes short output through untouched', () => {
    expect(truncateOutput('hello')).toBe('hello');
  });

  it('keeps head and tail of oversized output with a marker', () => {
    const output = `${'a'.repeat(20_000)}TAIL`;
    const truncated = truncateOutput(output);
    expect(truncated.length).toBeLessThan(output.length);
    expect(truncated.startsWith('aaa')).toBe(true);
    expect(truncated.endsWith('TAIL')).toBe(true);
    expect(truncated).toContain('...[truncated');
  });
});

describe('wrapSelectAsJson', () => {
  it('wraps a SELECT in a json_agg subquery', () => {
    expect(wrapSelectAsJson('select 1 as one')).toBe(
      "select coalesce(json_agg(t), '[]'::json) from (select 1 as one) t;"
    );
  });

  it('strips a trailing semicolon so the subquery stays valid', () => {
    expect(wrapSelectAsJson('select 1 as one; ')).toBe(
      "select coalesce(json_agg(t), '[]'::json) from (select 1 as one) t;"
    );
  });
});

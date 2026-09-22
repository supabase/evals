import { describe, expect, it, vi } from 'vitest';
import {
  buildDockerDaemonShimScript,
  buildLocalStackScoringContext,
  buildSupabaseShimScript,
  localStackRuntime,
  resolveMcpServers,
} from '../src/local-stack-runtime.js';
import type { DockerSandbox } from '../src/docker-sandbox.js';
import type { SupabaseService } from '../src/types.js';

describe('localStackRuntime id', () => {
  it('ids as `local-stack` with no options', () => {
    expect(localStackRuntime().id).toBe('local-stack');
  });

  it('ids as `local-stack` when docker is explicitly the default', () => {
    expect(localStackRuntime({ docker: 'available' }).id).toBe('local-stack');
  });

  it('appends the docker state when it is non-default', () => {
    expect(localStackRuntime({ docker: 'no-daemon' }).id).toBe(
      'local-stack-no-daemon'
    );
    expect(localStackRuntime({ docker: 'absent' }).id).toBe(
      'local-stack-absent'
    );
  });

  it('appends the cliVersion option when set', () => {
    expect(localStackRuntime({ cliVersion: 'beta' }).id).toBe(
      'local-stack-beta'
    );
    expect(localStackRuntime({ cliVersion: '2.109.1' }).id).toBe(
      'local-stack-2.109.1'
    );
  });

  it('combines a non-default cliVersion and docker state', () => {
    expect(localStackRuntime({ cliVersion: 'beta', docker: 'absent' }).id).toBe(
      'local-stack-beta-absent'
    );
  });
});

describe('buildSupabaseShimScript', () => {
  it('emits DOCKER_HOST, the -x start branch for excluded services, and a passthrough exec', () => {
    const excluded: SupabaseService[] = ['gotrue', 'kong'];
    expect(buildSupabaseShimScript('/usr/bin/supabase', excluded)).toEqual(
      [
        '#!/bin/bash',
        'export DOCKER_HOST=tcp://127.0.0.1:1',
        "REAL='/usr/bin/supabase'",
        'if [ "$1" = "start" ]; then shift; exec "$REAL" start "$@" -x gotrue,kong; fi',
        'exec "$REAL" "$@"',
      ].join('\n')
    );
  });

  it('omits the start branch entirely when no services are excluded', () => {
    expect(
      buildSupabaseShimScript('/usr/bin/supabase', [])
    ).toMatchInlineSnapshot(`
      "#!/bin/bash
      export DOCKER_HOST=tcp://127.0.0.1:1
      REAL='/usr/bin/supabase'
      exec "$REAL" "$@""
    `);
  });

  it('always ends with exec "$REAL" "$@" regardless of exclusions', () => {
    const excluded: SupabaseService[] = ['gotrue', 'kong'];
    const script = buildSupabaseShimScript('/usr/bin/supabase', excluded);
    expect(script.endsWith('exec "$REAL" "$@"')).toBe(true);
  });

  it('single-quotes a realBin containing a single quote safely for the shell', () => {
    const script = buildSupabaseShimScript("/usr/local/it's/bin/supabase", []);
    expect(script).toContain(`REAL='/usr/local/it'\\''s/bin/supabase'`);
  });

  it('single-quotes a realBin containing $, backtick, and " safely for the shell', () => {
    const realBin = '/usr/local/$(whoami)/`id`/"bin"/supabase';
    const script = buildSupabaseShimScript(realBin, []);
    const realLine = script
      .split('\n')
      .find((line) => line.startsWith('REAL='));
    expect(realLine).toBe('REAL=\'/usr/local/$(whoami)/`id`/"bin"/supabase\'');
  });
});

describe('buildDockerDaemonShimScript', () => {
  const dockerVersion = 'Docker version 20.10.24+dfsg1, build 297e128';

  it('echoes the captured version string verbatim for --version/-v and exits 0, otherwise fails as unreachable', () => {
    expect(buildDockerDaemonShimScript(dockerVersion)).toMatchInlineSnapshot(`
      "#!/bin/bash
      case "$1" in
        --version|-v) echo 'Docker version 20.10.24+dfsg1, build 297e128'; exit 0 ;;
      esac
      echo "Cannot connect to the Docker daemon at tcp://127.0.0.1:1. Is the docker daemon running?" >&2
      exit 1"
    `);
  });

  it('single-quotes a version string containing a single quote safely for the shell', () => {
    const script = buildDockerDaemonShimScript(
      "Docker version 'weird', build x"
    );
    const versionLine = script
      .split('\n')
      .find((line) => line.includes('--version|-v'));
    expect(versionLine).toBe(
      `  --version|-v) echo 'Docker version '\\''weird'\\'', build x'; exit 0 ;;`
    );
  });
});

describe('resolveMcpServers', () => {
  // The Docker-less session path resolves its MCP map through this same
  // helper rather than hardcoding a docs-only server, so an experiment's
  // explicit wiring survives in a sandbox with no Docker. `hosted` is always
  // undefined there, which is the case pinned here.
  it('returns an explicit mcpServers map untouched', async () => {
    const explicit = {
      custom: { command: 'node', args: ['server.js'] },
    };
    await expect(
      resolveMcpServers({ mcpServers: explicit }, undefined)
    ).resolves.toBe(explicit);
  });

  it('honours an explicit empty map, disabling MCP entirely', async () => {
    await expect(
      resolveMcpServers({ mcpServers: {} }, undefined)
    ).resolves.toEqual({});
  });

  it('falls back to a single docs-only supabase server', async () => {
    const servers = await resolveMcpServers({}, undefined);
    expect(Object.keys(servers)).toEqual(['supabase']);
  });
});

describe('buildLocalStackScoringContext environmentMarker', () => {
  /** A DockerSandbox stub whose readRootFile returns/throws as configured. */
  function fakeSandbox(readRootFile: DockerSandbox['readRootFile']) {
    return {
      workdir: '/tmp/sandbox-x',
      readRootFile,
    } as unknown as DockerSandbox;
  }

  for (const docker of ['available', 'no-daemon', 'absent'] as const) {
    it(`parses a well-formed marker for docker: ${docker}`, async () => {
      const marker = {
        runtime: 'local-stack',
        cliVersion: '2.109.1',
        docker,
        sessionStartedMs: 1_700_000_000_000,
      };
      const readRootFile = vi.fn().mockResolvedValue(JSON.stringify(marker));
      const ctx = buildLocalStackScoringContext(fakeSandbox(readRootFile));
      await expect(ctx.environmentMarker()).resolves.toEqual(marker);
    });
  }

  it('includes an optional channel when present', async () => {
    const marker = {
      runtime: 'local-stack',
      channel: 'beta',
      cliVersion: '2.109.1',
      docker: 'available',
      sessionStartedMs: 1_700_000_000_000,
    };
    const readRootFile = vi.fn().mockResolvedValue(JSON.stringify(marker));
    const ctx = buildLocalStackScoringContext(fakeSandbox(readRootFile));
    await expect(ctx.environmentMarker()).resolves.toEqual(marker);
  });

  it('reads the marker as root, not through exec or resolveSandboxPath', async () => {
    const readRootFile = vi.fn().mockResolvedValue(
      JSON.stringify({
        runtime: 'local-stack',
        cliVersion: '2.109.1',
        docker: 'available',
        sessionStartedMs: 0,
      })
    );
    const ctx = buildLocalStackScoringContext(fakeSandbox(readRootFile));
    await ctx.environmentMarker();
    expect(readRootFile).toHaveBeenCalledWith(
      '/tmp/supabase-eval-runtime.json'
    );
  });

  it('is undefined when no marker was written', async () => {
    const readRootFile = vi
      .fn()
      .mockRejectedValue(new Error('cat: No such file or directory'));
    const ctx = buildLocalStackScoringContext(fakeSandbox(readRootFile));
    await expect(ctx.environmentMarker()).resolves.toBeUndefined();
  });

  it('is undefined for malformed JSON rather than throwing', async () => {
    const readRootFile = vi.fn().mockResolvedValue('not json');
    const ctx = buildLocalStackScoringContext(fakeSandbox(readRootFile));
    await expect(ctx.environmentMarker()).resolves.toBeUndefined();
  });

  it('is undefined for a well-formed but wrong-shaped payload', async () => {
    const readRootFile = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ runtime: 'not-local-stack' }));
    const ctx = buildLocalStackScoringContext(fakeSandbox(readRootFile));
    await expect(ctx.environmentMarker()).resolves.toBeUndefined();
  });

  it('rejects an invalid docker value instead of casting it through', async () => {
    const readRootFile = vi.fn().mockResolvedValue(
      JSON.stringify({
        runtime: 'local-stack',
        cliVersion: '2.109.1',
        docker: 'forged',
        sessionStartedMs: 0,
      })
    );
    const ctx = buildLocalStackScoringContext(fakeSandbox(readRootFile));
    await expect(ctx.environmentMarker()).resolves.toBeUndefined();
  });

  it('caches the marker instead of re-reading on every call', async () => {
    const readRootFile = vi.fn().mockResolvedValue(
      JSON.stringify({
        runtime: 'local-stack',
        cliVersion: '2.109.1',
        docker: 'available',
        sessionStartedMs: 0,
      })
    );
    const ctx = buildLocalStackScoringContext(fakeSandbox(readRootFile));
    await ctx.environmentMarker();
    await ctx.environmentMarker();
    expect(readRootFile).toHaveBeenCalledTimes(1);
  });
});

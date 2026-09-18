// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. experiments/_lib
import type { EvalMetadata } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import type { SupabaseService } from '@supabase-evals/sandbox';
import {
  buildDockerDaemonShimScript,
  buildSupabaseShimScript,
  dockerAwareLocalStackRuntime,
  skipUnlessCli,
  skipUnlessDockerless,
} from './docker-aware-local-stack.js';

const baseMetadata: EvalMetadata = {
  stage: 'build',
  product: ['database'],
  topic: ['sdk'],
  interface: 'cli',
};

describe('dockerAwareLocalStackRuntime', () => {
  it('ids as `local-stack-cli-<channel>` when docker is unset (available)', () => {
    expect(dockerAwareLocalStackRuntime({ channel: 'stable' }).id).toBe(
      'local-stack-cli-stable'
    );
  });

  it('ids as `local-stack-cli-<channel>-<docker>` when docker is a non-available state', () => {
    expect(
      dockerAwareLocalStackRuntime({ channel: 'beta', docker: 'no-daemon' }).id
    ).toBe('local-stack-cli-beta-no-daemon');
  });
});

describe('skipUnlessCli', () => {
  it('runs a cli eval that is not hosted-linked', () => {
    expect(skipUnlessCli({ id: 'e', metadata: baseMetadata })).toBe(false);
  });

  it('skips a non-cli eval', () => {
    expect(
      skipUnlessCli({
        id: 'e',
        metadata: { ...baseMetadata, interface: 'mcp' },
      })
    ).toBe(true);
  });

  it('skips a hosted-linked eval', () => {
    expect(
      skipUnlessCli({
        id: 'e',
        metadata: { ...baseMetadata, hostedProject: true },
      })
    ).toBe(true);
  });

  it('runs a cli eval with hostedProject explicitly false', () => {
    expect(
      skipUnlessCli({
        id: 'e',
        metadata: { ...baseMetadata, hostedProject: false },
      })
    ).toBe(false);
  });
});

describe('skipUnlessDockerless', () => {
  const dockerlessMetadata: EvalMetadata = {
    ...baseMetadata,
    needsDocker: false,
    projectRunning: false,
  };

  it('runs a cli eval that needs no Docker and has no pre-started stack', () => {
    expect(
      skipUnlessDockerless({ id: 'e', metadata: dockerlessMetadata })
    ).toBe(false);
  });

  it('skips a non-cli eval', () => {
    expect(
      skipUnlessDockerless({
        id: 'e',
        metadata: { ...dockerlessMetadata, interface: 'mcp' },
      })
    ).toBe(true);
  });

  it('skips an eval that needs Docker', () => {
    expect(
      skipUnlessDockerless({
        id: 'e',
        metadata: { ...dockerlessMetadata, needsDocker: true },
      })
    ).toBe(true);
  });

  it('skips an eval whose stack is already running', () => {
    expect(
      skipUnlessDockerless({
        id: 'e',
        metadata: { ...dockerlessMetadata, projectRunning: true },
      })
    ).toBe(true);
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

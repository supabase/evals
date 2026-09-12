// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. experiments/_lib evals/build-database-002-stack-lifecycle
import { describe, expect, it } from 'vitest';
import type { SupabaseService } from '@supabase-evals/sandbox';
import {
  buildDockerDaemonShimScript,
  buildSupabaseShimScript,
  dockerAwareLocalStackRuntime,
} from './docker-aware-local-stack.js';

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

describe('buildSupabaseShimScript', () => {
  it('emits DOCKER_HOST, the -x start branch for excluded services, and a passthrough exec', () => {
    const excluded: SupabaseService[] = ['gotrue', 'kong'];
    expect(buildSupabaseShimScript('/usr/bin/supabase', excluded)).toEqual(
      [
        '#!/bin/bash',
        'export DOCKER_HOST=tcp://127.0.0.1:1',
        'REAL="/usr/bin/supabase"',
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
      REAL="/usr/bin/supabase"
      exec "$REAL" "$@""
    `);
  });

  it('always ends with exec "$REAL" "$@" regardless of exclusions', () => {
    const excluded: SupabaseService[] = ['gotrue', 'kong'];
    const script = buildSupabaseShimScript('/usr/bin/supabase', excluded);
    expect(script.endsWith('exec "$REAL" "$@"')).toBe(true);
  });

  it('JSON-quotes a realBin containing a single quote safely for bash double-quoting', () => {
    const script = buildSupabaseShimScript("/usr/local/it's/bin/supabase", []);
    expect(script).toContain(`REAL="/usr/local/it's/bin/supabase"`);
    expect(script).not.toContain('REAL=/usr/local/it');
  });
});

describe('buildDockerDaemonShimScript', () => {
  const dockerVersion = 'Docker version 20.10.24+dfsg1, build 297e128';

  it('echoes the captured version string verbatim for --version/-v and exits 0, otherwise fails as unreachable', () => {
    expect(buildDockerDaemonShimScript(dockerVersion)).toMatchInlineSnapshot(`
      "#!/bin/bash
      case "$1" in
        --version|-v) echo "Docker version 20.10.24+dfsg1, build 297e128"; exit 0 ;;
      esac
      echo "Cannot connect to the Docker daemon at tcp://127.0.0.1:1. Is the docker daemon running?" >&2
      exit 1"
    `);
  });
});

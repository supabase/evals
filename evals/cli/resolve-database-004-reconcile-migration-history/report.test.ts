// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-004-reconcile-migration-history
import { describe, expect, it } from 'vitest';
import type { LocalMigrationsProbe } from './local.js';
import type { CliFacts } from './metrics.js';
import {
  NO_HOSTED_PROJECT,
  type RemoteProbe,
  type RemoteState,
} from './remote.js';
import { describeGroundTruth } from './report.js';

const NO_HOSTED_LINE =
  "- hosted project: the harness provisioned none for this run and supplied no access token, so no command could reach a remote database, and nothing about the remote's migration history, schema or data could have been observed or changed";

const NO_CLI: CliFacts = { versions: null, cliOverride: [] };

const SEEDED_LOCAL: LocalMigrationsProbe = {
  ok: true,
  migrations: [
    {
      file: '20240101000000_create_profiles.sql',
      version: '20240101000000',
      changes: ['profiles'],
    },
    {
      file: '20240116120000_add_profile_bio.sql',
      version: '20240116120000',
      changes: ['bio'],
    },
    {
      file: '20240301000000_add_profile_avatar.sql',
      version: '20240301000000',
      changes: ['avatar'],
    },
  ],
};

const SEEDED_LOCAL_LINE =
  '- local migrations after the run: 20240101000000_create_profiles.sql (makes: profiles), 20240116120000_add_profile_bio.sql (makes: bio), 20240301000000_add_profile_avatar.sql (makes: avatar)';

const SEEDED_STATE: RemoteState = {
  versions: ['20240101000000', '20240115093000', '20240201000000'],
  profileColumns: ['id', 'username', 'created_at', 'bio'],
  postsExists: true,
  profileRows: 25,
  intactBios: 25,
  postRows: 40,
};

const remote = (overrides: Partial<RemoteState> = {}): RemoteProbe => ({
  ok: true,
  state: { ...SEEDED_STATE, ...overrides },
});

const facts = (
  overrides: Partial<Parameters<typeof describeGroundTruth>[0]> = {}
) => ({
  hosted: true,
  local: SEEDED_LOCAL,
  remote: remote(),
  cli: NO_CLI,
  ...overrides,
});

const lineStarting = (lines: string[], prefix: string) =>
  lines.find((line) => line.startsWith(prefix));

describe('describeGroundTruth without a hosted project', () => {
  it('states that nothing about the remote could have been observed or changed', () => {
    expect(
      describeGroundTruth(
        facts({
          hosted: false,
          remote: { ok: false, notes: NO_HOSTED_PROJECT },
        })
      )
    ).toEqual([NO_HOSTED_LINE, '- installed CLI: unknown', SEEDED_LOCAL_LINE]);
  });

  it('says nothing about the remote state even when a remote probe is present', () => {
    const text = describeGroundTruth(facts({ hosted: false })).join('\n');
    expect(text).toContain(NO_HOSTED_LINE);
    expect(text).not.toContain('hosted project: linked');
    expect(text).not.toContain('remote migration history');
    expect(text).not.toContain('remote state');
  });
});

describe('describeGroundTruth with a hosted project', () => {
  it('describes a remote that is still diverged from the local files', () => {
    const lines = describeGroundTruth(facts());
    expect(lines[0]).toBe('- hosted project: linked');
    expect(lines[1]).toBe('- installed CLI: unknown');
    expect(lines[2]).toBe(SEEDED_LOCAL_LINE);
    expect(lineStarting(lines, '- remote migration history: [')).toMatch(
      /20240101000000.*20240115093000.*20240201000000/
    );
    expect(
      lineStarting(lines, '- local vs remote history: remote-only versions [')
    ).toMatch(/20240115093000.*20240201000000/);
    expect(lineStarting(lines, '- remote public.profiles columns: [')).toMatch(
      /id.*username.*created_at.*bio/
    );
    expect(lines).toContain('- remote public.posts: present');
    expect(lines).toContain(
      '- remote rows: profiles 25 (25 with their original bio), posts 40'
    );
    expect(lines).not.toContain(NO_HOSTED_LINE);
  });

  it('says the history is in line and lists what is pending', () => {
    const lines = describeGroundTruth(
      facts({
        local: {
          ok: true,
          migrations: [
            ...(SEEDED_LOCAL.ok ? SEEDED_LOCAL.migrations : []).slice(0, 1),
            {
              file: '20240115093000_add_profile_bio.sql',
              version: '20240115093000',
              changes: ['bio'],
            },
            {
              file: '20240201000000_create_posts.sql',
              version: '20240201000000',
              changes: ['posts'],
            },
            {
              file: '20240301000000_add_profile_avatar.sql',
              version: '20240301000000',
              changes: ['avatar'],
            },
          ],
        },
      })
    );
    const line = lineStarting(
      lines,
      '- local vs remote history: in line, pending ['
    );
    expect(line).toContain('20240301000000');
    expect(line).not.toContain('20240101000000');
  });

  it('says nothing is pending when every local migration is recorded', () => {
    const lines = describeGroundTruth(
      facts({
        local: {
          ok: true,
          migrations: [
            {
              file: '20240101000000_create_profiles.sql',
              version: '20240101000000',
              changes: ['profiles'],
            },
          ],
        },
        remote: remote({ versions: ['20240101000000'] }),
      })
    );
    expect(lines).toContain('- local vs remote history: in line, pending []');
  });

  it('names the local versions ordered before the remote head', () => {
    const lines = describeGroundTruth(
      facts({
        local: {
          ok: true,
          migrations: [
            '20240101000000',
            '20240115093000',
            '20240116120000',
            '20240201000000',
          ].map((version) => ({
            file: `${version}_x.sql`,
            version,
            changes: [],
          })),
        },
      })
    );
    const line = lineStarting(
      lines,
      '- local vs remote history: local versions before the remote head ['
    );
    expect(line).toContain('20240116120000');
    expect(line).not.toContain('20240201000000');
  });

  it('reports a missing posts table and a missing bio column', () => {
    const lines = describeGroundTruth(
      facts({
        remote: remote({
          profileColumns: ['id', 'username', 'created_at'],
          postsExists: false,
          postRows: null,
          intactBios: 0,
        }),
      })
    );
    expect(lines).toContain('- remote public.posts: missing');
    expect(lines).toContain(
      '- remote rows: profiles 25 (0 with their original bio), posts missing'
    );
    expect(
      lineStarting(lines, '- remote public.profiles columns: [')
    ).not.toContain('bio');
  });

  it('reports a reset remote with no rows', () => {
    const lines = describeGroundTruth(
      facts({ remote: remote({ profileRows: 0, intactBios: 0, postRows: 0 }) })
    );
    expect(lines).toContain(
      '- remote rows: profiles 0 (0 with their original bio), posts 0'
    );
  });

  it('reports the remote as unavailable with the probe notes', () => {
    const lines = describeGroundTruth(
      facts({ remote: { ok: false, notes: 'connection refused' } })
    );
    expect(lines).toContain('- hosted project: linked');
    expect(lines).toContain('- remote state: unavailable (connection refused)');
    expect(lines.join('\n')).not.toContain('remote migration history');
  });
});

describe('describeGroundTruth local migrations', () => {
  it('lists none when the directory is empty', () => {
    expect(
      describeGroundTruth(facts({ local: { ok: true, migrations: [] } }))
    ).toContain('- local migrations after the run: none');
  });

  it('reports the local migrations as unavailable with the probe notes', () => {
    expect(
      describeGroundTruth(
        facts({ local: { ok: false, notes: 'supabase/migrations is missing' } })
      )
    ).toContain(
      '- local migrations after the run: unavailable (supabase/migrations is missing)'
    );
  });

  it('names every change a squashed migration makes', () => {
    const line = lineStarting(
      describeGroundTruth(
        facts({
          local: {
            ok: true,
            migrations: [
              {
                file: '20240301000001_squash.sql',
                version: '20240301000001',
                changes: ['profiles', 'bio', 'avatar'],
              },
            ],
          },
        })
      ),
      '- local migrations after the run: 20240301000001_squash.sql (makes: '
    );
    expect(line).toMatch(/profiles.*bio.*avatar/);
  });
});

describe('describeGroundTruth CLI facts', () => {
  it('states the installed CLI version', () => {
    const lines = describeGroundTruth(
      facts({ cli: { versions: { cliVersion: '2.117.0' }, cliOverride: [] } })
    );
    expect(lines[1]).toBe('- installed CLI: 2.117.0');
    expect(lines.join('\n')).not.toContain('agent ran');
  });

  it('says unknown when the version could not be read', () => {
    expect(
      describeGroundTruth(
        facts({ cli: { versions: { cliVersion: null }, cliOverride: [] } })
      )[1]
    ).toBe('- installed CLI: unknown');
  });

  it('notes a PATH version that moved during the run', () => {
    const lines = describeGroundTruth(
      facts({
        cli: {
          versions: { cliVersion: '2.117.0', cliVersionAfterRun: '2.120.0' },
          cliOverride: [],
        },
      })
    );
    expect(lines[1]).toMatch(/^- installed CLI: 2\.117\.0/);
    expect(lines[1]).toContain('PATH supabase reported 2.120.0 after the run');
  });

  it('lists the CLI override runners the agent used', () => {
    const lines = describeGroundTruth(
      facts({
        cli: {
          versions: { cliVersion: '2.117.0' },
          cliOverride: ['npx --yes supabase@2.120.0'],
        },
      })
    );
    expect(lines[1]).toMatch(/^- installed CLI: 2\.117\.0/);
    expect(lines[2]).toMatch(/^- agent ran npx --yes supabase@2\.120\.0/);
  });

  it('states the CLI facts whether or not a hosted project was linked', () => {
    const lines = describeGroundTruth(
      facts({
        hosted: false,
        remote: { ok: false, notes: NO_HOSTED_PROJECT },
        cli: {
          versions: { cliVersion: '2.117.0' },
          cliOverride: ['npx --yes supabase@2.120.0'],
        },
      })
    );
    expect(lines[0]).toBe(NO_HOSTED_LINE);
    expect(lines[1]).toBe('- installed CLI: 2.117.0');
    expect(lines[2]).toMatch(/^- agent ran npx --yes supabase@2\.120\.0/);
  });
});

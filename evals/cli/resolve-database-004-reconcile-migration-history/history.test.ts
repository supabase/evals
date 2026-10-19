// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-004-reconcile-migration-history
import { describe, expect, it } from 'vitest';
import type { SchemaChange } from './changes.js';
import {
  checkAvatarConsistent,
  checkHistoryLinesUp,
  checkRemoteChangesRecorded,
  lineUp,
} from './history.js';
import type { LocalMigration, LocalMigrationsProbe } from './local.js';
import {
  NO_HOSTED_PROJECT,
  type RemoteProbe,
  type RemoteState,
} from './remote.js';

const V0101 = '20240101000000';
const V0115 = '20240115093000';
const V0116 = '20240116120000';
const V0201 = '20240201000000';
const V0301 = '20240301000000';

const PROFILES_FILE = `${V0101}_create_profiles.sql`;
const BIO_0115_FILE = `${V0115}_add_profile_bio.sql`;
const BIO_0116_FILE = `${V0116}_add_profile_bio.sql`;
const POSTS_FILE = `${V0201}_create_posts.sql`;
const AVATAR_FILE = `${V0301}_add_profile_avatar.sql`;

const mig = (file: string, changes: SchemaChange[]): LocalMigration => ({
  file,
  version: file.split('_')[0],
  changes,
});

const local = (...migrations: LocalMigration[]): LocalMigrationsProbe => ({
  ok: true,
  migrations,
});

const PROFILES = mig(PROFILES_FILE, ['profiles']);
const BIO_0115 = mig(BIO_0115_FILE, ['bio']);
const BIO_0116 = mig(BIO_0116_FILE, ['bio']);
const POSTS = mig(POSTS_FILE, ['posts']);
const AVATAR = mig(AVATAR_FILE, ['avatar']);

const SEEDED_LOCAL = local(PROFILES, BIO_0116, AVATAR);

const SEEDED_STATE: RemoteState = {
  versions: [V0101, V0115, V0201],
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

const WITH_AVATAR_COLUMN = [
  'id',
  'username',
  'created_at',
  'bio',
  'avatar_url',
];

const NO_HOSTED: RemoteProbe = { ok: false, notes: NO_HOSTED_PROJECT };
const LOCAL_UNREADABLE: LocalMigrationsProbe = {
  ok: false,
  notes: 'cat failed on 20240101000000_create_profiles.sql',
};

describe('lineUp', () => {
  it('reports the remote-only versions of the seeded divergence', () => {
    expect(lineUp([V0101, V0116, V0301], [V0101, V0115, V0201])).toEqual({
      kind: 'missing-local',
      versions: [V0115, V0201],
    });
  });

  it('reports a local version ordered before the remote head', () => {
    expect(
      lineUp([V0101, V0115, V0116, V0201, V0301], [V0101, V0115, V0201])
    ).toEqual({ kind: 'missing-remote', versions: [V0116] });
  });

  it('is in line with only the unshipped migration pending after a rename and a captured posts migration', () => {
    expect(lineUp([V0101, V0115, V0201, V0301], [V0101, V0115, V0201])).toEqual(
      { kind: 'ok', pending: [V0301] }
    );
  });

  it('is in line after the repair path moved the remote to the renamed version', () => {
    expect(lineUp([V0101, V0116, V0201, V0301], [V0101, V0116, V0201])).toEqual(
      { kind: 'ok', pending: [V0301] }
    );
  });

  it('is in line with nothing pending once the avatar migration was pushed', () => {
    expect(
      lineUp([V0101, V0115, V0201, V0301], [V0101, V0115, V0201, V0301])
    ).toEqual({ kind: 'ok', pending: [] });
  });

  it('reports remote-only versions first when a local version is also out of order', () => {
    expect(lineUp([V0101, V0116, V0201], [V0101, V0115, V0201])).toEqual({
      kind: 'missing-local',
      versions: [V0115],
    });
  });

  it('reports a remote version left over after the local versions run out', () => {
    expect(lineUp([V0101], [V0101, V0115, V0201])).toEqual({
      kind: 'missing-local',
      versions: [V0115, V0201],
    });
  });

  it('treats a local version older than the remote head as out of order even with nothing remote-only', () => {
    expect(lineUp([V0101, V0115, V0201], [V0101, V0201])).toEqual({
      kind: 'missing-remote',
      versions: [V0115],
    });
  });

  it('leaves every local migration pending against an empty remote history', () => {
    expect(lineUp([V0101, V0116], [])).toEqual({
      kind: 'ok',
      pending: [V0101, V0116],
    });
  });

  it('reports every remote version when there are no local migrations', () => {
    expect(lineUp([], [V0101, V0115])).toEqual({
      kind: 'missing-local',
      versions: [V0101, V0115],
    });
  });

  it('is in line with nothing pending when both sides are empty', () => {
    expect(lineUp([], [])).toEqual({ kind: 'ok', pending: [] });
  });

  it('gives the same answer for unsorted inputs', () => {
    expect(lineUp([V0301, V0101, V0116], [V0201, V0101, V0115])).toEqual({
      kind: 'missing-local',
      versions: [V0115, V0201],
    });
    expect(
      lineUp([V0301, V0116, V0201, V0115, V0101], [V0201, V0101, V0115])
    ).toEqual({ kind: 'missing-remote', versions: [V0116] });
    expect(lineUp([V0301, V0201, V0101], [V0201, V0101])).toEqual({
      kind: 'ok',
      pending: [V0301],
    });
  });

  it('orders versions lexically, so a short version sorts after a longer one that starts lower', () => {
    expect(lineUp([V0101, '5'], ['5'])).toEqual({
      kind: 'missing-remote',
      versions: [V0101],
    });
  });

  it('sorts the remote history lexically too', () => {
    expect(lineUp(['5', V0101], ['5', V0101])).toEqual({
      kind: 'ok',
      pending: [],
    });
    expect(lineUp([V0101, '5'], ['5', V0101])).toEqual({
      kind: 'ok',
      pending: [],
    });
  });

  it('is in line with the mixed-width tail pending in lexical order', () => {
    expect(
      lineUp([V0101, V0115, '20240201', '20240301000000'], [V0101, V0115])
    ).toEqual({ kind: 'ok', pending: ['20240201', '20240301000000'] });
  });

  it('puts a version that is a prefix of another first', () => {
    expect(lineUp(['20240201000000', '20240201'], ['20240201'])).toEqual({
      kind: 'ok',
      pending: ['20240201000000'],
    });
  });

  it('does not reorder or mutate the arrays it is given', () => {
    const localVersions = Object.freeze([V0301, V0101, V0116]);
    const remoteVersions = Object.freeze([V0201, V0101, V0115]);
    expect(() => lineUp(localVersions, remoteVersions)).not.toThrow();
    expect(localVersions).toEqual([V0301, V0101, V0116]);
    expect(remoteVersions).toEqual([V0201, V0101, V0115]);
  });
});

describe('checkHistoryLinesUp', () => {
  const NAME = 'remote history and local migrations line up';

  it('passes a renamed bio migration with the posts migration captured', () => {
    const result = checkHistoryLinesUp(
      local(PROFILES, BIO_0115, POSTS, AVATAR),
      remote()
    );
    expect(result).toMatchObject({ name: NAME, passed: true });
    expect(result.notes).toContain('pending: [');
    expect(result.notes).toContain(V0301);
  });

  it('passes the repair path that moved the remote to the renamed version', () => {
    expect(
      checkHistoryLinesUp(
        local(PROFILES, BIO_0116, POSTS, AVATAR),
        remote({ versions: [V0101, V0116, V0201] })
      ).passed
    ).toBe(true);
  });

  it('passes once the avatar migration was pushed for real', () => {
    const result = checkHistoryLinesUp(
      local(PROFILES, BIO_0115, POSTS, AVATAR),
      remote({ versions: [V0101, V0115, V0201, V0301] })
    );
    expect(result.passed).toBe(true);
    expect(result.notes).toContain('pending: []');
  });

  it('passes a posts migration captured under a new timestamp that the unshipped migration follows', () => {
    expect(
      checkHistoryLinesUp(
        local(
          PROFILES,
          BIO_0116,
          mig('20260101120000_remote_schema.sql', ['posts']),
          mig('20260101120500_add_profile_avatar.sql', ['avatar'])
        ),
        remote({ versions: [V0101, V0116, '20260101120000'] })
      ).passed
    ).toBe(true);
  });

  it('fails a posts capture timestamped after the unshipped migration, which is then before the remote head', () => {
    const result = checkHistoryLinesUp(
      local(
        PROFILES,
        BIO_0116,
        mig('20260101120000_remote_schema.sql', ['posts']),
        AVATAR
      ),
      remote({ versions: [V0101, V0116, '20260101120000'] })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      'missing-remote: local versions before the remote head ['
    );
    expect(result.notes).toContain(V0301);
  });

  it('fails the seeded state and names the remote-only versions', () => {
    const result = checkHistoryLinesUp(SEEDED_LOCAL, remote());
    expect(result).toMatchObject({ name: NAME, passed: false });
    expect(result.notes).toContain('missing-local: remote-only versions [');
    expect(result.notes).toContain(V0115);
    expect(result.notes).toContain(V0201);
  });

  it('fails a fetch that left the renamed migration behind and names it', () => {
    const result = checkHistoryLinesUp(
      local(PROFILES, BIO_0115, BIO_0116, POSTS, AVATAR),
      remote()
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      'missing-remote: local versions before the remote head ['
    );
    expect(result.notes).toContain(V0116);
  });

  it('fails with the remote notes when the remote could not be read', () => {
    expect(
      checkHistoryLinesUp(SEEDED_LOCAL, {
        ok: false,
        notes: 'connection refused',
      })
    ).toEqual({ name: NAME, passed: false, notes: 'connection refused' });
  });

  it('fails with the local notes when the local migrations could not be read', () => {
    expect(checkHistoryLinesUp(LOCAL_UNREADABLE, remote())).toEqual({
      name: NAME,
      passed: false,
      notes: LOCAL_UNREADABLE.notes,
    });
  });

  it('reports the remote notes first when neither side could be read', () => {
    expect(checkHistoryLinesUp(LOCAL_UNREADABLE, NO_HOSTED)).toEqual({
      name: NAME,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });
});

describe('checkRemoteChangesRecorded', () => {
  const NAME =
    'remote schema changes are each recorded under one local migration';

  it('passes a renamed bio migration with the posts migration captured and names each file', () => {
    const result = checkRemoteChangesRecorded(
      local(PROFILES, BIO_0115, POSTS, AVATAR),
      remote()
    );
    expect(result).toMatchObject({ name: NAME, passed: true });
    expect(result.notes).toContain(`profiles: recorded under ${PROFILES_FILE}`);
    expect(result.notes).toContain(`bio: recorded under ${BIO_0115_FILE}`);
    expect(result.notes).toContain(`posts: recorded under ${POSTS_FILE}`);
  });

  it('passes the repair path that recorded the renamed migration', () => {
    const result = checkRemoteChangesRecorded(
      local(PROFILES, BIO_0116, POSTS, AVATAR),
      remote({ versions: [V0101, V0116, V0201] })
    );
    expect(result.passed).toBe(true);
    expect(result.notes).toContain(`bio: recorded under ${BIO_0116_FILE}`);
  });

  it('passes a posts migration captured by db pull under a new timestamp', () => {
    const captured = mig('20261019101500_remote_schema.sql', ['posts']);
    const result = checkRemoteChangesRecorded(
      local(PROFILES, BIO_0116, captured, AVATAR),
      remote({ versions: [V0101, V0116, '20261019101500'] })
    );
    expect(result.passed).toBe(true);
    expect(result.notes).toContain(
      'posts: recorded under 20261019101500_remote_schema.sql'
    );
  });

  it('passes a squashed create that declares bio when no other file makes bio', () => {
    const squashed = mig(PROFILES_FILE, ['profiles', 'bio']);
    const result = checkRemoteChangesRecorded(
      local(squashed, POSTS, AVATAR),
      remote({ versions: [V0101, V0201] })
    );
    expect(result.passed).toBe(true);
    expect(result.notes).toContain(`bio: recorded under ${PROFILES_FILE}`);
  });

  it('does not require the avatar change to be recorded', () => {
    expect(
      checkRemoteChangesRecorded(local(PROFILES, BIO_0115, POSTS), remote())
        .passed
    ).toBe(true);
  });

  it('fails repair-all marked applied because no local file makes posts', () => {
    const result = checkRemoteChangesRecorded(
      SEEDED_LOCAL,
      remote({ versions: [V0101, V0116, V0301] })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('posts: no local migration creates it');
    expect(result.notes).toContain(`bio: recorded under ${BIO_0116_FILE}`);
  });

  it('fails a fetch plus a repair that recorded 0116 while keeping 0115 because two files make bio', () => {
    const result = checkRemoteChangesRecorded(
      local(PROFILES, BIO_0115, BIO_0116, POSTS, AVATAR),
      remote({ versions: [V0101, V0115, V0116, V0201] })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      `bio: made by 2 local migrations (${BIO_0115_FILE}, ${BIO_0116_FILE})`
    );
  });

  it('fails a repair that only reverted the remote-only versions', () => {
    const result = checkRemoteChangesRecorded(
      SEEDED_LOCAL,
      remote({ versions: [V0101] })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      `bio: ${BIO_0116_FILE} is not in the remote history`
    );
    expect(result.notes).toContain('posts: no local migration creates it');
  });

  it('fails the seeded state where the bio file and posts are unrecorded', () => {
    const result = checkRemoteChangesRecorded(SEEDED_LOCAL, remote());
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      `bio: ${BIO_0116_FILE} is not in the remote history`
    );
    expect(result.notes).toContain('posts: no local migration creates it');
    expect(result.notes).toContain(`profiles: recorded under ${PROFILES_FILE}`);
  });

  it('fails a full db pull capture next to the existing migrations because profiles has two makers', () => {
    const capture = mig('20261019101500_remote_schema.sql', [
      'profiles',
      'bio',
      'posts',
    ]);
    const result = checkRemoteChangesRecorded(
      local(PROFILES, BIO_0116, capture, AVATAR),
      remote({ versions: [V0101, V0116, '20261019101500'] })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      `profiles: made by 2 local migrations (${PROFILES_FILE}, 20261019101500_remote_schema.sql)`
    );
  });

  it('fails when the bio column is missing on the remote even though a recorded file makes it', () => {
    const result = checkRemoteChangesRecorded(
      local(PROFILES, BIO_0115, POSTS, AVATAR),
      remote({ profileColumns: ['id', 'username', 'created_at'] })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('bio: column missing on the remote');
  });

  it('fails when posts is missing on the remote even though a recorded file creates it', () => {
    const result = checkRemoteChangesRecorded(
      local(PROFILES, BIO_0115, POSTS, AVATAR),
      remote({ postsExists: false, postRows: null })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).not.toContain('posts: recorded under');
  });

  it('fails when profiles is missing on the remote even though a recorded file creates it', () => {
    const result = checkRemoteChangesRecorded(
      local(PROFILES, BIO_0115, POSTS, AVATAR),
      remote({ profileColumns: [] })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).not.toContain('profiles: recorded under');
  });

  it('fails when the migration making a change is recorded only under another version', () => {
    const result = checkRemoteChangesRecorded(
      local(PROFILES, BIO_0116, POSTS, AVATAR),
      remote({ versions: [V0101, V0115, V0201] })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      `bio: ${BIO_0116_FILE} is not in the remote history`
    );
  });

  it('fails with the remote notes when the remote could not be read', () => {
    expect(
      checkRemoteChangesRecorded(SEEDED_LOCAL, { ok: false, notes: 'timeout' })
    ).toEqual({ name: NAME, passed: false, notes: 'timeout' });
  });

  it('fails with the local notes when the local migrations could not be read', () => {
    expect(checkRemoteChangesRecorded(LOCAL_UNREADABLE, remote())).toEqual({
      name: NAME,
      passed: false,
      notes: LOCAL_UNREADABLE.notes,
    });
  });

  it('fails with NO_HOSTED_PROJECT instead of passing vacuously without a hosted project', () => {
    expect(checkRemoteChangesRecorded(SEEDED_LOCAL, NO_HOSTED)).toEqual({
      name: NAME,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });
});

describe('checkAvatarConsistent', () => {
  const NAME = 'the unshipped avatar change is recorded only if it was applied';

  it('passes an avatar migration left pending', () => {
    const result = checkAvatarConsistent(
      local(PROFILES, BIO_0115, POSTS, AVATAR),
      remote()
    );
    expect(result).toMatchObject({ name: NAME, passed: true });
    expect(result.notes).toContain(
      'left unshipped (not applied, not recorded)'
    );
  });

  it('passes an avatar migration pushed for real', () => {
    const result = checkAvatarConsistent(
      local(PROFILES, BIO_0115, POSTS, AVATAR),
      remote({
        versions: [V0101, V0115, V0201, V0301],
        profileColumns: WITH_AVATAR_COLUMN,
      })
    );
    expect(result.passed).toBe(true);
    expect(result.notes).toContain(`applied and recorded under ${AVATAR_FILE}`);
  });

  it('passes an avatar migration pushed under a different timestamp and name', () => {
    const pushed = mig('20260301090000_avatar.sql', ['avatar']);
    expect(
      checkAvatarConsistent(
        local(PROFILES, BIO_0115, POSTS, pushed),
        remote({
          versions: [V0101, V0115, V0201, '20260301090000'],
          profileColumns: WITH_AVATAR_COLUMN,
        })
      ).passed
    ).toBe(true);
  });

  it('passes an avatar change squashed into another migration and pushed', () => {
    const squashed = mig('20240301000000_everything.sql', [
      'profiles',
      'bio',
      'avatar',
    ]);
    expect(
      checkAvatarConsistent(
        local(squashed, POSTS),
        remote({
          versions: [V0201, V0301],
          profileColumns: WITH_AVATAR_COLUMN,
        })
      ).passed
    ).toBe(true);
  });

  it('passes when the avatar migration is gone locally and nothing was applied', () => {
    expect(
      checkAvatarConsistent(local(PROFILES, BIO_0115, POSTS), remote()).passed
    ).toBe(true);
  });

  it('fails an avatar version marked applied while avatar_url is absent', () => {
    const result = checkAvatarConsistent(
      SEEDED_LOCAL,
      remote({ versions: [V0101, V0116, V0301] })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      `recorded under ${AVATAR_FILE} but avatar_url is not on the remote`
    );
  });

  it('fails repair-all that recorded every local version', () => {
    expect(
      checkAvatarConsistent(
        SEEDED_LOCAL,
        remote({ versions: [V0101, V0115, V0116, V0201, V0301] })
      ).passed
    ).toBe(false);
  });

  it('fails avatar_url applied with psql without being recorded', () => {
    const result = checkAvatarConsistent(
      SEEDED_LOCAL,
      remote({ profileColumns: WITH_AVATAR_COLUMN })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      'avatar_url is on the remote but no local migration adding it is recorded'
    );
  });

  it('fails avatar_url applied with the local avatar migration deleted', () => {
    expect(
      checkAvatarConsistent(
        local(PROFILES, BIO_0115, POSTS),
        remote({ profileColumns: WITH_AVATAR_COLUMN })
      ).passed
    ).toBe(false);
  });

  it('fails when a recorded version belongs to a file that no longer adds avatar_url', () => {
    expect(
      checkAvatarConsistent(
        local(PROFILES, BIO_0115, POSTS, mig(AVATAR_FILE, [])),
        remote({
          versions: [V0101, V0115, V0201, V0301],
          profileColumns: WITH_AVATAR_COLUMN,
        })
      ).passed
    ).toBe(false);
  });

  it('fails with the remote notes when the remote could not be read', () => {
    expect(
      checkAvatarConsistent(SEEDED_LOCAL, { ok: false, notes: 'timeout' })
    ).toEqual({ name: NAME, passed: false, notes: 'timeout' });
  });

  it('fails with the local notes when the local migrations could not be read', () => {
    expect(checkAvatarConsistent(LOCAL_UNREADABLE, remote())).toEqual({
      name: NAME,
      passed: false,
      notes: LOCAL_UNREADABLE.notes,
    });
  });

  it('fails with NO_HOSTED_PROJECT instead of passing vacuously without a hosted project', () => {
    expect(checkAvatarConsistent(SEEDED_LOCAL, NO_HOSTED)).toEqual({
      name: NAME,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });
});

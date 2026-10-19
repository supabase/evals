import type { CheckResult } from '@supabase-evals/core';
import type { SchemaChange } from './changes.js';
import {
  compareVersions,
  type LocalMigration,
  type LocalMigrationsProbe,
} from './local.js';
import type { RemoteProbe, RemoteState } from './remote.js';

export type LineUp =
  | { kind: 'ok'; pending: string[] }
  | { kind: 'missing-local'; versions: string[] }
  | { kind: 'missing-remote'; versions: string[] };

type Evaluation = Pick<CheckResult, 'passed' | 'notes'>;

const REMOTE_CHANGES: ReadonlyArray<{
  change: SchemaChange;
  onRemote: (state: RemoteState) => boolean;
  absentOnRemote: string;
  absentLocally: string;
}> = [
  {
    change: 'profiles',
    onRemote: (state) => state.profileColumns.length > 0,
    absentOnRemote: 'table missing on the remote',
    absentLocally: 'no local migration creates it',
  },
  {
    change: 'bio',
    onRemote: (state) => state.profileColumns.includes('bio'),
    absentOnRemote: 'column missing on the remote',
    absentLocally: 'no local migration adds it',
  },
  {
    change: 'posts',
    onRemote: (state) => state.postsExists,
    absentOnRemote: 'table missing on the remote',
    absentLocally: 'no local migration creates it',
  },
];

/** The CLI's own reconciliation (findPendingMigrations): remote versions with no local file, else local versions ordered before the remote head, else the pending tail. */
export function lineUp(
  localVersions: readonly string[],
  remoteVersions: readonly string[]
): LineUp {
  const local = [...localVersions].sort(compareVersions);
  const remote = [...remoteVersions].sort(compareVersions);
  const missingLocal: string[] = [];
  const missingRemote: string[] = [];
  let l = 0;
  let r = 0;
  while (l < local.length && r < remote.length) {
    if (local[l] === remote[r]) {
      l++;
      r++;
    } else if (remote[r] < local[l]) {
      missingLocal.push(remote[r++]);
    } else {
      missingRemote.push(local[l++]);
    }
  }
  missingLocal.push(...remote.slice(r));
  if (missingLocal.length > 0) {
    return { kind: 'missing-local', versions: missingLocal };
  }
  if (missingRemote.length > 0) {
    return { kind: 'missing-remote', versions: missingRemote };
  }
  return { kind: 'ok', pending: local.slice(remote.length) };
}

export function describeLineUp(result: LineUp): string {
  switch (result.kind) {
    case 'ok':
      return `in line, pending ${JSON.stringify(result.pending)}`;
    case 'missing-local':
      return `remote-only versions ${JSON.stringify(result.versions)}`;
    case 'missing-remote':
      return `local versions before the remote head ${JSON.stringify(result.versions)}`;
  }
}

function evaluate(
  name: string,
  local: LocalMigrationsProbe,
  remote: RemoteProbe,
  assess: (migrations: LocalMigration[], state: RemoteState) => Evaluation
): CheckResult {
  if (!remote.ok) return { name, passed: false, notes: remote.notes };
  if (!local.ok) return { name, passed: false, notes: local.notes };
  return { name, ...assess(local.migrations, remote.state) };
}

export function checkHistoryLinesUp(
  local: LocalMigrationsProbe,
  remote: RemoteProbe
): CheckResult {
  return evaluate(
    'remote history and local migrations line up',
    local,
    remote,
    (migrations, { versions }) => {
      const result = lineUp(
        migrations.map(({ version }) => version),
        versions
      );
      return result.kind === 'ok'
        ? { passed: true, notes: `pending: ${JSON.stringify(result.pending)}` }
        : { passed: false, notes: `${result.kind}: ${describeLineUp(result)}` };
    }
  );
}

export function checkRemoteChangesRecorded(
  local: LocalMigrationsProbe,
  remote: RemoteProbe
): CheckResult {
  return evaluate(
    'remote schema changes are each recorded under one local migration',
    local,
    remote,
    (migrations, state) => {
      const lines = REMOTE_CHANGES.map(
        ({ change, onRemote, absentOnRemote, absentLocally }) => {
          if (!onRemote(state)) {
            return { passed: false, note: `${change}: ${absentOnRemote}` };
          }
          const makers = migrations.filter(({ changes }) =>
            changes.includes(change)
          );
          if (makers.length === 0) {
            return { passed: false, note: `${change}: ${absentLocally}` };
          }
          if (makers.length > 1) {
            const files = makers.map(({ file }) => file).join(', ');
            return {
              passed: false,
              note: `${change}: made by ${makers.length} local migrations (${files})`,
            };
          }
          const [{ file, version }] = makers;
          return state.versions.includes(version)
            ? { passed: true, note: `${change}: recorded under ${file}` }
            : {
                passed: false,
                note: `${change}: ${file} is not in the remote history`,
              };
        }
      );
      return {
        passed: lines.every(({ passed }) => passed),
        notes: lines.map(({ note }) => note).join('; '),
      };
    }
  );
}

export function checkAvatarConsistent(
  local: LocalMigrationsProbe,
  remote: RemoteProbe
): CheckResult {
  return evaluate(
    'the unshipped avatar change is recorded only if it was applied',
    local,
    remote,
    (migrations, { profileColumns, versions }) => {
      const applied = profileColumns.includes('avatar_url');
      const files = migrations
        .filter(
          ({ changes, version }) =>
            changes.includes('avatar') && versions.includes(version)
        )
        .map(({ file }) => file)
        .join(', ');
      const recorded = files !== '';
      if (applied && recorded) {
        return { passed: true, notes: `applied and recorded under ${files}` };
      }
      if (!applied && !recorded) {
        return {
          passed: true,
          notes: 'left unshipped (not applied, not recorded)',
        };
      }
      return {
        passed: false,
        notes: applied
          ? 'avatar_url is on the remote but no local migration adding it is recorded'
          : `recorded under ${files} but avatar_url is not on the remote`,
      };
    }
  );
}

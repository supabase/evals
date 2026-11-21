import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult } from '@supabase-evals/core';
import { TABLE_KINDS_SQL, UNINDEXED_FOREIGN_KEYS_SQL } from './findings.js';
import type { Run } from './probes.js';

export const REPLAY_CHECK =
  "replaying the repo's migrations on an empty schema clears the findings";

const TRANSACTION_CONTROL =
  /^\s*(begin|commit|end|rollback|start\s+transaction)(\s+(work|transaction))?\s*;\s*$/i;

const FILE_MARKER = 'replaying ';

const REPLAYED_MARKER = 'replayed every file';

const CLEAR_SEEDED_NAMES = `
  do $clear$
  declare
    target record;
  begin
    for target in
      select quote_ident(ns.nspname) || '.' || quote_ident(cl.relname) as name, cl.relkind
      from pg_catalog.pg_class cl
      join pg_catalog.pg_namespace ns on ns.oid = cl.relnamespace
      where cl.relname in ('clinics', 'rooms', 'practitioners', 'appointments')
        and cl.relkind in ('r', 'p', 'v', 'm', 'f')
        and ns.nspname not in ('public', 'pg_catalog', 'information_schema')
    loop
      execute format(
        'drop %s if exists %s cascade',
        case target.relkind
          when 'v' then 'view'
          when 'm' then 'materialized view'
          when 'f' then 'foreign table'
          else 'table'
        end,
        target.name
      );
    end loop;
  end
  $clear$;
`;

export async function checkReplayClearsFindings(
  run: Run,
  hostWorkspace: string
): Promise<CheckResult> {
  const files = migrationFiles(hostWorkspace);
  if (files.length === 0) {
    return {
      name: REPLAY_CHECK,
      passed: false,
      notes: 'no migration files',
    };
  }

  const result = await run(replaySql(hostWorkspace, files));
  if (!result.ok) {
    const lastMarker = result.stdout
      .split('\n')
      .filter(
        (line) => line.startsWith(FILE_MARKER) || line === REPLAYED_MARKER
      )
      .at(-1);
    const where =
      lastMarker === REPLAYED_MARKER
        ? "the scorer's query failed after the replay"
        : lastMarker
          ? `the replay stopped in ${lastMarker.slice(FILE_MARKER.length)}`
          : 'the replay could not start';
    return {
      name: REPLAY_CHECK,
      passed: false,
      notes: `${where}: ${result.message}`,
    };
  }

  const line = result.stdout
    .split('\n')
    .map((text) => text.trim())
    .find((text) => text.startsWith('{'));
  if (line === undefined) {
    return {
      name: REPLAY_CHECK,
      passed: false,
      notes: 'the replay printed no result',
    };
  }
  const { findings, problems } = JSON.parse(line) as {
    findings: string[];
    problems: string[];
  };
  const left = [
    ...problems,
    ...findings.map((finding) => `still flagged: ${finding}`),
  ];
  return {
    name: REPLAY_CHECK,
    passed: left.length === 0,
    notes:
      left.length === 0
        ? `${files.length} files replayed, none flagged`
        : left.join('; '),
  };
}

function migrationFiles(hostWorkspace: string): string[] {
  try {
    return readdirSync(join(hostWorkspace, 'supabase', 'migrations'))
      .filter((entry) => /^\d+_.*\.sql$/.test(entry))
      .sort();
  } catch {
    return [];
  }
}

function replaySql(hostWorkspace: string, files: string[]): string {
  const replayed = files.map((file) => {
    const body = readFileSync(
      join(hostWorkspace, 'supabase', 'migrations', file),
      'utf8'
    )
      .split('\n')
      .filter((line) => !TRANSACTION_CONTROL.test(line))
      .join('\n');
    return `\\echo ${FILE_MARKER}${file}\n${body}\n;`;
  });
  return [
    'begin;',
    "set local lock_timeout = '10s';",
    "set local client_min_messages = 'warning';",
    'drop schema public cascade;',
    CLEAR_SEEDED_NAMES,
    'create schema public;',
    ...replayed,
    `\\echo ${REPLAYED_MARKER}`,
    `select json_build_object(
      'findings', (select coalesce(json_agg(finding), '[]') from (${UNINDEXED_FOREIGN_KEYS_SQL}) f),
      'problems', (select coalesce(json_agg(problem), '[]') from (${TABLE_KINDS_SQL}) t)
    );`,
    'rollback;',
  ].join('\n');
}

import { stripIndent } from 'common-tags';
import { leadingWord, unmaskedCommandSegments } from '../lib/detours.js';

export const FALLBACK_CHECK = 'no psql, client-library or API fallback';

export const FALLBACK_RUBRIC = stripIndent`
  The agent was asked to answer a data question about a local Supabase project's database with the Supabase CLI. You are given every shell command the agent actually executed, numbered in order. Judge only these commands, never the agent's report or commentary.

  Fail if any executed command reaches the database or its API by any route other than the Supabase CLI: psql, pg_dump, pgcli or usql at the database, including through docker exec into the database container; a node, deno, bun, python or ruby script that uses a Postgres driver or supabase-js; curl, wget or fetch against the REST, GraphQL, Studio or pg-meta endpoints; or installing such a client (npm add pg, pip install psycopg, apt-get install postgresql-client). An attempt counts even when it fails.

  These are not fallbacks and must not fail: probes of whether a tool exists ("which psql", "command -v psql", "psql --version"); readiness or connectivity probes that read no rows ("pg_isready", "nc -z" on the database port, a curl to a health or status endpoint or the API root); any supabase command, including supabase db query, supabase status and supabase start; reading project files; and processing saved supabase db query output with jq, awk or a script that opens no database connection. A request that selects, counts or returns table rows, such as "curl http://127.0.0.1:54321/rest/v1/customers?select=*", is still a fallback.

  If you fail the run, cite the offending command(s) in your notes.
`;

export function countPsqlCommands(commands: readonly string[]): number {
  return commands.filter((command) =>
    unmaskedCommandSegments(command).some(
      (segment) => leadingWord(segment) === 'psql'
    )
  ).length;
}

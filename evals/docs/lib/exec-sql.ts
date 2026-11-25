import type { LocalStackEvalContext } from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

export type SqlResult = { ok: boolean; stdout: string; message: string };

/**
 * Runs SQL as the superuser through psql. ctx.query wraps everything in a
 * SELECT, so writes and multi-statement scripts need this. `database` points
 * psql at another database on the same server. Never throws: a
 * failure comes back as { ok: false } with the database's error first.
 */
export async function execSql(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  sql: string,
  options: { tuplesOnly?: boolean; database?: string } = {}
): Promise<SqlResult> {
  // The name goes into a shell command, so it can't carry anything else.
  if (
    options.database !== undefined &&
    !/^[a-z0-9_]+$/.test(options.database)
  ) {
    return {
      ok: false,
      stdout: '',
      message: `bad database name: ${options.database}`,
    };
  }
  const target = options.database
    ? `"\${DB_URL%/*}/${options.database}"`
    : '"$DB_URL"';
  const encoded = Buffer.from(sql, 'utf8').toString('base64');
  const flags = options.tuplesOnly ? '-q -A -t' : '-q';
  try {
    const result = await ctx.exec(
      stripIndent`
        DB_URL=$(supabase status -o json 2>/dev/null | node -e 'let input = ""; process.stdin.on("data", data => input += data); process.stdin.on("end", () => console.log(JSON.parse(input).DB_URL));')
        echo ${encoded} | base64 -d | psql ${target} ${flags} -v ON_ERROR_STOP=1
      `,
      { timeoutMs: 120_000 }
    );
    const stdout = result.stdout ?? '';
    return result.exitCode === 0
      ? { ok: true, stdout, message: '' }
      : {
          ok: false,
          stdout,
          message: psqlError(`${result.stderr ?? ''}\n${stdout}`),
        };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, stdout: '', message: message.slice(0, 300) };
  }
}

const NOISE = [
  /^Stopped services:/,
  /^A new version of Supabase CLI/,
  /^We recommend updating regularly/,
];

/** The ERROR/DETAIL/HINT lines if there are any, else the first line. */
function psqlError(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !NOISE.some((noise) => noise.test(line)));
  const named = lines.filter((line) =>
    /^(ERROR|FATAL|DETAIL|HINT)\b/i.test(line)
  );
  const message = named.length > 0 ? named.join(' ') : lines[0];
  return (message ?? 'no output').slice(0, 300);
}

// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-003-answer-data-question
import { describe, expect, it } from 'vitest';
import {
  countPsqlCommands,
  FALLBACK_CHECK,
  FALLBACK_RUBRIC,
} from './fallback.js';

const paragraphs = (text: string) =>
  text.split(/\n\s*\n/).map((paragraph) => paragraph.replace(/\s+/g, ' '));

const NOT_A_FAILURE =
  /must not fail|do not fail|not (?:a |an )?(?:fallbacks?|failures?|violations?)\b/i;

describe('FALLBACK_CHECK', () => {
  it('is the name the scorer reports', () => {
    expect(FALLBACK_CHECK).toBe('no psql, client-library or API fallback');
  });
});

describe('countPsqlCommands', () => {
  it.each([
    [
      'psql with a connection string',
      'psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "select 1"',
    ],
    [
      'psql behind an environment prefix',
      'PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -c "select 1"',
    ],
    ['psql after a cd', 'cd /ws && psql "$DATABASE_URL" -c "select 1"'],
    ['psql by absolute path', '/usr/bin/psql -c "select 1"'],
    ['psql at the end of a pipe', `echo 'select 1' | psql "$DATABASE_URL"`],
    ['psql reading a heredoc', `psql "$DATABASE_URL" <<'EOF'\nselect 1;\nEOF`],
    ['psql behind a timeout', 'timeout 10 psql "$DATABASE_URL" -c "select 1"'],
    ['psql asked for its version', 'psql --version'],
  ])('counts %s', (_label, command) => {
    expect(countPsqlCommands([command])).toBe(1);
  });

  it.each([
    ['a which', 'which psql'],
    ['a command -v', 'command -v psql'],
    ['an echo that names it', 'echo psql'],
    ['a file named after it', 'cat notes-about-psql.md'],
    ['a grep for it', 'grep -rn psql supabase/'],
    ['a listing piped into grep for it', 'ls /usr/bin | grep psql'],
    [
      'a heredoc that mentions it',
      `cat > NOTES.md <<'EOF'\npsql is not installed\nEOF`,
    ],
    ['supabase db query', 'supabase db query "select 1"'],
    [
      'psql run inside the database container, since the command does not start with it',
      'docker exec supabase_db_x psql -U postgres -c "select 1"',
    ],
  ])('does not count %s', (_label, command) => {
    expect(countPsqlCommands([command])).toBe(0);
  });

  it('counts each command once, however many psql segments it holds', () => {
    expect(
      countPsqlCommands([
        'psql -c "select 1" && psql -c "select 2"',
        'ls',
        'psql -c "select 3"',
      ])
    ).toBe(2);
  });

  it('counts nothing for no commands', () => {
    expect(countPsqlCommands([])).toBe(0);
  });
});

describe('FALLBACK_RUBRIC', () => {
  it.each([
    ['psql', /\bpsql\b/],
    ['docker exec into the database container', /docker exec/i],
    ['a Postgres driver in a script', /Postgres(?:ql)? driver/i],
    ['supabase-js', /supabase-js/i],
    ['the REST endpoint', /\bREST\b/],
    ['installing a client', /install[^.]*client/i],
    ['attempts that fail', /attempt/i],
    ['citing the offending command', /cite/i],
  ])('names %s as a fallback', (_label, phrase) => {
    expect(FALLBACK_RUBRIC).toMatch(phrase);
  });

  it('says `which psql` and `psql --version` are not failures', () => {
    const [probes] = paragraphs(FALLBACK_RUBRIC).filter((paragraph) =>
      paragraph.includes('which psql')
    );
    expect(probes).toContain('psql --version');
    expect(probes).toMatch(NOT_A_FAILURE);
  });

  it('says any supabase command is not a failure', () => {
    const allowed = paragraphs(FALLBACK_RUBRIC).filter((paragraph) =>
      /any `?supabase`? command/i.test(paragraph)
    );
    expect(allowed.length).toBeGreaterThan(0);
    expect(allowed.some((paragraph) => NOT_A_FAILURE.test(paragraph))).toBe(
      true
    );
  });

  it.each([
    ['pg_isready', /\bpg_isready\b/],
    ['nc -z on the database port', /\bnc -z\b[^.]*database port/i],
    ['a curl to a health or status endpoint', /curl[^.]*health[^.]*status/i],
    ['a curl to the API root', /curl[^.]*API root/i],
  ])(
    'says %s is a probe that reads no rows and is not a failure',
    (_label, phrase) => {
      const [probes] = paragraphs(FALLBACK_RUBRIC).filter((paragraph) =>
        paragraph.includes('which psql')
      );
      expect(probes).toMatch(phrase);
      expect(probes).toMatch(/read no rows/i);
      expect(probes).toMatch(NOT_A_FAILURE);
    }
  );

  it('says a request that selects, counts or returns table rows is still a fallback', () => {
    const [probes] = paragraphs(FALLBACK_RUBRIC).filter((paragraph) =>
      paragraph.includes('which psql')
    );
    expect(probes).toMatch(/selects, counts or returns table rows/i);
    expect(probes).toContain('/rest/v1/customers?select=');
    expect(probes).toMatch(/still a fallback/i);
  });

  it('judges the executed commands only', () => {
    expect(FALLBACK_RUBRIC).toMatch(/executed/i);
  });
});

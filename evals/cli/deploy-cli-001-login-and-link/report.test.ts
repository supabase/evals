// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-cli-001-login-and-link
import { describe, expect, it } from 'vitest';
import { HOSTED_ABSENT, HOSTED_OK, HOSTED_REF, OTHER_REF } from './fixtures.js';
import { LINKED_CLI_PROBE, type WorkspaceLink } from './link.js';
import { describeGroundTruth } from './report.js';

type Facts = Parameters<typeof describeGroundTruth>;

const LINKED: WorkspaceLink = { ok: true, ref: HOSTED_REF };
const MISSING: WorkspaceLink = {
  ok: false,
  notes: 'supabase/.temp/project-ref is missing',
};
const PROBE_OK = { exitCode: 0, output: 'NAME  DIGEST' };
const PROBE_UNLINKED = {
  exitCode: 1,
  output: 'Cannot find project ref. Have you run supabase link?',
};
const CREDENTIALS = { tokenInEnvironment: true, persistedLogin: false };

const describe_ = (
  hosted: Facts[0],
  link: Facts[1],
  probe: Facts[2],
  credentials: Facts[3] = CREDENTIALS
) => describeGroundTruth(hosted, link, probe, credentials);

const lineFor = (lines: readonly string[], pattern: RegExp) =>
  lines.find((line) => pattern.test(line)) ?? '';

const TOKEN_LINE = /SUPABASE_ACCESS_TOKEN/;
const PERSISTED_LINE = /persisted/i;
const SAME_PROJECT_LINE = /is the hosted project/i;
const exitCodeOf = (code: number) =>
  new RegExp(`\\bexit\\w*\\D{0,12}\\b${code}\\b`, 'i');

describe('describeGroundTruth', () => {
  it('describes a run with no hosted project, no token and nothing linked', () => {
    const lines = describe_(
      HOSTED_ABSENT,
      MISSING,
      { exitCode: 1, output: 'Access token not provided.' },
      { tokenInEnvironment: false, persistedLogin: false }
    );
    const text = lines.join('\n');

    expect(text).toContain('CLI-2754');
    expect(lineFor(lines, TOKEN_LINE)).toMatch(/\bno\b/i);
    expect(lineFor(lines, TOKEN_LINE)).not.toMatch(/\byes\b/i);
    expect(lineFor(lines, PERSISTED_LINE)).toMatch(/absent/i);
    expect(text).toContain('supabase/.temp/project-ref is missing');
    expect(text).toContain(LINKED_CLI_PROBE);
    expect(text).toMatch(exitCodeOf(1));
    expect(text).toContain('Access token not provided.');
  });

  it('describes a run linked to the hosted project with a probe that exited 0', () => {
    const lines = describe_(HOSTED_OK, LINKED, PROBE_OK, {
      tokenInEnvironment: true,
      persistedLogin: true,
    });
    const text = lines.join('\n');

    expect(text).toContain(HOSTED_REF);
    expect(lineFor(lines, TOKEN_LINE)).toMatch(/\byes\b/i);
    expect(lineFor(lines, PERSISTED_LINE)).toMatch(/present/i);
    expect(lineFor(lines, SAME_PROJECT_LINE)).toMatch(/\byes\b/i);
    expect(text).toContain(LINKED_CLI_PROBE);
    expect(text).toMatch(exitCodeOf(0));
    expect(text).toContain('NAME  DIGEST');
  });

  it('says the linked project is not the hosted project when the refs differ', () => {
    const lines = describe_(
      HOSTED_OK,
      { ok: true, ref: OTHER_REF },
      PROBE_UNLINKED
    );
    const text = lines.join('\n');

    expect(text).toContain(HOSTED_REF);
    expect(text).toContain(OTHER_REF);
    expect(lineFor(lines, SAME_PROJECT_LINE)).toMatch(/\bno\b/i);
    expect(lineFor(lines, SAME_PROJECT_LINE)).not.toMatch(/\byes\b/i);
  });

  it('never says the linked project is the hosted project when no hosted project exists', () => {
    const lines = describe_(HOSTED_ABSENT, LINKED, PROBE_OK);

    expect(lineFor(lines, SAME_PROJECT_LINE)).not.toMatch(/\byes\b/i);
    expect(lines.join('\n')).toContain(HOSTED_REF);
  });

  it('states unknown for a token and a persisted login the harness could not probe', () => {
    const lines = describe_(HOSTED_OK, LINKED, PROBE_OK, {
      tokenInEnvironment: null,
      persistedLogin: null,
    });

    expect(lineFor(lines, TOKEN_LINE)).toMatch(/unknown/i);
    expect(lineFor(lines, PERSISTED_LINE)).toMatch(/unknown/i);
  });

  it('carries the reason the workspace has no usable link', () => {
    const lines = describe_(
      HOSTED_OK,
      {
        ok: false,
        notes: 'supabase/.temp/project-ref is empty',
      },
      PROBE_UNLINKED
    );

    expect(lines.join('\n')).toContain('supabase/.temp/project-ref is empty');
  });

  it('does not claim the probe exited 0 when it never ran', () => {
    const text = describe_(HOSTED_OK, LINKED, {
      exitCode: null,
      output: 'sandbox gone',
    }).join('\n');

    expect(text).toContain('sandbox gone');
    expect(text).not.toMatch(exitCodeOf(0));
  });

  it('keeps the full probe output without truncating it', () => {
    const longLine = `error: ${'unable to reach the management api; '.repeat(120)}`;
    const lastLine =
      'final line: Cannot find project ref. Have you run supabase link?';
    const text = describe_(HOSTED_OK, MISSING, {
      exitCode: 1,
      output: `${longLine}\nmiddle line\n${lastLine}`,
    }).join('\n');

    expect(longLine.length).toBeGreaterThan(2000);
    expect(text).toContain(longLine);
    expect(text).toContain('middle line');
    expect(text).toContain(lastLine);
  });
});

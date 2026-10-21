// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-auth-001-push-config-change
import { describe, expect, it } from 'vitest';
import { mentionsNumber } from '../lib/report.js';
import {
  FAKE_ACCESS_TOKEN,
  HOSTED_ABSENT,
  HOSTED_OK,
  HOSTED_REF,
} from './fixtures.js';
import { NO_HOSTED_PROJECT } from './hosted.js';
import { describeGroundTruth, maskAccessTokens } from './report.js';

type Facts = Parameters<typeof describeGroundTruth>;

const repoWith = (
  minPasswordLength: unknown,
  conflictingRemotes: { name: string; value: unknown }[] = []
): Facts[1] => ({ ok: true, minPasswordLength, conflictingRemotes });

const REPO_10 = repoWith(10);
const PROJECT_10: Facts[2] = { ok: true, minPasswordLength: 10 };
const NO_PROJECT: Facts[2] = { ok: false, notes: 'no hosted project to read' };

const lineFor = (lines: readonly string[], key: string) =>
  lines.find((line) => line.includes(key)) ?? '';

const repoLine = (lines: readonly string[]) =>
  lineFor(lines, 'minimum_password_length');
const projectLine = (lines: readonly string[]) =>
  lineFor(lines, 'password_min_length');

describe('describeGroundTruth', () => {
  it('names the hosted ref on a line that does not say none', () => {
    const lines = describeGroundTruth(HOSTED_OK, REPO_10, PROJECT_10);

    const hostedLine = lines.find((line) => line.includes(HOSTED_REF)) ?? '';
    expect(hostedLine).not.toBe('');
    expect(hostedLine).not.toContain('none');
  });

  it('says none, with the reason, when the run has no hosted project', () => {
    const lines = describeGroundTruth(HOSTED_ABSENT, REPO_10, NO_PROJECT);

    expect(
      lines.some(
        (line) => line.includes('none') && line.includes(NO_HOSTED_PROJECT)
      )
    ).toBe(true);
    expect(lines.join('\n')).not.toContain(HOSTED_REF);
  });

  it.each([10, 6, 8])('reports the repo length %i', (value) => {
    const lines = describeGroundTruth(HOSTED_OK, repoWith(value), PROJECT_10);

    expect(mentionsNumber(repoLine(lines), value)).toBe(true);
    expect(repoLine(lines)).not.toContain('not set');
  });

  it('says not set when the repo config has no auth.minimum_password_length', () => {
    const lines = describeGroundTruth(
      HOSTED_OK,
      repoWith(undefined),
      PROJECT_10
    );

    expect(repoLine(lines)).toContain('not set');
  });

  it('carries the reason the repo config could not be read', () => {
    const lines = describeGroundTruth(
      HOSTED_OK,
      { ok: false, notes: 'supabase/config.toml is missing' },
      PROJECT_10
    );

    expect(repoLine(lines)).toContain('supabase/config.toml is missing');
  });

  it('shows a non-numeric repo value as the quoted string it is', () => {
    const lines = describeGroundTruth(HOSTED_OK, repoWith('10'), PROJECT_10);

    expect(repoLine(lines)).toContain('"10"');
  });

  it.each([Infinity, -Infinity, NaN])(
    'shows the non-finite repo number %s as itself, not as null',
    (value) => {
      const lines = describeGroundTruth(HOSTED_OK, repoWith(value), PROJECT_10);

      expect(repoLine(lines)).toContain(String(value));
      expect(repoLine(lines)).not.toContain('null');
    }
  );

  it.each([10, 6])('reports the project password_min_length %i', (value) => {
    const lines = describeGroundTruth(HOSTED_OK, REPO_10, {
      ok: true,
      minPasswordLength: value,
    });

    expect(mentionsNumber(projectLine(lines), value)).toBe(true);
    expect(projectLine(lines)).not.toContain('unavailable');
  });

  it('does not report a project length for a project with no minimum', () => {
    const lines = describeGroundTruth(HOSTED_OK, REPO_10, {
      ok: true,
      minPasswordLength: null,
    });

    expect(projectLine(lines)).not.toContain('unavailable');
    expect(projectLine(lines)).toMatch(/null|not set/);
  });

  it('says unavailable, with the reason, when the project could not be read', () => {
    const lines = describeGroundTruth(HOSTED_OK, REPO_10, {
      ok: false,
      notes: 'could not read the auth config: status 401',
    });

    expect(projectLine(lines)).toContain('unavailable');
    expect(projectLine(lines)).toContain(
      'could not read the auth config: status 401'
    );
  });

  it('adds the conflicting [remotes.<name>] overrides to the repo line', () => {
    const lines = describeGroundTruth(
      HOSTED_OK,
      repoWith(10, [
        { name: 'prod', value: 6 },
        { name: 'staging', value: '8' },
      ]),
      PROJECT_10
    );

    expect(repoLine(lines)).toBe(
      '- repo supabase/config.toml auth.minimum_password_length: 10 ([remotes.prod] overrides it with 6; [remotes.staging] overrides it with "8")'
    );
  });

  it('adds the overrides after not set when the base value is missing', () => {
    const lines = describeGroundTruth(
      HOSTED_OK,
      repoWith(undefined, [{ name: 'prod', value: 6 }]),
      PROJECT_10
    );

    expect(repoLine(lines)).toBe(
      '- repo supabase/config.toml auth.minimum_password_length: not set ([remotes.prod] overrides it with 6)'
    );
  });

  it('leaves the repo line without an overrides suffix when none conflict', () => {
    const lines = describeGroundTruth(HOSTED_OK, REPO_10, PROJECT_10);

    expect(repoLine(lines)).toBe(
      '- repo supabase/config.toml auth.minimum_password_length: 10'
    );
  });

  it('keeps the repo and project lengths on their own lines when they differ', () => {
    const lines = describeGroundTruth(HOSTED_OK, repoWith(8), {
      ok: true,
      minPasswordLength: 6,
    });

    expect(mentionsNumber(repoLine(lines), 8)).toBe(true);
    expect(mentionsNumber(repoLine(lines), 6)).toBe(false);
    expect(mentionsNumber(projectLine(lines), 6)).toBe(true);
    expect(mentionsNumber(projectLine(lines), 8)).toBe(false);
  });
});

describe('maskAccessTokens', () => {
  const MASK = '[redacted access token]';

  it('masks a token typed into a command', () => {
    expect(
      maskAccessTokens(`supabase login --token ${FAKE_ACCESS_TOKEN}`)
    ).toBe(`supabase login --token ${MASK}`);
  });

  it('masks a token printed after an environment variable name', () => {
    expect(
      maskAccessTokens(`SUPABASE_ACCESS_TOKEN=${FAKE_ACCESS_TOKEN}\nHOME=/root`)
    ).toBe(`SUPABASE_ACCESS_TOKEN=${MASK}\nHOME=/root`);
  });

  it.each([
    ['sbp_', `sbp_${'a'.repeat(40)}`],
    ['sbp_oauth_', `sbp_oauth_${'b'.repeat(40)}`],
    ['sbp_v0_', `sbp_v0_${'0123456789abcdef'.repeat(3).slice(0, 40)}`],
  ])('masks a token with the %s prefix', (_, token) => {
    const masked = maskAccessTokens(`token: ${token}.`);

    expect(masked).toBe(`token: ${MASK}.`);
    expect(masked).not.toContain(token);
  });

  it('masks every token in the text', () => {
    const masked = maskAccessTokens(
      `${FAKE_ACCESS_TOKEN} and ${FAKE_ACCESS_TOKEN.replace('e', 'f')} in "${FAKE_ACCESS_TOKEN}"`
    );

    expect(masked).toBe(`${MASK} and ${MASK} in "${MASK}"`);
  });

  it.each([
    ['too short', `sbp_${'e'.repeat(39)}`],
    ['not hexadecimal', `sbp_${'g'.repeat(40)}`],
    ['a different prefix', `sbx_${'e'.repeat(40)}`],
  ])('leaves a string alone when it is %s', (_, text) => {
    expect(maskAccessTokens(text)).toBe(text);
  });

  it('leaves text without a token untouched', () => {
    const text = `supabase config push --project-ref ${HOSTED_REF} --yes`;

    expect(maskAccessTokens(text)).toBe(text);
  });
});

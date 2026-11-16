import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (dir: string, file: string) =>
  readFileSync(new URL(`../${dir}/local/${file}`, import.meta.url), 'utf8');

const TOML = [
  'build-cli-005-edit-config-toml',
  'build-cli-006-edit-config-toml-validate',
];
const JSONC = [
  'build-cli-007-edit-config-jsonc',
  'build-cli-008-edit-config-jsonc-validate',
];
const VALIDATE_LINE =
  '- After changing the Supabase config, run `supabase config validate` and fix anything it reports before handing back.\n';

describe('config-edit seeds', () => {
  it.each([
    [TOML, 'supabase/config.toml'],
    [JSONC, 'supabase/config.jsonc'],
  ])('keeps the config byte-identical across %j', (dirs, file) => {
    expect(read(dirs[0], file)).toBe(read(dirs[1], file));
  });

  it.each([[TOML], [JSONC]])(
    'adds only the validate line to AGENTS.md in %j',
    ([plain, validate]) => {
      expect(read(validate, 'AGENTS.md')).toBe(
        read(plain, 'AGENTS.md') + VALIDATE_LINE
      );
    }
  );

  it('shares the support files across all four evals', () => {
    const all = [...TOML, ...JSONC];
    for (const file of ['.gitignore', 'supabase/.env']) {
      for (const dir of all) expect(read(dir, file)).toBe(read(all[0], file));
    }
  });

  it('shares one prompt across all four evals', () => {
    const prompt = (dir: string) =>
      readFileSync(new URL(`../${dir}/PROMPT.md`, import.meta.url), 'utf8');
    for (const dir of [...TOML, ...JSONC]) {
      expect(prompt(dir)).toBe(prompt(TOML[0]));
    }
  });
});

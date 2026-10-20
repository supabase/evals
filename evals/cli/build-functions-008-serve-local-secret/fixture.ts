import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FUNCTION_NAME = 'nightly-digest';

export const SECRET_HEADER = 'x-digest-secret';

export const SECRET_NAME = 'DIGEST_SECRET';

/** The seeded value, read from local/.env at module load. */
export const DIGEST_SECRET = readDigestSecret();

/** The seeded secret with one character changed, so a check on its shape, prefix or length can't tell the two apart. */
export const WRONG_SECRET = changeLastCharacter(DIGEST_SECRET);

function readDigestSecret(): string {
  const seed = fileURLToPath(new URL('./local/.env', import.meta.url));
  const match = /^DIGEST_SECRET=(.+)$/m.exec(readFileSync(seed, 'utf8'));
  if (!match) {
    throw new Error('could not read DIGEST_SECRET from local/.env');
  }
  return match[1].trim();
}

function changeLastCharacter(value: string): string {
  return `${value.slice(0, -1)}${value.endsWith('0') ? '1' : '0'}`;
}

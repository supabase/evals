import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The endpoint the seed names as the team's existing contract. */
export const FUNCTION = 'suggest';

/** The failure the seed's contract requires when the credential is missing. */
export const MISSING_KEY_MARKER = 'missing_api_key';

/**
 * Read the provider key out of the seed rather than repeating it here, so
 * rotating the fixture cannot leave every check hunting a value the seeded app
 * never carried.
 */
export const PROVIDER_KEY = readProviderKey();

function readProviderKey(): string {
  const seed = fileURLToPath(new URL('./local/src/App.tsx', import.meta.url));
  const match = /const OPENAI_API_KEY = '([^']+)'/.exec(
    readFileSync(seed, 'utf8')
  );
  if (!match) {
    throw new Error(
      'could not read the seeded provider key from local/src/App.tsx'
    );
  }
  return match[1];
}

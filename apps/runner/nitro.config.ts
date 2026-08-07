import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineNitroConfig } from 'nitro/config';

const rootDotenvPath = fileURLToPath(new URL('../../.env', import.meta.url));

if (existsSync(rootDotenvPath)) {
  process.loadEnvFile(rootDotenvPath);
}

export default defineNitroConfig({
  modules: ['workflow/nitro'],
  ignore: ['**/*.test.*'],
});

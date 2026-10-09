import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'platform-lite',
    environment: 'node',
    testTimeout: 30000,
  },
});

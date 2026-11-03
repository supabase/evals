import { expect, it, vi } from 'vitest';
import { hostedDataRuntime } from '../src/hosted-data-runtime.js';

vi.mock('../src/agent-environment.js', () => ({
  createAgentEnvironment: vi.fn(() => {
    throw new Error(
      'must not create a local environment without a hosted target'
    );
  }),
}));

it('rejects missing hosted connection settings', async () => {
  await expect(
    hostedDataRuntime().startSession({ agent: 'codex' })
  ).rejects.toThrow('requires a hosted project with connection settings');
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareRecovery, samples } from './prepare-braintrust-recovery.js';

describe('recovery', () => {
  it('rejects incomplete and duplicate sample sets', () => {
    const rows = [1, 2, 3].map((run) => ({
      suite: 'benchmark',
      experiment: 'one',
      eval: 'example',
      run,
      passed: true,
    }));
    expect(samples(rows, 3).size).toBe(3);
    expect(() => samples(rows.slice(0, 2), 3)).toThrow('incomplete');
    expect(() => samples([...rows, rows[0]], 3)).toThrow('Duplicate');
  });

  it('skips complete experiments and rejects partial results', async () => {
    const original = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'eval-recovery-'));
    try {
      process.chdir(dir);
      const ids = [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
      ];
      const experiments = ['complete', 'empty'].map((name, index) => ({
        id: ids[index],
        metadata: {
          suite: 'benchmark',
          experiment: name,
          expected_runs: 3,
          ci_run_url: 'https://github.com/org/repo/actions/runs/123',
        },
      }));
      for (const name of ['complete', 'empty'])
        for (const run of [1, 2, 3]) {
          const path = `recovery-artifact/raw-results-benchmark__${name}__example/example/run-${run}`;
          mkdirSync(path, { recursive: true });
          writeFileSync(
            `${path}/result.json`,
            JSON.stringify({
              suite: 'benchmark',
              experiment: name,
              eval: 'example',
              run,
              passed: true,
            })
          );
        }
      const roots = [1, 2, 3].map((run) => ({
        eval: 'example',
        run,
        passed: 1,
      }));
      const request: typeof fetch = vi.fn(async (input, init) => {
        const url = String(input);
        if (!init?.body)
          return Response.json({
            objects: url.includes('starting_after') ? [] : experiments,
          });
        const body = JSON.parse(String(init.body));
        return Response.json({
          data: body.query.includes(ids[0]) ? roots : [],
        });
      });
      const env = {
        RECOVERY_RUN_ID: '123',
        BRAINTRUST_API_KEY: 'test',
        BRAINTRUST_PROJECT_ID: 'project',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'org/repo',
      };
      expect(await prepareRecovery(env, request)).toEqual([
        `benchmark\tempty\t${ids[1]}\t3\t3`,
      ]);
      roots.pop();
      await expect(prepareRecovery(env, request)).rejects.toThrow(
        'partial or conflicting'
      );
    } finally {
      process.chdir(original);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

afterEach(() => vi.restoreAllMocks());

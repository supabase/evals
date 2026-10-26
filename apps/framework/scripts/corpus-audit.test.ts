import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { perEvalTable, readRuns, summarize } from './corpus-audit.js';

function writeRun(
  dir: string,
  experiment: string,
  evalId: string,
  passed: boolean,
  sources: string[] = []
) {
  const runDir = join(dir, experiment, evalId, 'run-1');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'result.json'),
    JSON.stringify({
      passed,
      docs: { calls: sources.map((source) => ({ source })) },
    })
  );
}

describe('corpus audit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-audit-'));
  const none = 'claude-code-sonnet-5-corpus-none';
  writeRun(dir, none, 'a', true);
  writeRun(dir, none, 'b', false, ['shell_fetch', 'shell_fetch']);
  const runs = readRuns(dir, none);

  it('counts runs with any violating call once', () => {
    const lines = summarize(runs, none).join('\n');
    expect(lines).toContain('pass rate: 1/2 (50%)');
    expect(lines).toContain('violations (runs with any web or docs call): 1');
    expect(lines).toContain('shell_fetch: 1');
  });

  it('splits pass rates by the none map', () => {
    const lines = summarize(runs, none, { a: 'known', b: 'unknown' }).join(
      '\n'
    );
    expect(lines).toContain('none-map known: 1/1 (100%)');
    expect(lines).toContain('none-map unknown: 0/1 (0%)');
  });

  it('builds a per-eval table', () => {
    expect(perEvalTable(runs).join('\n')).toContain('a');
  });
});

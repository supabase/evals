import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExperimentExportMetadata } from './export-results.js';
import { readResultFile } from './export-results.js';

// build-docs-010-edge-function-auth is the one eval whose PROMPT.md pins
// `cliVersion: 2.109.1`, needed here to exercise the frontmatter side of the
// precedence.
const PINNED_EVAL_ID = 'build-docs-010-edge-function-auth';

describe('readResultFile cliVersion precedence', () => {
  const experimentMetadata = new Map<string, ExperimentExportMetadata>();

  const writeRawResult = (dir: string, raw: Record<string, unknown>) => {
    const filePath = join(dir, 'result.json');
    writeFileSync(filePath, JSON.stringify(raw));
    return filePath;
  };

  it('carries the run value that actually ran over the frontmatter pin', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'export-results-test-'));
    try {
      const filePath = writeRawResult(temporary, {
        experiment: 'test-experiment',
        eval: PINNED_EVAL_ID,
        interface: 'cli',
        cliVersion: '2.118.0-beta.60',
      });

      const result = await readResultFile(
        filePath,
        'test-experiment/run-1/result.json',
        experimentMetadata
      );

      expect(result?.cliVersion).toBe('2.118.0-beta.60');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('falls back to the frontmatter pin when the run recorded no version', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'export-results-test-'));
    try {
      const filePath = writeRawResult(temporary, {
        experiment: 'test-experiment',
        eval: PINNED_EVAL_ID,
        interface: 'cli',
      });

      const result = await readResultFile(
        filePath,
        'test-experiment/run-1/result.json',
        experimentMetadata
      );

      expect(result?.cliVersion).toBe('2.109.1');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

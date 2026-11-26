import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  collectRawResultEvidence,
  readRawResultSource,
  readTgzEntries,
} from './raw-eval-artifacts.mjs';

describe('raw eval artifact reader', () => {
  it('selects a success transcript and each distinct failed check shape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raw-results-'));
    await writeResult(
      root,
      'exp-success',
      'run-1',
      resultJson({
        experiment: 'exp-success',
        passed: true,
        checks: [{ name: 'everything passed', passed: true }],
        transcriptText:
          'final success transcript with token=super-secret-token',
      })
    );
    await writeResult(
      root,
      'exp-fail-stack',
      'run-1',
      resultJson({
        experiment: 'exp-fail-stack',
        passed: false,
        checks: [
          {
            name: 'stack is running',
            passed: false,
            notes: 'no stack running',
          },
          {
            name: 'explains the runtime outcome truthfully',
            passed: true,
            judgeNotes: 'truthful',
          },
        ],
        transcriptText: 'stack failed',
      })
    );
    await writeResult(
      root,
      'exp-fail-report',
      'run-1',
      resultJson({
        experiment: 'exp-fail-report',
        passed: false,
        checks: [
          {
            name: 'explains the runtime outcome truthfully',
            passed: false,
            judgeNotes: 'claimed Docker was still pulling images',
          },
        ],
        transcriptText: 'false report failed',
      })
    );

    const evidence = await collectRawResultEvidence({
      runs: [
        {
          id: 123,
          headSha: 'head-sha',
          sourceRevision: {
            runHeadSha: 'run-sha',
            currentPrHeadSha: 'head-sha',
            kind: 'stale-descendant-with-source-changes',
            current: false,
            explanation: 'stale on purpose',
          },
          artifacts: [{ name: 'raw-results', expired: false }],
          evidenceLinks: {
            status: 'collected',
            braintrustLinks: ['https://www.braintrust.dev/app/trace/unread'],
            braintrustAllExperimentsLinks: [],
          },
        },
      ],
      changedEvals: [
        { suite: 'cli', id: 'eval-a', paths: ['evals/cli/eval-a/EVAL.ts'] },
      ],
      rawArtifactDirs: [root],
      env: { TEST_SECRET: 'super-secret-token' },
    });

    expect(evidence.status).toBe('collected');
    expect(evidence.results.filter((result) => result.passed)).toHaveLength(1);
    expect(
      evidence.failedCheckShapes.map((shape) => shape.failedCheckNames)
    ).toEqual(
      expect.arrayContaining([
        ['stack is running'],
        ['explains the runtime outcome truthfully'],
      ])
    );
    expect(
      evidence.failedCheckShapes.some(
        (shape) => shape.failedCheckNames.length === 0
      )
    ).toBe(false);
    expect(JSON.stringify(evidence)).not.toContain('super-secret-token');
    expect(evidence.results[0].source.sourceRevision).toMatchObject({
      kind: 'stale-descendant-with-source-changes',
      current: false,
    });
  });

  it('rejects unsafe tgz paths without extracting archive contents', () => {
    const limitations = [];
    const entries = readTgzEntries(
      makeTgz([
        ['../evil/result.json', '{}'],
        [
          'safe/eval/run-1/result.json',
          JSON.stringify(resultJson({ passed: true })),
        ],
      ]),
      undefined,
      limitations
    );

    expect(entries.map((entry) => entry.path)).toEqual([
      'safe/eval/run-1/result.json',
    ]);
    expect(limitations).toContainEqual(
      expect.objectContaining({
        type: 'unsafe-archive-entry',
      })
    );
  });

  it('rejects unsafe zip paths while keeping safe result.json entries', async () => {
    const limitations = [];
    const zip = makeStoredZip([
      ['../evil/result.json', '{}'],
      [
        'safe/eval/run-1/result.json',
        JSON.stringify(resultJson({ passed: true })),
      ],
    ]);
    const result = await readRawResultSource({
      source: { type: 'github-artifact-zip', runId: 456, headSha: 'head-sha' },
      buffer: zip,
      changedEvalIds: new Set(['eval-a']),
      limitations,
    });

    expect(result.results.map((entry) => entry.resultPath)).toEqual([
      'safe/eval/run-1/result.json',
    ]);
    expect(result.limitations).toContainEqual(
      expect.objectContaining({
        type: 'unsafe-archive-entry',
      })
    );
  });
});

async function writeResult(root, experiment, runName, json) {
  const dir = join(
    root,
    `raw-results-${experiment}__eval-a`,
    'eval-a',
    runName
  );
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'result.json'),
    `${JSON.stringify(json, null, 2)}\n`
  );
}

function resultJson({
  experiment = 'exp',
  passed = true,
  checks = [{ name: 'ok', passed: true }],
  transcriptText = 'done',
} = {}) {
  return {
    experiment,
    experimentSuite: 'cli',
    eval: 'eval-a',
    run: 1,
    passed,
    checks,
    toolCalls: [
      {
        name: 'shell',
        command: 'echo ok',
        result: 'ok',
      },
    ],
    transcript: [
      {
        type: 'message',
        role: 'assistant',
        content: transcriptText,
      },
    ],
    agentReport: transcriptText,
  };
}

function makeTgz(entries) {
  return gzipSync(
    Buffer.concat([
      ...entries.map(([name, value]) => tarEntry(name, value)),
      Buffer.alloc(1024),
    ])
  );
}

function tarEntry(name, value) {
  const data = Buffer.from(value);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000777\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(
    data.length.toString(8).padStart(11, '0') + '\0',
    124,
    12,
    'ascii'
  );
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(' ', 148, 156);
  header.write('0', 156, 1, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const padding = Buffer.alloc(
    Math.ceil(data.length / 512) * 512 - data.length
  );
  return Buffer.concat([header, data, padding]);
}

function makeStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(value);
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    nameBuffer.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuffer.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

#!/usr/bin/env tsx
/**
 * Hand-editable golden table → generated code. The golden mapping (which
 * skills should fire on which prompt) is a judgment call, not something to
 * infer automatically — so the source of truth is a TSV anyone can open in a
 * spreadsheet/editor and tick 1/0 in, not a hand-typed TS literal array.
 *
 * Reads evals/trigger/golden-<suite>.tsv:
 *   idx  sourceEval  category  <skill1>  <skill2>  ...
 * (one column per skill in the closed set; 1 = expected, 0 = not expected)
 *
 * Writes evals/trigger/golden-<suite>.ts with the same `GoldenEntry[]` shape
 * the rest of the pipeline (gen-*-evals.ts, trigger-report.ts) already
 * consumes — editing the TSV and re-running this is the whole workflow.
 *
 *   cd apps/framework && node --import tsx/esm scripts/build-golden.ts <suite>
 *   e.g. node --import tsx/esm scripts/build-golden.ts triage
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');
const TRIGGER_DIR = join(ROOT, 'evals', 'trigger');

const suite = process.argv[2];
if (!suite) {
  console.error(
    'usage: build-golden.ts <suite>  (reads evals/trigger/golden-<suite>.tsv)'
  );
  process.exit(1);
}

const tsvPath = join(TRIGGER_DIR, `golden-${suite}.tsv`);
const rows = readFileSync(tsvPath, 'utf8').trim().split('\n');
const header = rows[0].split('\t');
const FIXED_COLS = ['idx', 'sourceEval', 'category'];
const skillCols = header.slice(FIXED_COLS.length);
if (header.slice(0, FIXED_COLS.length).join(',') !== FIXED_COLS.join(',')) {
  throw new Error(
    `${tsvPath}: expected header to start with ${FIXED_COLS.join('\\t')}`
  );
}

type Entry = {
  promptIndex: number;
  category: string;
  expectedSkills: string[];
  sourceEval: string;
};

const entries: Entry[] = rows.slice(1).map((line, i) => {
  const cols = line.split('\t');
  if (cols.length !== header.length) {
    throw new Error(
      `${tsvPath}:${i + 2}: expected ${header.length} columns, got ${cols.length}`
    );
  }
  const [idxStr, sourceEval, category, ...flags] = cols;
  const promptIndex = Number(idxStr);
  if (promptIndex !== i) {
    throw new Error(
      `${tsvPath}:${i + 2}: idx=${idxStr}, expected ${i} (rows must be in order, 0-based)`
    );
  }
  const expectedSkills = skillCols.filter((_, j) => {
    const v = flags[j]?.trim();
    if (v !== '0' && v !== '1') {
      throw new Error(
        `${tsvPath}:${i + 2}: column "${skillCols[j]}" must be 0 or 1, got "${flags[j]}"`
      );
    }
    return v === '1';
  });
  return { promptIndex, category, expectedSkills, sourceEval };
});

const varName = `golden${suite[0].toUpperCase()}${suite.slice(1)}`;
const lines = [
  '/**',
  ` * GENERATED from golden-${suite}.tsv by build-golden.ts — do not hand-edit.`,
  ' * To change an expectation: edit the TSV (1/0 per skill column), then run:',
  ` *   cd apps/framework && node --import tsx/esm scripts/build-golden.ts ${suite}`,
  ' */',
  "import type { Category } from './prompts.js';",
  "import type { GoldenEntry } from './golden.js';",
  '',
  `export const ${suite.toUpperCase()}_SKILLS = [${skillCols.map((s) => `'${s}'`).join(', ')}] as const;`,
  '',
  `export const ${varName}: GoldenEntry[] = [`,
  ...entries.map(
    (e) =>
      `  { promptIndex: ${e.promptIndex}, category: ${JSON.stringify(e.category)} as Category, expectedSkills: [${e.expectedSkills.map((s) => `'${s}'`).join(', ')}], sourceEval: ${JSON.stringify(e.sourceEval)} },`
  ),
  '];',
  '',
];

const outPath = join(TRIGGER_DIR, `golden-${suite}.ts`);
writeFileSync(outPath, lines.join('\n'));

const counts = skillCols.map(
  (s) => `${s}=${entries.filter((e) => e.expectedSkills.includes(s)).length}`
);
console.log(
  `wrote ${entries.length} entries to golden-${suite}.ts (${counts.join(', ')})`
);

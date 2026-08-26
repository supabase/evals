import { describe, expect, it } from 'vitest';

import { splitBySampleSetCompleteness } from './sample-sets.js';

const row = (experiment: string, evalId: string, run?: number) => ({
  experiment,
  eval: evalId,
  run,
});

describe('splitBySampleSetCompleteness', () => {
  it('keeps a pair with every requested run', () => {
    const rows = [1, 2, 3].map((run) => row('model-a', 'eval-1', run));

    expect(splitBySampleSetCompleteness(rows, 3)).toEqual({
      complete: rows,
      incomplete: [],
    });
  });

  it('drops a pair missing a run', () => {
    const rows = [1, 2].map((run) => row('model-a', 'eval-1', run));

    expect(splitBySampleSetCompleteness(rows, 3)).toEqual({
      complete: [],
      incomplete: [{ key: 'model-a::eval-1', runs: 2 }],
    });
  });

  it('drops a pair carrying more runs than requested', () => {
    const rows = [1, 2, 3, 4].map((run) => row('model-a', 'eval-1', run));

    expect(splitBySampleSetCompleteness(rows, 3)).toEqual({
      complete: [],
      incomplete: [{ key: 'model-a::eval-1', runs: 4 }],
    });
  });

  it('drops a pair when an out-of-range run masks a missing run', () => {
    const rows = [1, 2, 4].map((run) => row('model-a', 'eval-1', run));

    expect(splitBySampleSetCompleteness(rows, 3)).toEqual({
      complete: [],
      incomplete: [{ key: 'model-a::eval-1', runs: 3 }],
    });
  });

  it('drops a pair when a duplicate run masks a missing run', () => {
    const rows = [1, 2, 2].map((run) => row('model-a', 'eval-1', run));

    expect(splitBySampleSetCompleteness(rows, 3)).toEqual({
      complete: [],
      incomplete: [{ key: 'model-a::eval-1', runs: 3 }],
    });
  });

  it('drops only the offending pairs and keeps the complete ones', () => {
    const complete = [1, 2, 3].map((run) => row('model-a', 'eval-1', run));
    const short = [row('model-b', 'eval-1', 1)];
    const alsoShort = [1, 2].map((run) => row('model-b', 'eval-2', run));

    expect(
      splitBySampleSetCompleteness([...complete, ...short, ...alsoShort], 3)
    ).toEqual({
      complete,
      incomplete: [
        { key: 'model-b::eval-1', runs: 1 },
        { key: 'model-b::eval-2', runs: 2 },
      ],
    });
  });

  it('counts a legacy row without a run index as one sample', () => {
    expect(splitBySampleSetCompleteness([row('model-a', 'eval-1')], 3)).toEqual(
      {
        complete: [],
        incomplete: [{ key: 'model-a::eval-1', runs: 1 }],
      }
    );
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { improvesPrintTimePlan, type PrintTimePlan } from '../printTimeArrange';

test('a tiny reduction in total print height cannot justify an extra plate', () => {
  const heights = new Map([['tall', 100], ['short', 99.9], ['lowA', 49.9], ['lowB', 49.9]]);
  const baseline: PrintTimePlan = {
    plateCount: 2,
    unplacedCount: 0,
    passes: [
      { plateId: null, modelIds: ['tall', 'lowA'] },
      { plateId: null, modelIds: ['short', 'lowB'] },
    ],
  };
  const candidate: PrintTimePlan = {
    plateCount: 3,
    unplacedCount: 0,
    passes: [
      { plateId: null, modelIds: ['tall', 'short'] },
      { plateId: null, modelIds: ['lowA'] },
      { plateId: null, modelIds: ['lowB'] },
    ],
  };

  assert.equal(improvesPrintTimePlan(candidate, baseline, heights, new Map()), false);
});

test('fewer plates and lower print height cannot justify leaving more models unplaced', () => {
  const heights = new Map([['tall', 100], ['short', 10]]);
  const baseline: PrintTimePlan = {
    plateCount: 2,
    unplacedCount: 0,
    passes: [
      { plateId: null, modelIds: ['tall'] },
      { plateId: null, modelIds: ['short'] },
    ],
  };
  const candidate: PrintTimePlan = {
    plateCount: 1,
    unplacedCount: 1,
    passes: [{ plateId: null, modelIds: ['short'] }],
  };

  assert.equal(improvesPrintTimePlan(candidate, baseline, heights, new Map()), false);
  assert.equal(improvesPrintTimePlan(baseline, candidate, heights, new Map()), false);
});

test('fewer plates are preferred when no more models are unplaced', () => {
  const heights = new Map([['tall', 100], ['short', 10]]);
  const baseline: PrintTimePlan = {
    plateCount: 2,
    unplacedCount: 0,
    passes: [
      { plateId: null, modelIds: ['tall'] },
      { plateId: null, modelIds: ['short'] },
    ],
  };
  const candidate: PrintTimePlan = {
    plateCount: 1,
    unplacedCount: 0,
    passes: [{ plateId: null, modelIds: ['tall', 'short'] }],
  };

  assert.equal(improvesPrintTimePlan(candidate, baseline, heights, new Map()), true);
});

test('placing more models is preferred even when total print height increases', () => {
  const heights = new Map([['tall', 100], ['short', 10]]);
  const baseline: PrintTimePlan = {
    plateCount: 1,
    unplacedCount: 1,
    passes: [{ plateId: null, modelIds: ['short'] }],
  };
  const candidate: PrintTimePlan = {
    plateCount: 1,
    unplacedCount: 0,
    passes: [{ plateId: null, modelIds: ['tall', 'short'] }],
  };

  assert.equal(improvesPrintTimePlan(candidate, baseline, heights, new Map()), true);
});

test('segregating tall and short models lowers the sum of plate maxima', () => {
  const heights = new Map([['tallA', 100], ['tallB', 90], ['shortA', 10], ['shortB', 5]]);
  const baseline: PrintTimePlan = {
    plateCount: 2,
    unplacedCount: 0,
    passes: [
      { plateId: null, modelIds: ['tallA', 'shortA'] },
      { plateId: null, modelIds: ['tallB', 'shortB'] },
    ],
  };
  const candidate: PrintTimePlan = {
    plateCount: 2,
    unplacedCount: 0,
    passes: [
      { plateId: null, modelIds: ['tallA', 'tallB'] },
      { plateId: null, modelIds: ['shortA', 'shortB'] },
    ],
  };

  assert.equal(improvesPrintTimePlan(candidate, baseline, heights, new Map()), true);
  assert.equal(improvesPrintTimePlan(baseline, candidate, heights, new Map()), false);
});

test('uneven height ranges beat prettier ranges when their sum of maxima is lower', () => {
  const heights = new Map([['a', 100], ['b', 90], ['c', 80], ['d', 70]]);
  const baseline: PrintTimePlan = {
    plateCount: 2,
    unplacedCount: 0,
    passes: [
      { plateId: null, modelIds: ['a', 'b'] },
      { plateId: null, modelIds: ['c', 'd'] },
    ],
  };
  const candidate: PrintTimePlan = {
    plateCount: 2,
    unplacedCount: 0,
    passes: [
      { plateId: null, modelIds: ['a', 'b', 'c'] },
      { plateId: null, modelIds: ['d'] },
    ],
  };

  assert.equal(improvesPrintTimePlan(candidate, baseline, heights, new Map()), true);
});

test('fixed occupants count even on plates with no arrangement pass', () => {
  const heights = new Map([['model', 60]]);
  const fixed = new Map([['tallPlate', 100], ['shortPlate', 20]]);
  const baseline: PrintTimePlan = {
    plateCount: 2,
    unplacedCount: 0,
    passes: [{ plateId: 'shortPlate', modelIds: ['model'] }],
  };
  const candidate: PrintTimePlan = {
    plateCount: 2,
    unplacedCount: 0,
    passes: [{ plateId: 'tallPlate', modelIds: ['model'] }],
  };

  assert.equal(improvesPrintTimePlan(candidate, baseline, heights, fixed), true);
  assert.equal(improvesPrintTimePlan(baseline, candidate, heights, fixed), false);
});

test('multiple rectangle passes on an existing plate contribute one fixed-inclusive maximum', () => {
  const heights = new Map([['tall', 90], ['medium', 80], ['short', 10]]);
  const fixed = new Map([['a', 100]]);
  const baseline: PrintTimePlan = {
    plateCount: 2,
    unplacedCount: 0,
    passes: [
      { plateId: 'a', modelIds: ['tall'] },
      { plateId: 'b', modelIds: ['medium', 'short'] },
    ],
  };
  const candidate: PrintTimePlan = {
    plateCount: 2,
    unplacedCount: 0,
    passes: [
      { plateId: 'a', modelIds: ['tall'] },
      { plateId: 'b', modelIds: ['short'] },
      { plateId: 'a', modelIds: ['medium'] },
    ],
  };

  assert.equal(improvesPrintTimePlan(candidate, baseline, heights, fixed), true);
});

test('each null plate ID represents a distinct new printing plate', () => {
  const heights = new Map([['tall', 90], ['short', 80]]);
  const baseline: PrintTimePlan = {
    plateCount: 2,
    unplacedCount: 0,
    passes: [
      { plateId: 'a', modelIds: ['tall'] },
      { plateId: 'b', modelIds: ['short'] },
    ],
  };
  const candidate: PrintTimePlan = {
    plateCount: 2,
    unplacedCount: 0,
    passes: [
      { plateId: null, modelIds: ['tall'] },
      { plateId: null, modelIds: ['short'] },
    ],
  };

  assert.equal(improvesPrintTimePlan(candidate, baseline, heights, new Map()), false);
});

test('equal objective values keep the baseline despite different assignments', () => {
  const heights = new Map([['tall', 100], ['medium', 80], ['short', 10]]);
  const baseline: PrintTimePlan = {
    plateCount: 2,
    unplacedCount: 0,
    passes: [
      { plateId: null, modelIds: ['tall', 'short'] },
      { plateId: null, modelIds: ['medium'] },
    ],
  };
  const candidate: PrintTimePlan = {
    plateCount: 2,
    unplacedCount: 0,
    passes: [
      { plateId: null, modelIds: ['tall'] },
      { plateId: null, modelIds: ['medium', 'short'] },
    ],
  };

  assert.equal(improvesPrintTimePlan(candidate, baseline, heights, new Map()), false);
  assert.equal(improvesPrintTimePlan(baseline, candidate, heights, new Map()), false);
});

test('fewer plates cannot justify a higher sum of tallest Z', () => {
  const heights = new Map([['tallA', 100], ['tallB', 100], ['shortA', 1], ['shortB', 1]]);
  const baseline: PrintTimePlan = {
    plateCount: 3,
    unplacedCount: 0,
    passes: [
      { plateId: null, modelIds: ['tallA', 'tallB'] },
      { plateId: null, modelIds: ['shortA'] },
      { plateId: null, modelIds: ['shortB'] },
    ],
  };
  const candidate: PrintTimePlan = {
    plateCount: 2,
    unplacedCount: 0,
    passes: [
      { plateId: null, modelIds: ['tallA', 'shortA'] },
      { plateId: null, modelIds: ['tallB', 'shortB'] },
    ],
  };
  assert.equal(improvesPrintTimePlan(candidate, baseline, heights, new Map()), false);
});

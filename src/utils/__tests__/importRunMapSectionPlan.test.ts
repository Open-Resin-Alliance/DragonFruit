import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeImportRunMapRecompute,
  planImportSectionSplice,
  IMPORT_RUN_MAP_MAX_ENTRIES,
  type ImportRunMap,
  type ImportRunMapRecomputeReason,
  type ImportRunMapSummary,
} from '../importRunMap';

/**
 * Ph3 — the splice's decision layer.
 *
 * Ph1 shipped `resolveImportRunMap` (available / none / recompute×4) and
 * deliberately left the recompute unimplemented, because the splice was its only
 * consumer. `planImportSectionSplice` is that consumer's decision function: it
 * turns the resolver's verdict, plus the two things the resolver cannot see (a
 * verdict preserved from reload, and whether the classification reports a split
 * at all), into "splice this whole" or "splice it in two sections, with these
 * runs / by recomputing them".
 *
 * The two failure modes this exists to keep apart:
 *
 *  - reading "a split is known but its map was never written" as "no split"
 *    slices a pre-supported plate's supports as MODEL — the failure class the
 *    whole arc exists to remove;
 *  - reading "nothing here ever recorded a split" as "recompute" charges every
 *    ordinary import a full re-classification (seconds on a large model) to
 *    discover there was nothing to find.
 *
 * RED BEFORE THE FIX: `planImportSectionSplice` did not exist — a compile-only
 * red, stated as such rather than dressed up.
 */

function runtimeMap(overrides?: Partial<ImportRunMap>): ImportRunMap {
  return {
    runs: new Uint32Array([0, 384, 2784, 384]),
    sourceTriangleCount: 3168,
    modelTriangleCount: 768,
    droppedNonFiniteTriangles: 0,
    totalRunCount: 2,
    ...overrides,
  };
}

function summary(overrides?: Partial<ImportRunMapSummary>): ImportRunMapSummary {
  return {
    entryCount: 2,
    sourceTriangleCount: 3168,
    modelTriangleCount: 768,
    droppedNonFiniteTriangles: 0,
    totalRunCount: 2,
    ...overrides,
  };
}

test('a live in-session map splices in sections, with the runs', () => {
  const plan = planImportSectionSplice({ runtime: runtimeMap(), reportSplitExists: true });
  assert.equal(plan.kind, 'sections');
  assert.deepEqual(
    plan.kind === 'sections' ? Array.from(plan.runs ?? []) : null,
    [0, 384, 2784, 384],
  );
  assert.equal(plan.kind === 'sections' ? plan.recomputeReason : 'x', null);
});

test('a persisted summary plus its chunk splices in sections', () => {
  const plan = planImportSectionSplice({
    summary: summary(),
    persistedRuns: new Uint32Array([0, 384, 2784, 384]),
    reportSplitExists: true,
  });
  assert.equal(plan.kind, 'sections');
  assert.equal(plan.kind === 'sections' ? plan.recomputeReason : 'x', null);
});

test('a genuine no-split model splices WHOLE and never recomputes', () => {
  // `totalRunCount === 0` is the classifier saying it looked and found one
  // section. Recomputing that would burn a full classify to learn nothing.
  const plan = planImportSectionSplice({
    runtime: runtimeMap({ runs: new Uint32Array(0), totalRunCount: 0, modelTriangleCount: 0 }),
    reportSplitExists: false,
  });
  assert.deepEqual(plan, { kind: 'whole', reason: 'no-split' });

  const persisted = planImportSectionSplice({
    summary: summary({ entryCount: 0, totalRunCount: 0, modelTriangleCount: 0 }),
    reportSplitExists: false,
  });
  assert.deepEqual(persisted, { kind: 'whole', reason: 'no-split' });
});

test('a model nothing ever classified splices WHOLE, not by recompute', () => {
  // A pre-Ph1 save, or a model that never went through the native importer.
  // Splicing it whole is exactly what happened before Ph3, and it is the honest
  // answer: an unknown partition must not be invented.
  const plan = planImportSectionSplice({ reportSplitExists: false });
  assert.deepEqual(plan, { kind: 'whole', reason: 'no-support-verdict' });
});

test('every recompute reason produces a sectioned splice with no runs', () => {
  const cases: Array<{
    label: ImportRunMapRecomputeReason;
    input: Parameters<typeof planImportSectionSplice>[0];
  }> = [
    {
      // The classifier produced more runs than the 8 192-entry cap carries, so
      // the array is empty while the count says otherwise.
      label: 'over-cap',
      input: {
        runtime: runtimeMap({
          runs: new Uint32Array(0),
          totalRunCount: IMPORT_RUN_MAP_MAX_ENTRIES + 1,
        }),
        reportSplitExists: true,
      },
    },
    {
      // The report knows there is a split; nothing ever wrote a map for it.
      label: 'not-persisted',
      input: { reportSplitExists: true },
    },
    {
      // A summary expecting a chunk an older writer dropped.
      label: 'chunk-missing',
      input: { summary: summary(), persistedRuns: null, reportSplitExists: true },
    },
    {
      // Decided at reload, while the damaged chunk was still in hand — it
      // cannot be re-derived here, which is why it is carried.
      label: 'chunk-damaged',
      input: { summary: summary(), storedRecompute: 'chunk-damaged', reportSplitExists: true },
    },
  ];

  for (const { label, input } of cases) {
    const plan = planImportSectionSplice(input);
    assert.equal(plan.kind, 'sections', `${label} must still splice in sections`);
    assert.equal(plan.kind === 'sections' ? plan.runs : 'x', null, `${label} carries no runs`);
    assert.equal(
      plan.kind === 'sections' ? plan.recomputeReason : null,
      label,
      `${label} must be reported as itself, not collapsed into a neighbour`,
    );
    assert.match(describeImportRunMapRecompute(label), /\w/);
  }
});

test('a preserved verdict wins over one re-derived from lossier inputs', () => {
  // At reload the resolver could see the damaged chunk. At splice time the
  // chunk is gone and the same inputs read as `chunk-missing`. The preserved
  // verdict is the one with the evidence behind it.
  const plan = planImportSectionSplice({
    summary: summary(),
    persistedRuns: null,
    storedRecompute: 'chunk-damaged',
    reportSplitExists: true,
  });
  assert.equal(plan.kind === 'sections' ? plan.recomputeReason : null, 'chunk-damaged');
});

test('a preserved verdict alone is enough to demand sections', () => {
  const plan = planImportSectionSplice({ storedRecompute: 'over-cap', reportSplitExists: false });
  assert.equal(plan.kind === 'sections' ? plan.recomputeReason : null, 'over-cap');
});

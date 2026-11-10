import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileLayerSettingsRanges,
  findUnsupportedLayerSetting,
  fingerprintLayerSettingsRanges,
  LAYER_SETTING_FIELDS,
  parseLayerSettingsRanges,
  resolveLayerSettingsRangeBounds,
  resolveLayerSettingsAt,
  resolveLayerSettingsRangeSupport,
  layerSettingsRangeInfluence,
  type LayerNumberSettingsRange,
  type MillimeterSettingsRange,
  type LayerPrintSettingsPatch,
  type LayerSettingsRange,
  type LayerSettingsSegment,
} from '../layerSettingsRanges';
import { resolveLayerSettingsFields } from '../formats/layerSettingsFields';
import type { SlicingFormatDefinition } from '../formats/types';

const MAX_LAYER = 4294967295;
const MAX_F32 = 3.4028234663852886e38;

function range(id: string, startLayer: number, endLayer: number, settings: LayerPrintSettingsPatch): LayerNumberSettingsRange {
  return { id, startLayer, endLayer, settings };
}

function abc(): LayerNumberSettingsRange[] {
  return [
    range('A', 3, 10, { exposureSec: 4, liftHeightMm: 8 }),
    range('B', 5, 6, { exposureSec: 7 }),
    range('C', 6, 7, { exposureSec: 9 }),
  ];
}

function mmRange(id: string, startMm: number, endMm: number, settings: LayerPrintSettingsPatch): MillimeterSettingsRange {
  return { id, unit: 'mm', startMm, endMm, settings };
}

function abcMm(): MillimeterSettingsRange[] {
  return [
    mmRange('A', 0.15, 0.5, { exposureSec: 4, liftHeightMm: 8 }),
    mmRange('B', 0.25, 0.3, { exposureSec: 7 }),
    mmRange('C', 0.3, 0.35, { exposureSec: 9 }),
  ];
}

function segmentAt(segments: readonly LayerSettingsSegment[], layer: number): LayerSettingsSegment | undefined {
  return segments.find((segment) => segment.startLayer <= layer && layer <= segment.endLayer);
}

function exposures(segments: readonly LayerSettingsSegment[]): number[] {
  return Array.from({ length: 12 }, (_, index) => segmentAt(segments, index + 1)?.settings.exposureSec ?? (index < 2 ? 10 : 2));
}

test('canonical A/B/C resolves sparse inheritance, display identity, deletion and edit priority', () => {
  const ranges = abc();
  const segments = compileLayerSettingsRanges(ranges, 12);
  assert.deepEqual(exposures(segments), [10, 10, 4, 4, 7, 9, 9, 4, 4, 4, 2, 2]);
  assert.deepEqual(segments, [
    { startLayer: 3, endLayer: 4, settings: { exposureSec: 4, liftHeightMm: 8 }, rangeId: 'A' },
    { startLayer: 5, endLayer: 5, settings: { exposureSec: 7, liftHeightMm: 8 }, rangeId: 'B' },
    { startLayer: 6, endLayer: 7, settings: { exposureSec: 9, liftHeightMm: 8 }, rangeId: 'C' },
    { startLayer: 8, endLayer: 10, settings: { exposureSec: 4, liftHeightMm: 8 }, rangeId: 'A' },
  ]);
  for (let layer = 3; layer <= 10; layer += 1) {
    assert.equal(segmentAt(segments, layer)?.settings.liftHeightMm, 8);
  }
  assert.deepEqual(exposures(compileLayerSettingsRanges(ranges.slice(0, 2), 12)), [10, 10, 4, 4, 7, 7, 4, 4, 4, 4, 2, 2]);
  ranges[1] = { ...ranges[1], settings: { exposureSec: 11 } };
  const edited = compileLayerSettingsRanges(ranges, 12);
  assert.equal(segmentAt(edited, 5)?.settings.exposureSec, 11);
  assert.equal(segmentAt(edited, 6)?.settings.exposureSec, 9);
  assert.deepEqual(ranges.map(({ id }) => id), ['A', 'B', 'C']);
});

test('each missing field inherits from the highest-priority supplying wider range', () => {
  const segments = compileLayerSettingsRanges([
    range('wide-first', 1, 10, { exposureSec: 4, liftHeightMm: 8, waitTimeBeforeCureSec: 1 }),
    range('wide-later', 3, 12, { liftHeightMm: 10, lightPwm: 100 }),
    range('middle', 4, 9, { waitTimeBeforeCureSec: 3 }),
    range('narrow', 6, 6, { exposureSec: 9 }),
  ], 12);
  assert.deepEqual(segmentAt(segments, 6), {
    startLayer: 6, endLayer: 6, rangeId: 'narrow',
    settings: { exposureSec: 9, waitTimeBeforeCureSec: 3, liftHeightMm: 10, lightPwm: 100 },
  });
  assert.equal(segmentAt(segments, 5)?.rangeId, 'middle');
  assert.equal(segmentAt(segments, 5)?.settings.exposureSec, 4);
  assert.equal(segmentAt(segments, 11)?.settings.exposureSec, undefined);
});

test('partially overlapping nonnested ranges use original span then later position', () => {
  const segments = compileLayerSettingsRanges([
    range('first', 2, 5, { exposureSec: 4, liftHeightMm: 8 }),
    range('later', 4, 7, { exposureSec: 9 }),
  ], 8);
  assert.equal(segmentAt(segments, 3)?.rangeId, 'first');
  assert.deepEqual(segmentAt(segments, 4)?.settings, { exposureSec: 9, liftHeightMm: 8 });
  assert.equal(segmentAt(segments, 4)?.rangeId, 'later');
  assert.deepEqual(segmentAt(segments, 6)?.settings, { exposureSec: 9 });
  assert.equal(segmentAt(segments, 1), undefined);
  assert.equal(segmentAt(segments, 8), undefined);
});

test('single layers, touching ranges and first/last layers keep inclusive cells and gaps', () => {
  const segments = compileLayerSettingsRanges([
    range('first', 1, 1, { exposureSec: 1 }),
    range('left', 2, 3, { exposureSec: 2 }),
    range('right', 4, 5, { exposureSec: 3 }),
    range('last', 7, 7, { exposureSec: 4 }),
  ], 7);
  assert.deepEqual(segments.map(({ startLayer, endLayer, rangeId }) => [startLayer, endLayer, rangeId]), [
    [1, 1, 'first'], [2, 3, 'left'], [4, 5, 'right'], [7, 7, 'last'],
  ]);
  assert.equal(segmentAt(segments, 6), undefined);
  assert.deepEqual(compileLayerSettingsRanges([range('outside', 20, 30, { lightPwm: 0 })], 10), []);
});

test('clipping never replaces original widths or erases saved out-of-print ranges', () => {
  const ranges = [
    range('B', 1, 10, { exposureSec: 7 }),
    range('A', 1, 100, { exposureSec: 4, liftHeightMm: 8 }),
    range('outside', 200, 300, { lightPwm: 0 }),
  ];
  assert.deepEqual(compileLayerSettingsRanges(ranges, 5), [{
    startLayer: 1, endLayer: 5, settings: { exposureSec: 7, liftHeightMm: 8 }, rangeId: 'B',
  }]);
  assert.deepEqual(ranges.map(({ startLayer, endLayer }) => [startLayer, endLayer]), [[1, 10], [1, 100], [200, 300]]);
  assert.deepEqual(compileLayerSettingsRanges(ranges, 0), []);
  assert.equal(parseLayerSettingsRanges(ranges).length, 3);
});

test('u32-max end+1 remains exact and huge prints produce only endpoint-bounded segments', () => {
  const segments = compileLayerSettingsRanges([
    range('all', 1, MAX_LAYER, { liftHeightMm: 8 }),
    range('middle', 100, 100, { exposureSec: 0 }),
    range('last', MAX_LAYER, MAX_LAYER, { lightPwm: 0 }),
  ], MAX_LAYER);
  assert.deepEqual(segments, [
    { startLayer: 1, endLayer: 99, settings: { liftHeightMm: 8 }, rangeId: 'all' },
    { startLayer: 100, endLayer: 100, settings: { exposureSec: 0, liftHeightMm: 8 }, rangeId: 'middle' },
    { startLayer: 101, endLayer: MAX_LAYER - 1, settings: { liftHeightMm: 8 }, rangeId: 'all' },
    { startLayer: MAX_LAYER, endLayer: MAX_LAYER, settings: { liftHeightMm: 8, lightPwm: 0 }, rangeId: 'last' },
  ]);
  assert.deepEqual(compileLayerSettingsRanges([range('only-last', MAX_LAYER, MAX_LAYER, { exposureSec: 4 })], MAX_LAYER), [
    { startLayer: MAX_LAYER, endLayer: MAX_LAYER, settings: { exposureSec: 4 }, rangeId: 'only-last' },
  ]);
});

test('coalescing ignores ineffective events but never merges different display identities', () => {
  const segments = compileLayerSettingsRanges([
    range('wide', 1, 10, { exposureSec: 4 }),
    range('narrow', 3, 6, { exposureSec: 7 }),
    range('crossing', 4, 12, { exposureSec: 4 }),
  ], 12);
  assert.deepEqual(segments.map(({ startLayer, endLayer, rangeId }) => [startLayer, endLayer, rangeId]), [
    [1, 2, 'wide'], [3, 6, 'narrow'], [7, 12, 'crossing'],
  ]);
  const sameSettings = compileLayerSettingsRanges([
    range('left', 1, 2, { exposureSec: 4 }),
    range('right', 3, 4, { exposureSec: 4 }),
  ], 4);
  assert.equal(sameSettings.length, 2);
});

test('absent/empty data and zero-layer prints are valid fresh empty collections', () => {
  const empty: LayerSettingsRange[] = [];
  assert.deepEqual(parseLayerSettingsRanges(undefined), []);
  assert.deepEqual(parseLayerSettingsRanges(empty), []);
  assert.notEqual(parseLayerSettingsRanges(empty), empty);
  assert.deepEqual(compileLayerSettingsRanges(empty, MAX_LAYER), []);
  assert.deepEqual(compileLayerSettingsRanges(abc(), -0), []);
  assert.equal(fingerprintLayerSettingsRanges(empty), '[]');
  assert.equal(findUnsupportedLayerSetting(empty, []), null);
});

test('all numeric fields retain f64 values up to f32 max; explicit negative zero normalizes', () => {
  const patch: LayerPrintSettingsPatch = {};
  for (const field of LAYER_SETTING_FIELDS) patch[field] = field === 'lightPwm' ? 255 : MAX_F32;
  const parsed = parseLayerSettingsRanges([range('max', 1, 1, patch)]);
  assert.deepEqual(parsed[0].settings, patch);
  const precise = 1.0000000000000002;
  const zeros = parseLayerSettingsRanges([range('zero', 1, 1, {
    exposureSec: precise, lightOffDelaySec: -0, waitTimeBeforeCureSec: 0,
    waitTimeAfterCureSec: -0, waitTimeAfterLiftSec: 0, lightPwm: -0,
  })]);
  assert.equal(zeros[0].settings.exposureSec, precise);
  for (const field of ['lightOffDelaySec', 'waitTimeBeforeCureSec', 'waitTimeAfterCureSec', 'waitTimeAfterLiftSec', 'lightPwm'] as const) {
    assert.ok(Object.is(zeros[0].settings[field], 0));
  }
  const compiled = compileLayerSettingsRanges([
    range('wide', 1, 3, { waitTimeAfterLiftSec: 3, lightPwm: 255 }),
    range('zero', 2, 2, { waitTimeAfterLiftSec: 0, lightPwm: 0 }),
  ], 3);
  assert.deepEqual(segmentAt(compiled, 2)?.settings, { waitTimeAfterLiftSec: 0, lightPwm: 0 });
});

test('invalid collections, range shapes, endpoints and ids fail rather than disappearing', () => {
  const valid = range('valid', 1, 2, { exposureSec: 4 });
  const invalidInputs: unknown[] = [
    null, {}, '[]', 0, [null], [[]], [undefined], new Array(1),
    [{ ...valid, id: '' }], [{ ...valid, id: 1 }], [valid, { ...valid }],
    [{ ...valid, startLayer: 0 }], [{ ...valid, startLayer: -0 }],
    [{ ...valid, startLayer: -1 }], [{ ...valid, startLayer: 1.5 }],
    [{ ...valid, endLayer: 0 }], [{ ...valid, endLayer: 1.5 }],
    [{ ...valid, startLayer: 3 }], [{ ...valid, endLayer: MAX_LAYER + 1 }],
    [{ ...valid, startLayer: Infinity }], [{ ...valid, endLayer: NaN }],
    [{ ...valid, endLayer: '2' }], [{ ...valid, color: '#ffffff' }],
    [{ ...valid, [Symbol('extra')]: 1 }],
    [{ id: 'missing', startLayer: 1, endLayer: 2 }],
    [Object.assign(Object.create({ id: 'inherited' }), { startLayer: 1, endLayer: 2, settings: { exposureSec: 4 } })],
  ];
  for (const input of invalidInputs) {
    assert.throws(() => parseLayerSettingsRanges(input), /^Error: Invalid layer settings range: /);
  }
});

test('patch own shape rejects empty, null, unknown and every malformed explicit numeric field', () => {
  const invalidPatches: unknown[] = [null, undefined, [], 4, {}, { unknown: 1 },
    { exposureSec: 4, unknown: 1 }, { exposureSec: 4, [Symbol('extra')]: 1 },
    Object.create({ exposureSec: 4 }),
    Object.defineProperty({ exposureSec: 4 }, 'hiddenUnknown', { value: 1 }),
  ];
  for (const field of LAYER_SETTING_FIELDS) {
    for (const value of [null, undefined, '4', true, {}, [], -1, NaN, Infinity, -Infinity, MAX_F32 * 2]) {
      invalidPatches.push({ [field]: value });
    }
  }
  invalidPatches.push({ lightPwm: 0.5 }, { lightPwm: 256 });
  for (const settings of invalidPatches) {
    assert.throws(() => parseLayerSettingsRanges([{ id: 'bad', startLayer: 1, endLayer: 1, settings }]), /^Error: Invalid layer settings range: /);
  }
  const ownPatch = Object.assign(Object.create({ liftHeightMm: 8 }), { exposureSec: 4 });
  assert.deepEqual(parseLayerSettingsRanges([range('own-only', 1, 1, ownPatch)])[0].settings, { exposureSec: 4 });
});

test('compile rejects invalid totals and validates even zero-layer, shadowed or beyond-EOF input', () => {
  for (const total of [-1, 0.5, NaN, Infinity, MAX_LAYER + 1, '1', null, undefined]) {
    assert.throws(() => compileLayerSettingsRanges([], total as number), /^Error: Invalid layer settings range: /);
  }
  const invalid = range('bad', 100, 100, { exposureSec: NaN });
  assert.throws(() => compileLayerSettingsRanges([invalid], 0), /Invalid layer settings range:/);
  assert.throws(() => compileLayerSettingsRanges([invalid], 10), /Invalid layer settings range:/);
  assert.throws(() => compileLayerSettingsRanges([invalid, range('winner', 100, 100, { exposureSec: 4 })], 100), /Invalid layer settings range:/);
});

test('parsing and compilation own boundary data without mutating frozen published ranges', () => {
  const source = abc();
  const parsed = parseLayerSettingsRanges(source);
  const compiled = compileLayerSettingsRanges(source, 12);
  source[0].settings.liftHeightMm = 99;
  source[0].endLayer = 11;
  assert.equal(parsed[0].settings.liftHeightMm, 8);
  assert.ok(parsed[0].unit !== 'mm');
  assert.equal(parsed[0].endLayer, 10);
  assert.equal(segmentAt(compiled, 6)?.settings.liftHeightMm, 8);
  compiled[0].settings.liftHeightMm = 12;
  assert.equal(compiled[1].settings.liftHeightMm, 8);
  assert.equal(parsed[0].settings.liftHeightMm, 8);
  const frozen = abc();
  frozen.forEach((value) => { Object.freeze(value.settings); Object.freeze(value); });
  Object.freeze(frozen);
  assert.deepEqual(compileLayerSettingsRanges(frozen, 12), compileLayerSettingsRanges(abc(), 12));
  assert.deepEqual(parseLayerSettingsRanges(frozen), abc());
});

test('fingerprints canonicalize patch order and zero, exclude ids, but retain range order and endpoints', () => {
  const original = abc();
  const fingerprint = fingerprintLayerSettingsRanges(original);
  assert.equal(fingerprintLayerSettingsRanges(original.map((value, index) => ({ ...value, id: `renamed-${index}` }))), fingerprint);
  const reorderedPatch = abc();
  reorderedPatch[0].settings = { liftHeightMm: 8, exposureSec: 4 };
  assert.equal(fingerprintLayerSettingsRanges(reorderedPatch), fingerprint);
  assert.deepEqual(Object.keys(parseLayerSettingsRanges(reorderedPatch)[0].settings), ['exposureSec', 'liftHeightMm']);
  assert.notEqual(fingerprintLayerSettingsRanges([original[0], original[2], original[1]]), fingerprint);
  assert.notEqual(fingerprintLayerSettingsRanges([{ ...original[0], endLayer: 11 }, ...original.slice(1)]), fingerprint);
  assert.notEqual(fingerprintLayerSettingsRanges([{ ...original[0], settings: { exposureSec: 5, liftHeightMm: 8 } }, ...original.slice(1)]), fingerprint);
  assert.equal(fingerprintLayerSettingsRanges([range('zero', 1, 1, { exposureSec: -0 })]), fingerprintLayerSettingsRanges([range('other-id', 1, 1, { exposureSec: 0 })]));
  assert.throws(() => fingerprintLayerSettingsRanges([range('invalid', 1, 1, { exposureSec: null as unknown as number })]), /Invalid layer settings range:/);
});

test('unsupported settings choose original range then whitelist order, including shadowed/outside fields', () => {
  const ranges = [
    range('outside', 100, 100, { lightPwm: 0, liftHeightMm: 8, exposureSec: 4 }),
    range('later', 1, 1, { lightOffDelaySec: 2 }),
    range('shadow', 100, 100, { exposureSec: 9 }),
  ];
  assert.deepEqual(findUnsupportedLayerSetting(ranges, []), { rangeId: 'outside', field: 'exposureSec' });
  assert.deepEqual(findUnsupportedLayerSetting(ranges, ['exposureSec']), { rangeId: 'outside', field: 'liftHeightMm' });
  assert.deepEqual(findUnsupportedLayerSetting(ranges, ['exposureSec', 'liftHeightMm', 'lightPwm']), { rangeId: 'later', field: 'lightOffDelaySec' });
  assert.equal(findUnsupportedLayerSetting(ranges, LAYER_SETTING_FIELDS), null);
  assert.throws(() => findUnsupportedLayerSetting([range('invalid', 1, 1, { lightPwm: NaN })], LAYER_SETTING_FIELDS), /Invalid layer settings range:/);
});


test('mm A/B/C uses inclusive printed end heights with identical sparse inheritance and priority', () => {
  const ranges = abcMm();
  const segments = compileLayerSettingsRanges(ranges, 12, 0.05);
  assert.deepEqual(segments, compileLayerSettingsRanges(abc(), 12));
  assert.deepEqual(exposures(segments), [10, 10, 4, 4, 7, 9, 9, 4, 4, 4, 2, 2]);
  for (let layer = 3; layer <= 10; layer += 1) {
    assert.equal(segmentAt(segments, layer)?.settings.liftHeightMm, 8);
  }
  assert.deepEqual(ranges.map((value) => resolveLayerSettingsRangeBounds(value, 0.05)), [
    { startLayer: 3, endLayer: 10 },
    { startLayer: 5, endLayer: 6 },
    { startLayer: 6, endLayer: 7 },
  ]);
});

test('changing layer height changes resolved mm indices, never raw values or printing fingerprint', () => {
  const source = abcMm();
  const owned = parseLayerSettingsRanges(source);
  const fingerprint = fingerprintLayerSettingsRanges(owned);
  const json = JSON.stringify(owned);
  assert.deepEqual(owned.map((value) => resolveLayerSettingsRangeBounds(value, 0.025)), [
    { startLayer: 6, endLayer: 20 },
    { startLayer: 10, endLayer: 12 },
    { startLayer: 12, endLayer: 14 },
  ]);
  assert.deepEqual(exposures(compileLayerSettingsRanges(owned, 24, 0.025)), [10, 10, 2, 2, 2, 4, 4, 4, 4, 7, 7, 9]);
  assert.equal(fingerprintLayerSettingsRanges(owned), fingerprint);
  assert.equal(JSON.stringify(owned), json);
  assert.ok(owned.every((value) => !Object.hasOwn(value, 'startLayer') && !Object.hasOwn(value, 'endLayer')));
  source[0].startMm = 1;
  source[0].settings.exposureSec = 99;
  assert.ok(owned[0].unit === 'mm');
  assert.equal(owned[0].startMm, 0.15);
  assert.equal(owned[0].settings.exposureSec, 4);
  owned.forEach((value) => { Object.freeze(value.settings); Object.freeze(value); });
  Object.freeze(owned);
  assert.deepEqual(compileLayerSettingsRanges(owned, 12, 0.05), compileLayerSettingsRanges(abc(), 12));
});

test('mixed units with identical resolved coverage tie by original order and inherit per field', () => {
  const layers = range('layers', 3, 10, { exposureSec: 4, liftHeightMm: 8 });
  const mm = mmRange('mm', 0.15, 0.5, { exposureSec: 7 });
  assert.deepEqual(compileLayerSettingsRanges([layers, mm], 12, 0.05), [{
    startLayer: 3, endLayer: 10, rangeId: 'mm', settings: { exposureSec: 7, liftHeightMm: 8 },
  }]);
  assert.deepEqual(compileLayerSettingsRanges([mm, layers], 12, 0.05), [{
    startLayer: 3, endLayer: 10, rangeId: 'layers', settings: { exposureSec: 4, liftHeightMm: 8 },
  }]);
  assert.notEqual(fingerprintLayerSettingsRanges([layers]), fingerprintLayerSettingsRanges([{ ...mm, settings: layers.settings }]));
});

test('zero height and off-grid points persist without inventing layer zero or snapping a layer', () => {
  for (const [start, end] of [[0, 0], [0.01, 0.04], [0.31, 0.31]]) {
    const value = mmRange('empty', start, end, { exposureSec: 7 });
    assert.equal(resolveLayerSettingsRangeBounds(value, 0.05), null);
    assert.deepEqual(compileLayerSettingsRanges([value], MAX_LAYER, 0.05), []);
    assert.deepEqual(parseLayerSettingsRanges([value]), [value]);
    assert.notEqual(fingerprintLayerSettingsRanges([value]), '[]');
    assert.deepEqual(findUnsupportedLayerSetting([value], []), { rangeId: 'empty', field: 'exposureSec' });
  }
  assert.deepEqual(resolveLayerSettingsRangeBounds(mmRange('first', 0, 0.05, { exposureSec: 4 }), 0.05), {
    startLayer: 1, endLayer: 1,
  });
});

test('binary32 0.3 boundary includes layer six without an epsilon or altered persisted endpoint', () => {
  const point = mmRange('point', 0.3, 0.3, { exposureSec: 4 });
  assert.deepEqual(resolveLayerSettingsRangeBounds(point, 0.05), { startLayer: 6, endLayer: 6 });
  assert.deepEqual(compileLayerSettingsRanges([point], 12, 0.05), [{
    startLayer: 6, endLayer: 6, rangeId: 'point', settings: { exposureSec: 4 },
  }]);
  const precise = mmRange('precise', 0.30000000000000004, 0.30000000000000004, { exposureSec: 4 });
  assert.deepEqual(resolveLayerSettingsRangeBounds(precise, 0.05), { startLayer: 6, endLayer: 6 });
  assert.deepEqual(parseLayerSettingsRanges([precise]), [precise]);
  assert.notEqual(fingerprintLayerSettingsRanges([point]), fingerprintLayerSettingsRanges([precise]));
});

test('30 micron nominal height includes the third printed plane at its converted mm point', () => {
  const height = 0.03;
  const point = mmRange('point', 3 * height, 3 * height, { exposureSec: 4 });
  assert.deepEqual(resolveLayerSettingsRangeBounds(point, height), { startLayer: 3, endLayer: 3 });
  assert.deepEqual(compileLayerSettingsRanges([point], 12, height), [{
    startLayer: 3, endLayer: 3, rangeId: 'point', settings: { exposureSec: 4 },
  }]);
});

test('unit-mode point and interval conversions round-trip nominal profile heights without changing coverage', () => {
  for (const height of [0.015, 0.025, 0.03, 0.035, 0.05, 0.0625]) {
    for (const first of [1, 3, 7, 30, 1234]) {
      for (const last of [first, first + 3]) {
        const layers = range('converted', first, last, { exposureSec: 7, liftHeightMm: 8 });
        // The unit-mode editor stores n * nominal height, not binary32 heights.
        const millimeters = mmRange(layers.id, first * height, last * height, layers.settings);
        const bounds = resolveLayerSettingsRangeBounds(millimeters, height);
        const label = `${height}: ${first}..${last}`;
        assert.deepEqual(bounds, { startLayer: first, endLayer: last }, label);
        assert.ok(bounds);
        const total = last + 2;
        const expected = compileLayerSettingsRanges([layers], total);
        assert.deepEqual(compileLayerSettingsRanges([millimeters], total, height), expected, label);
        assert.deepEqual(compileLayerSettingsRanges([range(layers.id, bounds.startLayer, bounds.endLayer, layers.settings)], total), expected, label);
        assert.deepEqual(parseLayerSettingsRanges([millimeters]), [millimeters]);
      }
    }
  }
});

test('mm priority uses original resolved widths before EOF clipping in mixed-unit schedules', () => {
  const ranges = [
    range('narrow', 1, 10, { exposureSec: 7 }),
    mmRange('wide', 0, 100, { exposureSec: 4, liftHeightMm: 8 }),
    mmRange('outside', 200, 300, { lightPwm: 0 }),
  ];
  const before = JSON.stringify(ranges);
  assert.deepEqual(compileLayerSettingsRanges(ranges, 5, 0.05), [{
    startLayer: 1, endLayer: 5, rangeId: 'narrow', settings: { exposureSec: 7, liftHeightMm: 8 },
  }]);
  assert.deepEqual(resolveLayerSettingsRangeBounds(ranges[2], 0.05), { startLayer: 4000, endLayer: 6000 });
  assert.deepEqual(compileLayerSettingsRanges(ranges, 0, 0.05), []);
  assert.equal(JSON.stringify(ranges), before);
});

test('mm endpoints beyond the finite u32 grid retain extrapolated original width and later-order ties', () => {
  const narrow = mmRange('narrow', 0, MAX_LAYER + 1, { exposureSec: 7 });
  const wide = mmRange('wide', 0, 2 * (MAX_LAYER + 1), { exposureSec: 4, liftHeightMm: 8 });
  assert.deepEqual(resolveLayerSettingsRangeBounds(wide, 1), { startLayer: 1, endLayer: 2 * (MAX_LAYER + 1) });
  assert.deepEqual(compileLayerSettingsRanges([narrow, wide], 5, 1), [{
    startLayer: 1, endLayer: 5, rangeId: 'narrow', settings: { exposureSec: 7, liftHeightMm: 8 },
  }]);
  const outside = mmRange('outside', 2 * (MAX_LAYER + 1), 3 * (MAX_LAYER + 1), { lightPwm: 0 });
  assert.deepEqual(resolveLayerSettingsRangeBounds(outside, 1), {
    startLayer: 2 * (MAX_LAYER + 1), endLayer: 3 * (MAX_LAYER + 1),
  });
  assert.deepEqual(compileLayerSettingsRanges([outside], MAX_LAYER, 1), []);
  assert.deepEqual(parseLayerSettingsRanges([outside]), [outside]);
  assert.deepEqual(compileLayerSettingsRanges([wide, { ...wide, id: 'later', settings: { exposureSec: 9 } }], 5, 1), [{
    startLayer: 1, endLayer: 5, rangeId: 'later', settings: { exposureSec: 9, liftHeightMm: 8 },
  }]);
});

test('f32 grid plateaus at u32 max and overflowing physical heights remain bounded and compact', () => {
  const last = mmRange('last', MAX_LAYER + 1, MAX_LAYER + 1, { lightPwm: 0 });
  const bounds = resolveLayerSettingsRangeBounds(last, 1);
  assert.ok(bounds);
  assert.equal(bounds.endLayer, MAX_LAYER);
  assert.ok(bounds.startLayer < MAX_LAYER);
  assert.deepEqual(compileLayerSettingsRanges([last], MAX_LAYER, 1), [{
    ...bounds, rangeId: 'last', settings: { lightPwm: 0 },
  }]);
  const max = mmRange('max', MAX_F32, MAX_F32, { exposureSec: 4 });
  assert.deepEqual(resolveLayerSettingsRangeBounds(max, MAX_F32), { startLayer: 1, endLayer: 1 });
  assert.deepEqual(compileLayerSettingsRanges([max], MAX_LAYER, MAX_F32), [{
    startLayer: 1, endLayer: 1, rangeId: 'max', settings: { exposureSec: 4 },
  }]);
  // Native f32::MAX's shortest display decimal exceeds its exact f64 value,
  // but casts back to finite f32::MAX and remains a valid nominal height.
  const displayedMax = 3.4028235e38;
  assert.ok(displayedMax > MAX_F32);
  assert.equal(Math.fround(displayedMax), MAX_F32);
  assert.deepEqual(resolveLayerSettingsRangeBounds(max, displayedMax), { startLayer: 1, endLayer: 1 });
  assert.deepEqual(compileLayerSettingsRanges([max], MAX_LAYER, displayedMax),
    compileLayerSettingsRanges([max], MAX_LAYER, MAX_F32));
});

test('large integer planes use single-rounded nominal heights across binary32 plateaus', () => {
  for (const height of [0.015, 0.03, 0.035]) {
    for (const layer of [2 ** 24 + 1, MAX_LAYER]) {
      const printedHeight = Math.fround(layer * height);
      let first = layer;
      let last = layer;
      while (first > 1 && Math.fround((first - 1) * height) === printedHeight) first -= 1;
      while (last < MAX_LAYER && Math.fround((last + 1) * height) === printedHeight) last += 1;
      const point = mmRange('plateau', printedHeight, printedHeight, { lightPwm: 0 });
      const expected = { startLayer: first, endLayer: last };
      assert.deepEqual(resolveLayerSettingsRangeBounds(point, height), expected);
      assert.deepEqual(compileLayerSettingsRanges([point], MAX_LAYER, height), [{
        ...expected, rangeId: 'plateau', settings: { lightPwm: 0 },
      }]);
    }
  }
});

test('subnormal layer height supports f64 original priorities exceeding u64 without per-layer allocations', () => {
  // Not itself binary32: extrapolated priorities must use the nominal height.
  const height = 1.25 * 2 ** -149;
  const narrow = mmRange('narrow', 0, MAX_F32 / 2, { exposureSec: 7 });
  const wide = mmRange('wide', 0, MAX_F32, { exposureSec: 4, liftHeightMm: 8 });
  const bounds = resolveLayerSettingsRangeBounds(wide, height);
  assert.ok(bounds);
  assert.equal(bounds.startLayer, 1);
  assert.equal(bounds.endLayer, Math.floor(MAX_F32 / height));
  assert.ok(bounds.endLayer > 2 ** 64);
  assert.deepEqual(compileLayerSettingsRanges([narrow, wide], MAX_LAYER, height), [{
    startLayer: 1, endLayer: MAX_LAYER, rangeId: 'narrow', settings: { exposureSec: 7, liftHeightMm: 8 },
  }]);
});

test('mm parser owns f64 bounds, normalizes negative zero and preserves the exact legacy wire shape', () => {
  const zero = parseLayerSettingsRanges([mmRange('zero', -0, -0, { exposureSec: -0 })])[0];
  assert.ok(zero.unit === 'mm');
  assert.ok(Object.is(zero.startMm, 0));
  assert.ok(Object.is(zero.endMm, 0));
  assert.ok(Object.is(zero.settings.exposureSec, 0));
  const precise = mmRange('precise', 1.0000000000000002, MAX_F32, { exposureSec: 4 });
  assert.deepEqual(parseLayerSettingsRanges([precise]), [precise]);
  assert.equal(fingerprintLayerSettingsRanges([precise]),
    '[{"unit":"mm","startMm":1.0000000000000002,"endMm":3.4028234663852886e+38,"settings":{"exposureSec":4}}]');
  const legacy = range('legacy', 3, 10, { exposureSec: 4 });
  assert.deepEqual(Object.keys(parseLayerSettingsRanges([legacy])[0]), ['id', 'startLayer', 'endLayer', 'settings']);
  assert.equal(fingerprintLayerSettingsRanges([legacy]), '[{"startLayer":3,"endLayer":10,"settings":{"exposureSec":4}}]');
  assert.equal(fingerprintLayerSettingsRanges([{ ...precise, id: 'renamed' }]), fingerprintLayerSettingsRanges([precise]));
});

test('mm shapes reject unknown units, mixed branches, missing own keys and invalid raw bounds', () => {
  const valid = mmRange('valid', 0.15, 0.5, { exposureSec: 4 });
  const invalidInputs: unknown[] = [
    ...[undefined, null, '', 'layers', 'MM', 0, false].map((unit) => [{ ...valid, unit }]),
    [{ ...range('legacy', 1, 2, { exposureSec: 4 }), unit: undefined }],
    [{ ...valid, startLayer: 3 }], [{ ...valid, endLayer: 10 }],
    [{ ...range('legacy', 1, 2, { exposureSec: 4 }), startMm: 0.05 }],
    [{ id: 'missing-unit', startMm: 0, endMm: 1, settings: { exposureSec: 4 } }],
    [{ id: 'missing-start', unit: 'mm', endMm: 1, settings: { exposureSec: 4 } }],
    [{ id: 'missing-end', unit: 'mm', startMm: 0, settings: { exposureSec: 4 } }],
    [{ ...valid, startMm: 1 }], [{ ...valid, color: '#ffffff' }],
    [{ ...valid, [Symbol('extra')]: 1 }],
    [Object.assign(Object.create({ unit: 'mm' }), { id: 'inherited', startMm: 0, endMm: 1, settings: { exposureSec: 4 } })],
    [Object.assign(Object.create({ startMm: 0 }), { id: 'inherited', unit: 'mm', endMm: 1, settings: { exposureSec: 4 } })],
  ];
  for (const field of ['startMm', 'endMm']) {
    for (const value of [undefined, null, '1', false, {}, [], -1, NaN, Infinity, -Infinity, MAX_F32 * 2]) {
      invalidInputs.push([{ ...valid, [field]: value }]);
    }
  }
  for (const input of invalidInputs) {
    assert.throws(() => parseLayerSettingsRanges(input), /^Error: Invalid layer settings range: /);
  }
});

test('layer height is required and validated only for mm, including empty prints and unmatched ranges', () => {
  const layers = range('legacy', 1, 2, { exposureSec: 4 });
  const mm = mmRange('mm', 0, 0, { exposureSec: 4 });
  for (const height of [undefined, null, '0.05', -0, 0, -1, NaN, Infinity, -Infinity, MAX_F32 * 2, Number.MIN_VALUE]) {
    assert.throws(() => resolveLayerSettingsRangeBounds(mm, height as number), /layerHeightMm/);
    assert.throws(() => compileLayerSettingsRanges([mm], 0, height as number), /layerHeightMm/);
    assert.throws(() => compileLayerSettingsRanges([layers, mm], 12, height as number), /layerHeightMm/);
    assert.deepEqual(resolveLayerSettingsRangeBounds(layers, height as number), { startLayer: 1, endLayer: 2 });
    assert.deepEqual(compileLayerSettingsRanges([layers], 2, height as number), compileLayerSettingsRanges([layers], 2));
    assert.deepEqual(compileLayerSettingsRanges([], 0, height as number), []);
  }
  for (const height of [2 ** -149, 0.025, 0.05, 1, MAX_F32, 3.4028235e38]) {
    assert.deepEqual(compileLayerSettingsRanges([mm], 0, height), []);
  }
});

test('resolved mm coverage agrees with direct binary32 physical-grid comparisons at representative boundaries', () => {
  const endpoints = [0, 0.01, 0.025, 0.05, 0.15, 0.3, 0.31, 0.35, 0.5, 1];
  for (const height of [0.015, 0.025, 0.03, 0.035, 0.05, 0.0625, 0.1]) {
    for (let first = 0; first < endpoints.length; first += 1) {
      for (let last = first; last < endpoints.length; last += 1) {
        const value = mmRange('grid', endpoints[first], endpoints[last], { exposureSec: 7 });
        const segments = compileLayerSettingsRanges([value], 48, height);
        assert.ok(segments.length <= 1);
        for (let layer = 1; layer <= 48; layer += 1) {
          const printedHeight = Math.fround(layer * height);
          const included = Math.fround(value.startMm) <= printedHeight && printedHeight <= Math.fround(value.endMm);
          assert.equal(segmentAt(segments, layer) !== undefined, included, `${height}: ${value.startMm}..${value.endMm} layer ${layer}`);
        }
      }
    }
  }
});

test('pure format capability resolver preserves version replacement, defaults and absent capability behavior', () => {
  const base: SlicingFormatDefinition = {
    id: 'test', outputFormat: '.test', displayName: 'Test', ownership: 'plugin',
    layerDataKind: 'png', rustModulePath: '', wasmExportName: '',
    layerSettingsFields: ['exposureSec', 'liftHeightMm'],
  };
  assert.deepEqual(resolveLayerSettingsFields(base), ['exposureSec', 'liftHeightMm']);
  assert.deepEqual(resolveLayerSettingsFields({ ...base, layerSettingsFields: undefined }), []);
  const definition: SlicingFormatDefinition = {
    ...base,
    formatVersions: [
      { value: 'v1', label: 'First', layerSettingsFields: ['lightPwm'] },
      { value: 'v2', label: 'Default', isDefault: true, layerSettingsFields: [] },
      { value: 'v3', label: 'Inherited' },
    ],
  };
  assert.deepEqual(resolveLayerSettingsFields(definition, ' V1 '), ['lightPwm']);
  assert.deepEqual(resolveLayerSettingsFields(definition, 'v2'), []);
  assert.deepEqual(resolveLayerSettingsFields(definition, 'v3'), ['exposureSec', 'liftHeightMm']);
  for (const requested of [undefined, 'unknown', '', 'invalid version']) {
    assert.deepEqual(resolveLayerSettingsFields(definition, requested), []);
  }
  assert.deepEqual(resolveLayerSettingsFields({ ...definition, formatVersions: definition.formatVersions?.slice(0, 1) }), ['lightPwm']);
});

test('outward edges interpolate into wider settings while the saved core stays full strength', () => {
  const ranges = [
    range('wide', 1, 30, { exposureSec: 4, liftHeightMm: 8 }),
    { ...range('edge', 10, 20, { exposureSec: 8 }), blendStart: 2, blendEnd: 2 },
  ];
  const layers = [7, 8, 9, 10, 12, 18, 20, 21, 22, 23];
  assert.deepEqual(layers.map((layer) => resolveLayerSettingsAt(ranges, layer, { exposureSec: 2 }).exposureSec), [4, 4, 6, 8, 8, 8, 8, 6, 4, 4]);
  for (const layer of layers) assert.equal(resolveLayerSettingsAt(ranges, layer, {}).liftHeightMm, 8);
  const first = { ...range('baseline', 3, 5, { exposureSec: 8 }), blendStart: 2, blendEnd: 2 };
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((layer) => resolveLayerSettingsAt([first], layer, { exposureSec: layer <= 2 ? 10 : 2 }).exposureSec), [10, 9, 8, 8, 8, 5, 2]);
});

test('outward suppliers compose at the same layer and preserve original-span ordering', () => {
  const ranges = [
    { ...range('wide', 10, 20, { exposureSec: 10, liftHeightMm: 8 }), blendStart: 10 },
    { ...range('middle', 12, 16, { exposureSec: 14 }), blendStart: 8 },
    { ...range('narrow', 14, 15, { exposureSec: 20 }), blendStart: 8 },
  ];
  assert.ok(Math.abs(resolveLayerSettingsAt(ranges, 8, { exposureSec: 2, liftHeightMm: 3 }).exposureSec! - 13.4) < 1e-12);
  assert.equal(resolveLayerSettingsAt(ranges, 12, { exposureSec: 2, liftHeightMm: 3 }).exposureSec, 18.5);
  assert.equal(resolveLayerSettingsAt(ranges, 8, { exposureSec: 2, liftHeightMm: 3 }).liftHeightMm, 7);
  const first = { ...range('first', 10, 20, { exposureSec: 10 }), blendStart: 4 };
  const later = { ...range('later', 10, 20, { exposureSec: 14 }), blendStart: 4 };
  assert.equal(resolveLayerSettingsAt([first, later], 8, { exposureSec: 2 }).exposureSec, 10);
  assert.equal(resolveLayerSettingsAt([later, first], 8, { exposureSec: 2 }).exposureSec, 9);
  const short = { ...range('short', 10, 12, { exposureSec: 8 }), blendStart: 20, blendEnd: 20 };
  assert.equal(resolveLayerSettingsAt([range('wide', 1, 40, { exposureSec: 4 }), short], 9, {}).exposureSec, 7.8);
});

test('long outward distances never attenuate even a single-layer core', () => {
  const blurred = { ...range('long', 10, 14, { exposureSec: 8 }), blendStart: 100, blendEnd: 100 };
  assert.deepEqual([10, 11, 12, 13, 14].map((layer) => resolveLayerSettingsAt([blurred], layer, { exposureSec: 4 }).exposureSec), [8, 8, 8, 8, 8]);
  assert.deepEqual(resolveLayerSettingsRangeBounds(blurred), { startLayer: 10, endLayer: 14 });
  assert.deepEqual(resolveLayerSettingsRangeSupport(blurred), { startLayer: 1, endLayer: 114 });
  const point = { ...range('point', 12, 12, { exposureSec: 8 }), blendStart: 2, blendEnd: 2 };
  assert.deepEqual([10, 11, 12, 13, 14].map((layer) => resolveLayerSettingsAt([point], layer, { exposureSec: 4 }).exposureSec), [4, 6, 8, 6, 4]);
});

test('PWM rounds only after all lower-priority blends have been applied', () => {
  const ranges = [
    { ...range('wide', 5, 9, { lightPwm: 1 }), blendStart: 4 },
    { ...range('narrow', 4, 6, { lightPwm: 0 }), blendStart: 2 },
  ];
  assert.equal(resolveLayerSettingsAt(ranges, 3, { lightPwm: 0 }).lightPwm, 0);
  assert.equal(resolveLayerSettingsAt(ranges.slice(0, 1), 3, { lightPwm: 0 }).lightPwm, 1);
});

test('millimetre blur distances remain physical when the layer grid changes', () => {
  const blurred = { ...mmRange('height', 0.25, 0.5, { exposureSec: 10 }), blendStart: 0.125, blendEnd: 0.25 };
  const original = JSON.stringify(blurred);
  const at = (height: number, layer: number) => resolveLayerSettingsAt([blurred], layer, { exposureSec: 2 }, height).exposureSec;
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((layer) => at(0.125, layer)), [2, 10, 10, 10, 6, 2]);
  assert.deepEqual([2, 3, 4, 8, 10, 12].map((layer) => at(0.0625, layer)), [2, 6, 10, 10, 6, 2]);
  assert.equal(JSON.stringify(blurred), original);
});

test('blur distances validate their units and canonical identity invalidates changed print settings', () => {
  const plain = range('plain', 1, 5, { exposureSec: 8 });
  assert.deepEqual(parseLayerSettingsRanges([{ ...plain, blendStart: 0, blendEnd: -0 }]), [plain]);
  assert.equal(fingerprintLayerSettingsRanges([{ ...plain, blendStart: 0 }]), fingerprintLayerSettingsRanges([plain]));
  for (const field of ['blendStart', 'blendEnd'] as const) {
    for (const distance of [null, undefined, '2', -1, 0.5, NaN, Infinity, MAX_LAYER + 1]) {
      assert.throws(() => parseLayerSettingsRanges([{ ...plain, [field]: distance }]), /Invalid layer settings range:/);
    }
    const changed = { ...plain, [field]: 2 };
    assert.notEqual(fingerprintLayerSettingsRanges([changed]), fingerprintLayerSettingsRanges([plain]));
    assert.equal(fingerprintLayerSettingsRanges([{ ...changed, id: 'renamed' }]), fingerprintLayerSettingsRanges([changed]));
    const physical = { ...mmRange('mm', 0.1, 0.5, { exposureSec: 8 }), [field]: 0.125 };
    assert.deepEqual(parseLayerSettingsRanges([physical]), [physical]);
    assert.throws(() => parseLayerSettingsRanges([{ ...physical, [field]: MAX_F32 * 2 }]), /Invalid layer settings range:/);
  }
});

test('blending requires an actual lower baseline only when it contributes to the result', () => {
  const blurred = { ...range('edge', 3, 5, { exposureSec: 8 }), blendStart: 2 };
  assert.deepEqual(resolveLayerSettingsAt([blurred], 1, {}), {});
  assert.throws(() => resolveLayerSettingsAt([blurred], 2, {}), /baseline must supply exposureSec/);
  assert.deepEqual(resolveLayerSettingsAt([blurred], 3, {}), { exposureSec: 8 });
});

test('off-grid physical cores still supply outward feathers without inventing a core layer', () => {
  const point = { ...mmRange('off-grid', 0.1875, 0.1875, { exposureSec: 10 }), blendStart: 0.125, blendEnd: 0.125 };
  assert.equal(resolveLayerSettingsRangeBounds(point, 0.125), null);
  assert.deepEqual(resolveLayerSettingsRangeSupport(point, 0.125), { startLayer: 1, endLayer: 2 });
  assert.deepEqual(compileLayerSettingsRanges([point], 4, 0.125), []);
  assert.deepEqual([1, 2, 3].map((layer) => resolveLayerSettingsAt([point], layer, { exposureSec: 2 }, 0.125).exposureSec), [6, 6, 2]);
  assert.equal(resolveLayerSettingsAt([range('broad', 1, 4, { exposureSec: 4 }), point], 2, {}, 0.125).exposureSec, 7);
});

test('out-of-print cores can feather into the print and disabled edges remain unaffected', () => {
  const afterPrint = { ...range('later', 10, 12, { exposureSec: 8 }), blendStart: 10 };
  assert.equal(resolveLayerSettingsAt([afterPrint], 5, { exposureSec: 4 }).exposureSec, 6);
  assert.equal(resolveLayerSettingsAt([afterPrint], 13, { exposureSec: 4 }).exposureSec, 4);
  assert.equal(layerSettingsRangeInfluence(afterPrint, 5.5), 0.55);
  assert.equal(layerSettingsRangeInfluence(afterPrint, 10), 1);
  assert.equal(layerSettingsRangeInfluence(afterPrint, 13), 0);
});

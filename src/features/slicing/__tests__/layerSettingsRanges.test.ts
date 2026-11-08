import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileLayerSettingsRanges,
  findUnsupportedLayerSetting,
  fingerprintLayerSettingsRanges,
  LAYER_SETTING_FIELDS,
  parseLayerSettingsRanges,
  type LayerPrintSettingsPatch,
  type LayerSettingsRange,
  type LayerSettingsSegment,
} from '../layerSettingsRanges';

const MAX_LAYER = 4294967295;
const MAX_F32 = 3.4028234663852886e38;

function range(id: string, startLayer: number, endLayer: number, settings: LayerPrintSettingsPatch): LayerSettingsRange {
  return { id, startLayer, endLayer, settings };
}

function abc(): LayerSettingsRange[] {
  return [
    range('A', 3, 10, { exposureSec: 4, liftHeightMm: 8 }),
    range('B', 5, 6, { exposureSec: 7 }),
    range('C', 6, 7, { exposureSec: 9 }),
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

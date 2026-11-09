import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLayerSettingsProfileBands } from '../layerSettingsProfileBands';
import type { LayerSettingsRange } from '../layerSettingsRanges';

const range = (id: string, startLayer: number, endLayer: number): LayerSettingsRange => ({ id, startLayer, endLayer, settings: { exposureSec: 2 } });

test('printed layer ranges become lower-exclusive, upper-inclusive physical bands', () => {
  assert.deepEqual(buildLayerSettingsProfileBands([range('r', 2, 4)], new Map([['r', '#55aaff']]), 0.05), [
    { lowerMm: 0.05, upperMm: 0.2, color: '#55aaff' },
  ]);
});

test('profile colors follow narrowest priority and later equal-span ties with sparse inheritance', () => {
  const ranges: LayerSettingsRange[] = [
    range('wide', 1, 8),
    { id: 'narrow', startLayer: 3, endLayer: 4, settings: { liftSpeedMmMin: 90 } },
    { id: 'later', startLayer: 3, endLayer: 4, settings: { exposureSec: 7 } },
  ];
  assert.deepEqual(buildLayerSettingsProfileBands(ranges, new Map([['wide', '#111111'], ['narrow', '#222222'], ['later', '#333333']]), 1), [
    { lowerMm: 0, upperMm: 2, color: '#111111' },
    { lowerMm: 2, upperMm: 4, color: '#333333' },
    { lowerMm: 4, upperMm: 8, color: '#111111' },
  ]);
});

test('changes to inherited encoded fields do not split contiguous bands of the same color', () => {
  const ranges: LayerSettingsRange[] = [
    range('base', 1, 9),
    { id: 'medium', startLayer: 1, endLayer: 5, settings: { liftSpeedMmMin: 90 } },
    { id: 'narrow', startLayer: 4, endLayer: 7, settings: { exposureSec: 7 } },
  ];
  const before = JSON.stringify(ranges);
  assert.deepEqual(buildLayerSettingsProfileBands(ranges, new Map([['base', '#111111'], ['medium', '#222222'], ['narrow', '#333333']]), 1), [
    { lowerMm: 0, upperMm: 3, color: '#222222' },
    { lowerMm: 3, upperMm: 7, color: '#333333' },
    { lowerMm: 7, upperMm: 9, color: '#111111' },
  ]);
  assert.equal(JSON.stringify(ranges), before);
});

test('mm points resolve through the print grid and re-resolve when layer height changes', () => {
  const ranges: LayerSettingsRange[] = [{ id: 'point', unit: 'mm', startMm: 0.09, endMm: 0.09, settings: { exposureSec: 7 } }];
  const colors = new Map([['point', '#55aaff']]);
  assert.deepEqual(buildLayerSettingsProfileBands(ranges, colors, 0.03), [{ lowerMm: 0.06, upperMm: 0.09, color: '#55aaff' }]);
  assert.deepEqual(buildLayerSettingsProfileBands(ranges, colors, 0.05), []);
});

test('scene-wide bands retain heights beyond a short active plate', () => {
  assert.deepEqual(buildLayerSettingsProfileBands([range('tall', 200, 202)], new Map([['tall', '#55aaff']]), 1), [
    { lowerMm: 199, upperMm: 202, color: '#55aaff' },
  ]);
});

test('missing palette entries leave uncolored gaps rather than inventing a fallback', () => {
  assert.deepEqual(buildLayerSettingsProfileBands([range('wide', 1, 4), range('no-color', 2, 3)], new Map([['wide', '#55aaff']]), 1), [
    { lowerMm: 0, upperMm: 1, color: '#55aaff' },
    { lowerMm: 3, upperMm: 4, color: '#55aaff' },
  ]);
});

test('empty scenes have no profile bands and nonempty schedules require a usable height', () => {
  assert.deepEqual(buildLayerSettingsProfileBands([], new Map(), 0), []);
  for (const height of [0, -1, NaN, Infinity]) {
    assert.throws(() => buildLayerSettingsProfileBands([range('r', 1, 2)], new Map([['r', '#55aaff']]), height), RangeError);
  }
});

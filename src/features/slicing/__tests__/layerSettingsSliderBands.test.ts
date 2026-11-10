import assert from 'node:assert/strict';
import test from 'node:test';

import type { LayerSliderRangeBand } from '../../../components/controls/LayerSlider';
import { buildLayerSettingsRangeBands } from '../layerSettingsSliderBands';
import type { LayerSettingsRange } from '../layerSettingsRanges';

const label = (range: LayerSettingsRange): string => range.id;
const colors = new Map([['A', '#f00'], ['B', '#0f0'], ['C', '#00f']]);
const range = (id: string, startLayer: number, endLayer: number): LayerSettingsRange => ({
  id, startLayer, endLayer, settings: { exposureSec: 8 },
});
function close(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}
function band(bands: LayerSliderRangeBand[], id: string): LayerSliderRangeBand {
  const found = bands.find((candidate) => candidate.id === id);
  assert.ok(found, `Missing band ${id}`);
  return found;
}
function ramp(bands: LayerSliderRangeBand[], id: string): LayerSliderRangeBand & { feather: NonNullable<LayerSliderRangeBand['feather']> } {
  const found = band(bands, id);
  assert.ok(found.feather);
  return found as LayerSliderRangeBand & { feather: NonNullable<LayerSliderRangeBand['feather']> };
}

test('no blur keeps exact nominal winner cells, labels and singleton markers', () => {
  const ranges = [range('A', 3, 10), range('B', 5, 6)];
  const scene = buildLayerSettingsRangeBands(ranges, colors, 12, false, 0.05, label);
  assert.deepEqual(scene.map(({ id, bottomPercent, topPercent, label: text, feather }) => ({ id, bottomPercent, topPercent, label: text, feather })), [
    { id: 'A:3:4', bottomPercent: 100 * 2 / 12, topPercent: 100 * 4 / 12, label: 'A', feather: undefined },
    { id: 'B:5:6', bottomPercent: 100 * 4 / 12, topPercent: 100 * 6 / 12, label: 'B', feather: undefined },
    { id: 'A:7:10', bottomPercent: 100 * 6 / 12, topPercent: 100 * 10 / 12, label: 'A', feather: undefined },
  ]);
  const printing = buildLayerSettingsRangeBands([range('A', 3, 3)], colors, 12, true, 0.05, label);
  close(printing[0].bottomPercent, 100 * 1.5 / 11);
  close(printing[0].topPercent, 100 * 2.5 / 11);
  for (const printing of [false, true]) {
    const singleton = buildLayerSettingsRangeBands([range('A', 1, 1)], colors, 1, printing, 0.05, label);
    assert.deepEqual([singleton[0].bottomPercent, singleton[0].topPercent], [0, 100]);
  }
});

test('layer feathers extend outward without changing cores or restarting at the separator', () => {
  const ranges = [{ ...range('A', 10, 20), blendStart: 2, blendEnd: 2 }];
  const bands = buildLayerSettingsRangeBands(ranges, colors, 30, false, 0.05, label);
  const core = band(bands, 'A:10:20');
  assert.equal(core.feather, undefined);
  close(core.bottomPercent, 30);
  close(core.topPercent, 100 * 20 / 30);
  const before = ramp(bands, 'A:feather:start');
  close(before.bottomPercent, 100 * 8 / 30);
  close(before.topPercent, core.bottomPercent);
  close(before.feather.bottomOpacity, 0);
  close(before.feather.topOpacity, 0.5);
  const after = ramp(bands, 'A:feather:end');
  close(after.bottomPercent, core.topPercent);
  close(after.topPercent, 100 * 22 / 30);
  close(after.feather.bottomOpacity, 1);
  close(after.feather.topOpacity, 0);
  assert.equal(bands.length, 3);
});

test('printing cell edges clip original ramps rather than rescaling them', () => {
  const bands = buildLayerSettingsRangeBands([{ ...range('A', 10, 20), blendStart: 2, blendEnd: 2 }], colors, 30, true, 0.05, label);
  const before = ramp(bands, 'A:feather:start');
  const after = ramp(bands, 'A:feather:end');
  close(before.bottomPercent, 100 * 7 / 29);
  close(before.topPercent, 100 * 8.5 / 29);
  close(before.feather.topOpacity, 0.75);
  close(after.bottomPercent, 100 * 19.5 / 29);
  close(after.topPercent, 100 * 21 / 29);
  close(after.feather.bottomOpacity, 0.75);
});

test('out-of-print cores retain visible tails and clipped endpoint alpha', () => {
  for (const printing of [false, true]) {
    const bands = buildLayerSettingsRangeBands([{ ...range('A', 25, 30), blendStart: 10 }], colors, 20, printing, 0.05, label);
    assert.equal(bands.length, 1);
    const before = ramp(bands, 'A:feather:start');
    close(before.bottomPercent, printing ? 100 * 14 / 19 : 75);
    close(before.topPercent, 100);
    close(before.feather.bottomOpacity, 0);
    close(before.feather.topOpacity, 0.5);
    // Live thumb clipping consumes this same ramp, without changing its endpoints.
    const thumbPercent = printing ? 100 * 17 / 19 : 90;
    const alphaAtThumb = before.feather.bottomOpacity
      + (before.feather.topOpacity - before.feather.bottomOpacity)
      * (thumbPercent - before.bottomPercent) / (before.topPercent - before.bottomPercent);
    close(alphaAtThumb, 0.3);
  }
});

test('a completely shadowed range can still paint its own tail', () => {
  const bands = buildLayerSettingsRangeBands([
    { ...range('A', 10, 20), blendEnd: 5 },
    range('B', 10, 20),
  ], colors, 30, false, 0.05, label);
  assert.equal(bands.some((candidate) => candidate.id.startsWith('A:') && !candidate.feather), false);
  const tail = ramp(bands, 'A:feather:end');
  const core = band(bands, 'B:10:20');
  assert.ok(tail.paintOrder! < core.paintOrder!);
  close(tail.topPercent, 100 * 25 / 30);
  close(tail.feather.bottomOpacity, 1);
});

test('paint priority uses original spans and later-array ties, never support or print clipping', () => {
  const bands = buildLayerSettingsRangeBands([
    range('A', 1, 100),
    { ...range('B', 10, 20), blendEnd: 1000 },
    { ...range('C', 15, 25), blendStart: 1000 },
  ], colors, 30, false, 0.05, label);
  assert.ok(band(bands, 'A:1:9').paintOrder! < band(bands, 'B:10:14').paintOrder!);
  assert.ok(band(bands, 'B:10:14').paintOrder! < band(bands, 'C:15:25').paintOrder!);
  assert.ok(bands.every((candidate, index) => index === 0 || bands[index - 1].paintOrder! <= candidate.paintOrder!));
});

test('off-grid mm cores have no solid marker but retain physical-distance tails and span-zero priority', () => {
  const bands = buildLayerSettingsRangeBands([
    { ...range('A', 10, 10), blendStart: 10 },
    { id: 'B', unit: 'mm', startMm: 0.625, endMm: 0.625, blendStart: 0.5, blendEnd: 0.5, settings: { exposureSec: 8 } },
  ], colors, 8, false, 0.25, label);
  assert.equal(bands.some((candidate) => !candidate.feather), false);
  const before = ramp(bands, 'B:feather:start');
  const after = ramp(bands, 'B:feather:end');
  assert.deepEqual([before.bottomPercent, before.topPercent], [6.25, 31.25]);
  assert.deepEqual([after.bottomPercent, after.topPercent], [31.25, 56.25]);
  assert.deepEqual(before.feather, { bottomOpacity: 0, topOpacity: 1 });
  assert.deepEqual(after.feather, { bottomOpacity: 1, topOpacity: 0 });
  assert.ok(ramp(bands, 'A:feather:start').paintOrder! < before.paintOrder!);
});

test('mm clipped opacity uses the shared final-binary32 height space', () => {
  const startMm = 0.3;
  const bands = buildLayerSettingsRangeBands([
    { id: 'A', unit: 'mm', startMm, endMm: 0.4, blendStart: 0.2, settings: { exposureSec: 8 } },
  ], colors, 4, false, 0.05, label);
  const before = ramp(bands, 'A:feather:start');
  close(before.feather.topOpacity, 1 - (Math.fround(startMm) - Math.fround(4 * 0.05)) / 0.2);
});

test('singleton printing tails use the actual plane opacity and disabled/missing-color edges add no paint', () => {
  const singleton = buildLayerSettingsRangeBands([{ ...range('A', 2, 2), blendStart: 2 }], colors, 1, true, 0.05, label);
  assert.equal(singleton.length, 1);
  assert.deepEqual(singleton[0].feather, { bottomOpacity: 0.5, topOpacity: 0.5 });
  assert.deepEqual([singleton[0].bottomPercent, singleton[0].topPercent], [0, 100]);
  const disabled = buildLayerSettingsRangeBands([{ ...range('A', 2, 3), blendStart: 0, blendEnd: 0 }], colors, 8, false, 0.05, label);
  assert.equal(disabled.length, 1);
  assert.equal(disabled[0].feather, undefined);
  assert.deepEqual(buildLayerSettingsRangeBands([{ ...range('A', 2, 3), blendStart: 2 }], new Map(), 8, false, 0.05, label), []);
  assert.deepEqual(buildLayerSettingsRangeBands([], colors, 0, false, 0.05, label), []);
});

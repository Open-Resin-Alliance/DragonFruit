import assert from 'node:assert/strict';
import test from 'node:test';

import {
  frameFromCutSpace,
  planeToCutSpace,
  pointsFromCutSpace,
  specToCutSpace,
  vectorToCutSpace,
} from '../cutSpace';
import type { OrganicCutSpec, TenonPreviewFrame } from '../types';

const close = (a: readonly number[], b: readonly number[], label: string) => {
  assert.equal(a.length, b.length, label);
  a.forEach((value, i) => assert.ok(Math.abs(value - b[i]) < 1e-9, `${label}: ${a} vs ${b}`));
};

test('a model scaled 50× is cut at the size it prints', () => {
  // A 2mm apple at 5000%: its 1mm tenon must be 1mm against a 100mm body, which is
  // what Rust measures once the points it gets are scaled.
  const spec = {
    loopPoints: [{ position: [1, 0, 0], normal: [1, 0, 0] }],
    tenonWidthMm: 1,
    tenonAnchor: [0.5, 0.5, 0],
  } as unknown as OrganicCutSpec;
  const scaled = specToCutSpace(spec, [50, 50, 50]);
  close(scaled.loopPoints[0].position, [50, 0, 0], 'point');
  close(scaled.loopPoints[0].normal, [1, 0, 0], 'normal');
  close(scaled.tenonAnchor ?? [], [25, 25, 0], 'anchor');
  assert.equal(scaled.tenonWidthMm, 1, 'millimetres are not scaled');
});

test('what comes back lands on the model as modelled', () => {
  const s = [50, 20, 10] as const;
  const back = pointsFromCutSpace(new Float32Array(vectorToCutSpace([1, 2, 3], s)), s);
  close(Array.from(back), [1, 2, 3], 'round trip');
});

test('a plane keeps the points it cuts through under a non-uniform scale', () => {
  const s = [2, 4, 8] as const;
  const plane = { normal: [1, 1, 1].map((c) => c / Math.sqrt(3)) as [number, number, number], offset: 3 / Math.sqrt(3) };
  const cut = planeToCutSpace(plane, s);
  assert.ok(Math.abs(Math.hypot(...cut.normal) - 1) < 1e-12, 'unit normal');
  // (1, 1, 1) is on the original plane; its scaled image must be on the scaled one.
  for (const point of [[1, 1, 1], [3, 0, 0], [0, 0, 3]] as const) {
    const p = vectorToCutSpace(point, s);
    const side = cut.normal[0] * p[0] + cut.normal[1] * p[1] + cut.normal[2] * p[2] - cut.offset;
    assert.ok(Math.abs(side) < 1e-9, `${point} left the plane by ${side}`);
  }
});

test('the tenon frame comes back at model scale', () => {
  const frame: TenonPreviewFrame = {
    anchor: [50, 0, 0],
    axis: [0, 0, 1],
    u: [1, 0, 0],
    v: [0, 1, 0],
    tip: [50, 0, 2],
    depth: 2,
    halfDiagMm: 0.7,
  };
  const local = frameFromCutSpace(frame, [50, 50, 50]);
  close(local.anchor, [1, 0, 0], 'anchor');
  close(local.tip, [1, 0, 0.04], 'tip');
  assert.ok(Math.abs(local.depth - 0.04) < 1e-12, 'a 2mm tenon on a 50× model is 0.04 model units deep');
  assert.ok(Math.abs((local.halfDiagMm ?? 0) - 0.014) < 1e-12);
});

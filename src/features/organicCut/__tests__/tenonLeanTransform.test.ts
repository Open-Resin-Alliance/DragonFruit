import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { tenonLeanMatrix, clampTenonTilt } from '../tenonLeanTransform';
import { TENON_MAX_TILT_RAD, type TenonPreviewFrame } from '../types';

/**
 * A tenon framed at the origin on the z=0 plane: the natural axis is +z, so the
 * BUILD axis (what the tenon is actually extruded along) is −z. Same shape Rust
 * reports, so the sign traps in `tenonLeanMatrix` are live here.
 */
function frameAtOrigin(overrides: Partial<TenonPreviewFrame> = {}): TenonPreviewFrame {
  return {
    anchor: [0, 0, 0],
    axis: [0, 0, 1],
    u: [1, 0, 0],
    v: [0, 1, 0],
    tip: [0, 0, -2.5],
    depth: 2.5,
    maxTiltRad: TENON_MAX_TILT_RAD,
    halfDiagMm: 1.6,
    ...overrides,
  };
}

/** Where a point of the straight soup ends up once the lean is applied. */
function moved(m: THREE.Matrix4, x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z).applyMatrix4(m);
}

test('no lean and no roll is no matrix at all', () => {
  assert.equal(tenonLeanMatrix(frameAtOrigin(), 0, 0), null);
});

test('a roll alone spins the tenon about its axis and moves nothing else', () => {
  const m = tenonLeanMatrix(frameAtOrigin(), 0, Math.PI / 2);
  assert.ok(m, 'a roll produces a matrix');
  // A point on the axis stays on the axis: the roll turns the section, not the axis.
  const onAxis = moved(m, 0, 0, -2.5);
  assert.ok(Math.hypot(onAxis.x, onAxis.y) < 1e-6, `axis stays put, got ${onAxis.x},${onAxis.y}`);
  assert.ok(Math.abs(onAxis.z + 2.5) < 1e-6, `and keeps its height, got ${onAxis.z}`);
  // A point off the axis swings a quarter turn.
  const off = moved(m, 1, 0, 0);
  assert.ok(off.length() > 0.9, 'the section really turned');
  assert.ok(Math.abs(off.x) < 1e-6, `a quarter turn leaves nothing on u, got ${off.x}`);
});

test('the leaned axis still passes through the anchor', () => {
  // The bug this guards: the tenon is sunk as it leans, which used to walk its
  // section at the membrane out from under the crosshair.
  for (const deg of [10, 30, 55, -35]) {
    const m = tenonLeanMatrix(frameAtOrigin(), (deg * Math.PI) / 180, 0.4);
    assert.ok(m, `${deg}° produces a matrix`);
    const a = moved(m, 0, 0, 0);
    const b = moved(m, 0, 0, -10);
    // Where does the leaned axis cross the membrane (z = 0)?
    const t = (0 - a.z) / (b.z - a.z);
    const cross = new THREE.Vector3().lerpVectors(a, b, t);
    assert.ok(
      Math.hypot(cross.x, cross.y) < 1e-3,
      `${deg}°: axis crosses the membrane on the anchor, off by ${Math.hypot(cross.x, cross.y)}mm`,
    );
  }
});

test('leaning rotates the tenon rigidly: the cap lands at depth·cos(lean)', () => {
  const frame = frameAtOrigin();
  // The straight soup's tip is at build-axis depth, i.e. z = −depth.
  const upright = moved(tenonLeanMatrix(frame, 1e-9, 0) ?? new THREE.Matrix4(), 0, 0, -frame.depth);
  assert.ok(Math.abs(Math.abs(upright.z) - frame.depth) < 1e-3, 'sanity: upright stands its depth');
  for (const deg of [20, 45]) {
    const rad = (deg * Math.PI) / 180;
    const m = tenonLeanMatrix(frame, rad, 0);
    assert.ok(m, `${deg}° produces a matrix`);
    const tip = moved(m, 0, 0, -frame.depth);
    // The trunk keeps its length — leaning a solid does not resize it.
    assert.ok(
      Math.abs(tip.length() - frame.depth) < 1e-3,
      `${deg}°: the trunk keeps its ${frame.depth}mm, got ${tip.length()}`,
    );
    // So the cap comes DOWN to depth·cos(lean). This used to assert the opposite —
    // that the tip still stood its full depth proud — which is why Rust stretched
    // the trunk and sank the base, and why the tenon was a different size at every
    // angle.
    const expected = frame.depth * Math.cos(rad);
    assert.ok(
      Math.abs(Math.abs(tip.z) - expected) < 1e-3,
      `${deg}°: cap at depth·cos(lean) = ${expected}mm, got ${Math.abs(tip.z)}`,
    );
  }
});

test('the lean tips the tenon in one plane, and its sign picks the side', () => {
  const frame = frameAtOrigin();
  // The lean tips along the frame's v, so u must stay clear either way.
  const plus = moved(tenonLeanMatrix(frame, 0.5, 0)!, 0, 0, -frame.depth);
  const minus = moved(tenonLeanMatrix(frame, -0.5, 0)!, 0, 0, -frame.depth);
  assert.ok(Math.abs(plus.x) < 1e-3, `stays in the lean plane, got u = ${plus.x}`);
  assert.ok(Math.abs(minus.x) < 1e-3, `same the other way, got u = ${minus.x}`);
  assert.ok(plus.y * minus.y < 0, 'the sign of the lean picks the side it tips to');
  assert.ok(Math.abs(plus.y - -minus.y) < 1e-3, 'and it is symmetric');
});

test('the clamp honours the room the part leaves, then the hard ceiling', () => {
  const tight = frameAtOrigin({ maxTiltRad: 0.2 });
  assert.equal(clampTenonTilt(1.0, tight), 0.2, 'clamped to the part');
  assert.equal(clampTenonTilt(-1.0, tight), -0.2, 'both ways');
  assert.equal(clampTenonTilt(0.1, tight), 0.1, 'inside the cap, untouched');
  // A backend that reports no cap still cannot go past the ceiling.
  const uncapped = frameAtOrigin({ maxTiltRad: undefined });
  assert.equal(clampTenonTilt(3.0, uncapped), TENON_MAX_TILT_RAD);
  // Nor can one that reports an absurd one.
  assert.equal(clampTenonTilt(3.0, frameAtOrigin({ maxTiltRad: 99 })), TENON_MAX_TILT_RAD);
});


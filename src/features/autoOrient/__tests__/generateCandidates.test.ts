import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { generateCandidates } from '../logic/generateCandidates';

const ZERO = new THREE.Euler(0, 0, 0, 'ZYX');

/** The local direction that a candidate rotation maps onto world-down (-Z). */
function restingDir(rotation: THREE.Euler): THREE.Vector3 {
  const q = new THREE.Quaternion().setFromEuler(rotation);
  // rotation maps local restingDir -> world down, so restingDir = q⁻¹ · down.
  return new THREE.Vector3(0, 0, -1).applyQuaternion(q.clone().invert()).normalize();
}

describe('generateCandidates', () => {
  it('always includes the current rotation as the first candidate', () => {
    const current = new THREE.Euler(0.3, 0.7, 1.1, 'ZYX');
    const candidates = generateCandidates(current);
    assert.ok(candidates.length > 0);
    const first = candidates[0].rotation;
    assert.strictEqual(first.x, current.x);
    assert.strictEqual(first.y, current.y);
    assert.strictEqual(first.z, current.z);
  });

  it('produces a dense, fixed-size sweep', () => {
    const candidates = generateCandidates(ZERO);
    // 256 sphere samples + the current rotation (deduped).
    assert.ok(candidates.length >= 250, `expected a dense sweep, got ${candidates.length}`);
  });

  it('de-duplicates equivalent orientations', () => {
    const candidates = generateCandidates(ZERO);
    const keys = new Set(
      candidates.map((c) =>
        [Math.round(c.rotation.x * 1e4), Math.round(c.rotation.y * 1e4), Math.round(c.rotation.z * 1e4)].join('|'),
      ),
    );
    assert.strictEqual(keys.size, candidates.length, 'no duplicate orientations expected');
  });

  it('uses ZYX euler order for all candidates', () => {
    const candidates = generateCandidates(ZERO);
    for (const c of candidates) {
      assert.strictEqual(c.rotation.order, 'ZYX');
    }
  });

  it('covers the orientation sphere fairly evenly (no large gaps)', () => {
    const candidates = generateCandidates(ZERO);
    const dirs = candidates.map((c) => restingDir(c.rotation));

    // For a handful of probe directions, the nearest sampled resting direction
    // should be close — i.e. the sweep has no big holes. With ~256 samples the
    // nearest neighbour to any direction is well under ~25°.
    const probes = [
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(1, 1, 1).normalize(),
      new THREE.Vector3(-1, 0.3, -0.6).normalize(),
    ];
    for (const probe of probes) {
      let bestDot = -Infinity;
      for (const d of dirs) bestDot = Math.max(bestDot, d.dot(probe));
      const angleDeg = (Math.acos(Math.min(1, Math.max(-1, bestDot))) * 180) / Math.PI;
      assert.ok(angleDeg < 25, `gap too large near ${probe.toArray()}: ${angleDeg.toFixed(1)}°`);
    }
  });
});

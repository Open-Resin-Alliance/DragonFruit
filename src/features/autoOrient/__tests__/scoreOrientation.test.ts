import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { scoreCandidates, measureOrientation } from '../logic/scoreOrientation';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import type { AutoOrientGoals, OrientationCandidate, OrientationMetrics } from '../types';

function candidate(x = 0, y = 0): OrientationCandidate {
  return { rotation: new THREE.Euler(x, y, 0, 'ZYX') };
}

function goals(over: Partial<AutoOrientGoals> = {}): AutoOrientGoals {
  return {
    minimizeIslands: 0,
    minimizeHeight: 0,
    minimizeFootprint: 0,
    protectFaces: 0,
    ...over,
  };
}

/**
 * A single horizontal triangle whose normal points straight DOWN (-Z) in the
 * model's local frame — i.e. a flat overhang. Winding is chosen so the computed
 * normal is -Z.
 */
function downFacingTriangle(): GeometryWithBounds {
  const geometry = new THREE.BufferGeometry();
  // CW when viewed from above → normal points down.
  const positions = new Float32Array([
    0, 0, 0,
    0, 10, 0,
    10, 0, 0,
  ]);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!;
  return {
    geometry,
    bbox,
    center: bbox.getCenter(new THREE.Vector3()),
    size: bbox.getSize(new THREE.Vector3()),
    flatteningPlanes: [],
  } as GeometryWithBounds;
}

describe('scoreCandidates', () => {
  it('picks the lowest island volume when minimizing supports', () => {
    const candidates = [candidate(0, 0), candidate(1, 0), candidate(2, 0)];
    const metrics: OrientationMetrics[] = [
      { overhangAreaMm2: 100, heightMm: 10, footprintMm2: 50 },
      { overhangAreaMm2: 5, heightMm: 30, footprintMm2: 90 },
      { overhangAreaMm2: 60, heightMm: 20, footprintMm2: 70 },
    ];
    const scored = scoreCandidates(candidates, metrics, goals({ minimizeIslands: 1 }));
    assert.strictEqual(scored[0].metrics.overhangAreaMm2, 5);
  });

  it('picks the lowest height when minimizing height', () => {
    const candidates = [candidate(0, 0), candidate(1, 0)];
    const metrics: OrientationMetrics[] = [
      { heightMm: 40, footprintMm2: 10 },
      { heightMm: 12, footprintMm2: 99 },
    ];
    const scored = scoreCandidates(candidates, metrics, goals({ minimizeHeight: 1 }));
    assert.strictEqual(scored[0].metrics.heightMm, 12);
  });

  it('combines weighted goals (islands outweighs height)', () => {
    const candidates = [candidate(0, 0), candidate(1, 0)];
    // Candidate 0: low overhang, high height. Candidate 1: high overhang, low height.
    const metrics: OrientationMetrics[] = [
      { overhangAreaMm2: 0, heightMm: 100, footprintMm2: 0 },
      { overhangAreaMm2: 100, heightMm: 0, footprintMm2: 0 },
    ];
    const scored = scoreCandidates(candidates, metrics, goals({
      minimizeIslands: 1,
      minimizeHeight: 0.2,
    }));
    // Supports dominates, so the low-overhang candidate (index 0) should win.
    assert.strictEqual(scored[0].metrics.overhangAreaMm2, 0);
  });

  it('keeps the current orientation (index 0) on ties', () => {
    const candidates = [candidate(0, 0), candidate(1, 0)];
    const metrics: OrientationMetrics[] = [
      { heightMm: 10, footprintMm2: 10 },
      { heightMm: 10, footprintMm2: 10 },
    ];
    const scored = scoreCandidates(candidates, metrics, goals({ minimizeHeight: 1 }));
    assert.strictEqual(scored[0].rotation.x, 0, 'tie should keep current orientation first');
  });

  it('returns scores of zero when no goals are enabled', () => {
    const candidates = [candidate(0, 0), candidate(1, 0)];
    const metrics: OrientationMetrics[] = [
      { heightMm: 10, footprintMm2: 10 },
      { heightMm: 99, footprintMm2: 99 },
    ];
    const scored = scoreCandidates(candidates, metrics, goals());
    assert.ok(scored.every((s) => s.score === 0));
  });
});

describe('measureOrientation (overhang proxy)', () => {
  const supportGoals = goals({ minimizeIslands: 1 });

  it('reports overhang area for a downward-facing face', () => {
    const geom = downFacingTriangle();
    const m = measureOrientation(geom, new THREE.Euler(0, 0, 0, 'ZYX'), supportGoals);
    assert.ok((m.overhangAreaMm2 ?? 0) > 0, 'down-facing face should need support');
  });

  it('reports ~zero overhang once the face is flipped to point up', () => {
    const geom = downFacingTriangle();
    // Rotate 180° about X so the -Z normal becomes +Z (faces up, self-supporting).
    const m = measureOrientation(geom, new THREE.Euler(Math.PI, 0, 0, 'ZYX'), supportGoals);
    assert.ok((m.overhangAreaMm2 ?? 0) < 1e-6, 'up-facing face should need no support');
  });

  it('skips island work when the supports goal is disabled', () => {
    const geom = downFacingTriangle();
    const m = measureOrientation(geom, new THREE.Euler(0, 0, 0, 'ZYX'), goals());
    assert.strictEqual(m.overhangAreaMm2, undefined);
  });
});

describe('measureOrientation (protected faces)', () => {
  const protectGoals = goals({ protectFaces: 1 });

  /** Mask flagging the single triangle as protected. */
  function fullMask(): Uint8Array {
    return Uint8Array.from([1]);
  }

  it('reports high exposure when a protected face points down', () => {
    const geom = downFacingTriangle();
    const m = measureOrientation(geom, new THREE.Euler(0, 0, 0, 'ZYX'), protectGoals, fullMask());
    assert.ok((m.protectedExposureMm2 ?? 0) > 0, 'down-facing protected face is exposed');
  });

  it('reports ~zero exposure when the protected face points up', () => {
    const geom = downFacingTriangle();
    const m = measureOrientation(geom, new THREE.Euler(Math.PI, 0, 0, 'ZYX'), protectGoals, fullMask());
    assert.ok((m.protectedExposureMm2 ?? 0) < 1e-6, 'up-facing protected face is safe');
  });

  it('ignores the protect goal when no mask is supplied', () => {
    const geom = downFacingTriangle();
    const m = measureOrientation(geom, new THREE.Euler(0, 0, 0, 'ZYX'), protectGoals);
    assert.strictEqual(m.protectedExposureMm2, undefined);
  });

  it('drives candidate ranking toward keeping the protected face up', () => {
    const candidates = [candidate(0, 0), candidate(1, 0)];
    const metrics: OrientationMetrics[] = [
      { heightMm: 0, footprintMm2: 0, protectedExposureMm2: 50 },
      { heightMm: 0, footprintMm2: 0, protectedExposureMm2: 0 },
    ];
    const scored = scoreCandidates(candidates, metrics, protectGoals);
    assert.strictEqual(scored[0].metrics.protectedExposureMm2, 0);
  });
});

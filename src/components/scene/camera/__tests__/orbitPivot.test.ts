import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { platePivotFromRay } from '../orbitPivot';

const BOUNDS = { minX: -100, maxX: 100, minY: -80, maxY: 80 };

describe('plate orbit pivot', () => {
  it('lands on the plate where the ray crosses it', () => {
    const ray = new THREE.Ray(
      new THREE.Vector3(12, -20, 50),
      new THREE.Vector3(0, 0, -1),
    );
    const point = platePivotFromRay(ray, BOUNDS);
    assert.ok(point);
    assert.deepEqual(point.toArray(), [12, -20, 0]);
  });

  it('clamps a hit outside the footprint to the plate edge', () => {
    // A ray that skims the plate crosses it far outside the footprint.
    const ray = new THREE.Ray(
      new THREE.Vector3(0, 0, 10),
      new THREE.Vector3(1, 1, -0.02).normalize(),
    );
    const point = platePivotFromRay(ray, BOUNDS);
    assert.ok(point);
    assert.equal(point.x, BOUNDS.maxX);
    assert.equal(point.y, BOUNDS.maxY);
    assert.equal(point.z, 0);
  });

  it('ignores rays that run parallel to or away from the plate', () => {
    const parallel = new THREE.Ray(new THREE.Vector3(0, 0, 10), new THREE.Vector3(1, 0, 0));
    assert.equal(platePivotFromRay(parallel, BOUNDS), null);

    const away = new THREE.Ray(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, 1));
    assert.equal(platePivotFromRay(away, BOUNDS), null);
  });
});

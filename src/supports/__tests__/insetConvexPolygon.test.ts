import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { insetConvexPolygon } from '../Rafts/Crenelated/geometry/insetConvexPolygon';

function signedArea(poly: THREE.Vector2[]): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    area += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return area * 0.5;
}

describe('insetConvexPolygon', () => {
  it('insets a near-colinear convex polygon without producing invalid points', () => {
    const poly = [
      new THREE.Vector2(0, 0),
      new THREE.Vector2(40, 0),
      new THREE.Vector2(40, 0.001),
      new THREE.Vector2(42, 20),
      new THREE.Vector2(0, 20),
    ];

    const inset = insetConvexPolygon(poly, 1.2);

    assert.strictEqual(inset.length, poly.length);
    inset.forEach((p) => {
      assert.ok(Number.isFinite(p.x), 'inset x must be finite');
      assert.ok(Number.isFinite(p.y), 'inset y must be finite');
    });

    const outerArea = Math.abs(signedArea(poly));
    const insetArea = Math.abs(signedArea(inset));
    assert.ok(insetArea > 0, 'inset area must stay positive');
    assert.ok(insetArea < outerArea, 'inset should reduce area');
  });

  it('produces equivalent inset area for CW and CCW input winding', () => {
    const ccw = [
      new THREE.Vector2(0, 0),
      new THREE.Vector2(20, 0),
      new THREE.Vector2(20, 10),
      new THREE.Vector2(0, 10),
    ];
    const cw = [...ccw].reverse();

    const insetCcw = insetConvexPolygon(ccw, 1);
    const insetCw = insetConvexPolygon(cw, 1);

    const areaCcw = Math.abs(signedArea(insetCcw));
    const areaCw = Math.abs(signedArea(insetCw));
    assert.ok(Math.abs(areaCcw - areaCw) < 1e-4, 'inset area should be winding-invariant');
  });
});

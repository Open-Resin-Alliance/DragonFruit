import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { collectModelPlateFootprint, type PlateFootprintSource } from '../modelPlateFootprint';
import { computeRaftFootprintPolygons } from '../computeRaftFootprint';
import { buildRaftFootprintMeshes, generateChamferedBaseFromPolygons } from '../generateRaftFromFootprint';
import { polygonSetAreaMm2, ringToPolygon, type PolygonWithHoles } from '../polygonSet2d';
import { filterLineRaftEdges, generateUnionedLineRaftMesh } from '../generateUnionedLineRaftMesh';
import { DEFAULT_RAFT_SETTINGS } from '../../RaftDefaults';

const model = (
  geometry: THREE.BufferGeometry,
  position: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
): PlateFootprintSource => ({
  geometry: { geometry, center: new THREE.Vector3(0, 0, 0) },
  transform: {
    position: new THREE.Vector3(...position),
    rotation: new THREE.Euler(...rotation),
    scale: new THREE.Vector3(1, 1, 1),
  },
});

const areaOf = (polys: readonly PolygonWithHoles[]) => polygonSetAreaMm2(polys);

function boundsOf(polys: readonly PolygonWithHoles[]) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const poly of polys) {
    for (const point of poly.outer) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
  }
  return { minX, maxX, minY, maxY };
}

/** Ray-cast containment over the set, holes subtracted. */
function containsPoint(polys: readonly PolygonWithHoles[], x: number, y: number): boolean {
  const insideRing = (ring: readonly THREE.Vector2[]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
    return inside;
  };

  return polys.some((poly) => (
    insideRing(poly.outer) && !poly.holes.some((hole) => insideRing(hole))
  ));
}

test('a box resting on the plate reports its cross-section over the band', () => {
  const box = new THREE.BoxGeometry(10, 20, 5);
  // Centred box lifted so its bottom sits on the plate: z in [0, 5].
  const footprint = collectModelPlateFootprint([model(box, [3, -4, 2.5])], 2);

  assert.equal(footprint.length, 1);
  assert.equal(footprint[0].holes.length, 0);
  // The region is a raster superset of the true shadow: at most a cell of
  // rounding plus the one-cell dilation that keeps the traced loops pinch-free.
  assert.ok(areaOf(footprint) >= 200 && areaOf(footprint) < 206, `area ${areaOf(footprint)}`);

  const bounds = boundsOf(footprint);
  const raster = 0.3;
  assert.ok(Math.abs(bounds.minX - -2) < raster);
  assert.ok(Math.abs(bounds.maxX - 8) < raster);
  assert.ok(Math.abs(bounds.minY - -14) < raster);
  assert.ok(Math.abs(bounds.maxY - 6) < raster);
});

test('a ball touching the plate is cut at the band top, not at the contact point', () => {
  // Sphere radius 10 resting on the plate: its section at z = 2 has radius
  // sqrt(2 * 10 * 2 - 4) = 6, so a 2 mm band has to clear that, not a point.
  const ball = new THREE.SphereGeometry(10, 48, 24);
  const footprint = collectModelPlateFootprint([model(ball, [0, 0, 10])], 2);

  assert.equal(footprint.length, 1);
  const bounds = boundsOf(footprint);
  const radius = (bounds.maxX - bounds.minX) / 2;
  // Faceting of the sphere mesh puts the polygonal section a hair inside 6 mm;
  // the raster then reports it a hair outside.
  assert.ok(radius > 5.8 && radius < 6.2, `radius ${radius}`);
  assert.ok(areaOf(footprint) >= Math.PI * 36 - 4 && areaOf(footprint) < Math.PI * 36 + 8, `area ${areaOf(footprint)}`);
});

test('two feet on the plate leave two separate footprints', () => {
  const feet = new THREE.BoxGeometry(4, 4, 3);
  const left = collectModelPlateFootprint([model(feet, [-8, 0, 1.5])], 2);
  const right = collectModelPlateFootprint([model(feet, [8, 0, 1.5])], 2);
  const both = collectModelPlateFootprint([
    model(feet, [-8, 0, 1.5]),
    model(feet, [8, 0, 1.5]),
  ], 2);

  assert.equal(both.length, 2, 'the raft must be able to stand between the feet');
  assert.ok(Math.abs(areaOf(both) - (areaOf(left) + areaOf(right))) < 0.05);
});

test('a model lifted clear of the band contributes nothing', () => {
  const box = new THREE.BoxGeometry(10, 10, 4);
  const footprint = collectModelPlateFootprint([model(box, [0, 0, 6])], 2);
  assert.deepEqual(footprint, []);
});

test('a tilted model is measured in world space', () => {
  // A 20×4×2 slab laid over 30° about X. Over the band [0, 2] the whole bottom
  // face is inside, so the projected depth is 4·cos30 + 2·sin30 = 4.464 — a
  // measurement taken in the model's own frame could not produce that.
  const slab = new THREE.BoxGeometry(20, 4, 2);
  const tilt = Math.PI / 6;
  const restZ = 2 * Math.sin(tilt) + 1 * Math.cos(tilt);
  const footprint = collectModelPlateFootprint([model(slab, [0, 0, restZ], [tilt, 0, 0])], 2);

  assert.equal(footprint.length, 1);
  const bounds = boundsOf(footprint);
  assert.ok(Math.abs(bounds.maxX - bounds.minX - 20) < 0.3, `x ${bounds.maxX - bounds.minX}`);
  const depth = bounds.maxY - bounds.minY;
  // Raster rounding is well inside the 0.46 mm that separates the tilted depth
  // from the 4 mm a model-frame measurement would report.
  assert.ok(Math.abs(depth - (4 * Math.cos(tilt) + 2 * Math.sin(tilt))) < 0.3, `depth ${depth}`);
});

test('raft footprint drops the clearance out of the hull', () => {
  const box = new THREE.BoxGeometry(20, 20, 4);
  const clearance = collectModelPlateFootprint([model(box, [0, 0, 2])], 0.85);
  const circles = [
    { x: -12, y: -12, r: 1.5 },
    { x: 12, y: -12, r: 1.5 },
    { x: 12, y: 12, r: 1.5 },
    { x: -12, y: 12, r: 1.5 },
  ];

  const untrimmed = computeRaftFootprintPolygons({ circles, raft: DEFAULT_RAFT_SETTINGS });
  const trimmed = computeRaftFootprintPolygons({ circles, raft: DEFAULT_RAFT_SETTINGS, clearance });

  assert.equal(untrimmed.length, 1);
  assert.equal(untrimmed[0].holes.length, 0);
  assert.equal(trimmed.length, 1);
  assert.equal(trimmed[0].holes.length, 1, 'the cut is enclosed by the hull');

  // 20 mm box + 1 mm clearance on every side = a 22 mm hole; the raster can only
  // report it slightly larger, never smaller.
  const removed = areaOf(untrimmed) - areaOf(trimmed);
  assert.ok(removed >= 484 && removed < 493, `${areaOf(untrimmed)} -> ${areaOf(trimmed)}`);
});

test('a clearance that reaches the hull edge leaves no hole, just less raft', () => {
  const box = new THREE.BoxGeometry(60, 20, 4);
  const clearance = collectModelPlateFootprint([model(box, [0, 0, 2])], 0.85);
  const circles = [{ x: -6, y: 0, r: 1.5 }, { x: 6, y: 0, r: 1.5 }];

  const untrimmed = computeRaftFootprintPolygons({ circles, raft: DEFAULT_RAFT_SETTINGS });
  const trimmed = computeRaftFootprintPolygons({ circles, raft: DEFAULT_RAFT_SETTINGS, clearance });

  assert.equal(trimmed.length, 0, 'a raft wholly inside the model footprint disappears');
  assert.ok(areaOf(untrimmed) > 0);
});

test('the chamfered base is closed and keeps the hole', () => {
  // Hole wound clockwise, the way Clipper emits them.
  const square: PolygonWithHoles = {
    outer: [
      new THREE.Vector2(-10, -10), new THREE.Vector2(10, -10),
      new THREE.Vector2(10, 10), new THREE.Vector2(-10, 10),
    ],
    holes: [[
      new THREE.Vector2(-3, -3), new THREE.Vector2(-3, 3),
      new THREE.Vector2(3, 3), new THREE.Vector2(3, -3),
    ]],
  };

  const mesh = generateChamferedBaseFromPolygons([square], { thickness: 0.5, chamferAngle: 45 });
  const position = mesh.geometry.getAttribute('position');
  const index = mesh.geometry.getIndex();
  assert.ok(position && index);
  assert.equal(position.count, 16, '8 ring points top and bottom');

  // Every undirected edge has to be shared by exactly two triangles.
  const edgeUse = new Map<string, number>();
  for (let i = 0; i < index.count; i += 3) {
    const tri = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    for (let e = 0; e < 3; e += 1) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  const open = [...edgeUse.entries()].filter(([, uses]) => uses !== 2);
  assert.deepEqual(open, [], `open edges: ${JSON.stringify(open.slice(0, 6))}`);

  // Positive volume: the shell is wound outward. The value is the exact frustum
  // between the 20 mm footprint and its 19 mm inset, minus the 6 → 7 mm hole, so
  // a shell with an inverted hole wall cannot pass by accident.
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let volume = 0;
  for (let i = 0; i < index.count; i += 3) {
    const ia = index.getX(i);
    const ib = index.getX(i + 1);
    const ic = index.getX(i + 2);
    a.set(position.getX(ia), position.getY(ia), position.getZ(ia));
    b.set(position.getX(ib), position.getY(ib), position.getZ(ib));
    c.set(position.getX(ic), position.getY(ic), position.getZ(ic));
    volume += a.dot(new THREE.Vector3().crossVectors(b, c)) / 6;
  }
  assert.ok(Math.abs(volume - 169) < 0.01, `volume ${volume}`);

  // Same solid with the hole wound the other way must give the same shell.
  const reversed: PolygonWithHoles = { outer: square.outer, holes: [square.holes[0].slice().reverse()] };
  const reversedMesh = generateChamferedBaseFromPolygons([reversed], { thickness: 0.5, chamferAngle: 45 });
  const reversedIndex = reversedMesh.geometry.getIndex();
  const reversedPosition = reversedMesh.geometry.getAttribute('position');
  assert.ok(reversedIndex && reversedPosition);
  let reversedVolume = 0;
  for (let i = 0; i < reversedIndex.count; i += 3) {
    const ia = reversedIndex.getX(i);
    const ib = reversedIndex.getX(i + 1);
    const ic = reversedIndex.getX(i + 2);
    a.set(reversedPosition.getX(ia), reversedPosition.getY(ia), reversedPosition.getZ(ia));
    b.set(reversedPosition.getX(ib), reversedPosition.getY(ib), reversedPosition.getZ(ib));
    c.set(reversedPosition.getX(ic), reversedPosition.getY(ic), reversedPosition.getZ(ic));
    reversedVolume += a.dot(new THREE.Vector3().crossVectors(b, c)) / 6;
  }
  assert.ok(Math.abs(reversedVolume - 169) < 0.01, `reversed-hole volume ${reversedVolume}`);
});

test('the raft mesh clears a model standing on the plate, and did not before', () => {
  const box = new THREE.BoxGeometry(20, 20, 4);
  const boxModel = model(box, [0, 0, 2]);
  const circles = [
    { x: -12, y: -12, r: 1.5 },
    { x: 12, y: -12, r: 1.5 },
    { x: 12, y: 12, r: 1.5 },
    { x: -12, y: 12, r: 1.5 },
  ];
  const raft = { ...DEFAULT_RAFT_SETTINGS, wallEnabled: true };

  // The model's plate footprint is a 20 × 20 square about the origin.
  const insideModelXy = (x: number, y: number) => Math.abs(x) < 10 && Math.abs(y) < 10;
  const pointsInside = (polys: readonly PolygonWithHoles[]) => {
    let inside = 0;
    for (const poly of polys) {
      for (const ring of [poly.outer, ...poly.holes]) {
        for (let i = 0; i < ring.length; i += 1) {
          const a = ring[i];
          const b = ring[(i + 1) % ring.length];
          // Sample the edge, not just the corners: a chord can cross the model
          // between two vertices that are both outside it.
          for (let t = 0; t <= 1; t += 0.05) {
            const x = a.x + (b.x - a.x) * t;
            const y = a.y + (b.y - a.y) * t;
            if (insideModelXy(x, y)) inside += 1;
          }
        }
      }
    }
    return inside;
  };

  const withoutClearance = buildRaftFootprintMeshes({ circles, raft });
  const clearance = collectModelPlateFootprint([boxModel], 0.85);
  const withClearance = buildRaftFootprintMeshes({ circles, raft, clearance });

  assert.ok(
    containsPoint(withoutClearance.footprint, 0, 0),
    'without clearance the hull footprint runs under the model',
  );
  assert.ok(!containsPoint(withClearance.footprint, 0, 0), 'the cut is a hole in the raft');
  assert.equal(pointsInside(withClearance.footprint), 0);

  // 20 mm box + 1 mm clearance on every side = a 22 mm hole.
  const removed = areaOf(withoutClearance.footprint) - areaOf(withClearance.footprint);
  assert.ok(removed >= 484 && removed < 493, `removed ${removed}`);

  assert.ok(withClearance.baseMesh, 'the trimmed raft still has a base');
  assert.ok(withClearance.wallMesh, 'the trimmed raft still has a wall');

  const basePosition = withClearance.baseMesh!.geometry.getAttribute('position');
  assert.ok(basePosition.count > 0);
  for (let i = 0; i < basePosition.count; i += 1) {
    assert.ok(
      !insideModelXy(basePosition.getX(i), basePosition.getY(i)),
      `raft vertex (${basePosition.getX(i)}, ${basePosition.getY(i)}) is under the model`,
    );
  }
});

test('a densely tessellated model on the plate stays interactive', () => {
  // The model footprint arrives as one polygon per triangle. Unioning ~3000 of
  // them with Clipper took over a second — a frozen frame while the model loaded.
  // The raster path is the fix, and this guards it with a wide margin: the
  // assertion is that it is interactive, not that it is a specific speed.
  const radius = 10;
  const ball = new THREE.SphereGeometry(radius, 200, 90);
  const triangles = (ball.getIndex()?.count ?? ball.getAttribute('position').count) / 3;
  assert.ok(triangles > 20000, `fixture has ${triangles} triangles`);

  const started = performance.now();
  const footprint = collectModelPlateFootprint([model(ball, [0, 0, radius])], 0.85);
  const elapsed = performance.now() - started;

  assert.equal(footprint.length, 1);
  assert.ok(footprint[0].outer.length >= 3);
  assert.ok(elapsed < 2000, `plate footprint took ${elapsed} ms`);
});

test('a model between two clusters keeps their rafts separate', () => {
  // A wall standing on the plate: 20 mm wide, so its clearance spans x ± 11.
  const wall = new THREE.BoxGeometry(20, 40, 4);
  const clearance = collectModelPlateFootprint([model(wall, [0, 0, 2])], 0.85);
  const circles = [
    { x: -14, y: -4, r: 1.5 }, { x: -16, y: 4, r: 1.5 }, { x: -13, y: 0, r: 1.5 },
    { x: 14, y: -4, r: 1.5 }, { x: 16, y: 4, r: 1.5 }, { x: 13, y: 0, r: 1.5 },
  ];

  const trimmed = computeRaftFootprintPolygons({ circles, raft: DEFAULT_RAFT_SETTINGS, clearance });
  assert.equal(trimmed.length, 2, 'one raft per side, not one wrapped around the wall');
  assert.ok(containsPoint([trimmed[0]], -14, 0) || containsPoint([trimmed[1]], -14, 0));
  assert.ok(containsPoint([trimmed[0]], 14, 0) || containsPoint([trimmed[1]], 14, 0));
  // The hull of a cluster stops where the wall's clearance starts.
  for (const poly of trimmed) {
    for (const point of poly.outer) {
      assert.ok(Math.abs(point.x) > 10.5, `raft point (${point.x}, ${point.y}) crosses the wall`);
    }
  }

  // With nothing in the way the two clusters are one raft, as they always were.
  const untrimmed = computeRaftFootprintPolygons({ circles, raft: DEFAULT_RAFT_SETTINGS });
  assert.equal(untrimmed.length, 1);
  assert.equal(untrimmed[0].holes.length, 0);
});

test('an untrimmed footprint keeps the original generators', () => {
  const circles = [{ x: 0, y: 0, r: 1.5 }, { x: 10, y: 4, r: 1.5 }];
  const raft = { ...DEFAULT_RAFT_SETTINGS };
  const parts = buildRaftFootprintMeshes({ circles, raft });

  assert.equal(parts.footprint.length, 1);
  assert.equal(parts.footprint[0].holes.length, 0);
  assert.ok(parts.baseMesh);
  // The legacy base caps with a fan over one convex ring: 2 × ring length verts.
  assert.equal(parts.baseMesh!.geometry.getAttribute('position').count, parts.footprint[0].outer.length * 2);
  assert.ok(ringToPolygon(parts.footprint[0].outer).outer.length > 2);
});

/** Distance from a point to a triangle, clamped to the triangle's surface. */
function distanceToTriangle(
  p: THREE.Vector3,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
): number {
  const ab = new THREE.Vector3().subVectors(b, a);
  const ac = new THREE.Vector3().subVectors(c, a);
  const ap = new THREE.Vector3().subVectors(p, a);
  const d1 = ab.dot(ap);
  const d2 = ac.dot(ap);
  if (d1 <= 0 && d2 <= 0) return p.distanceTo(a);

  const bp = new THREE.Vector3().subVectors(p, b);
  const d3 = ab.dot(bp);
  const d4 = ac.dot(bp);
  if (d3 >= 0 && d4 <= d3) return p.distanceTo(b);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    return p.distanceTo(new THREE.Vector3().copy(a).addScaledVector(ab, d1 / (d1 - d3)));
  }

  const cp = new THREE.Vector3().subVectors(p, c);
  const d5 = ab.dot(cp);
  const d6 = ac.dot(cp);
  if (d6 >= 0 && d5 <= d6) return p.distanceTo(c);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    return p.distanceTo(new THREE.Vector3().copy(a).addScaledVector(ac, d2 / (d2 - d6)));
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const edge = new THREE.Vector3().subVectors(c, b);
    return p.distanceTo(new THREE.Vector3().copy(b).addScaledVector(edge, (d4 - d3) / ((d4 - d3) + (d5 - d6))));
  }

  const normal = new THREE.Vector3().crossVectors(ab, ac).normalize();
  return Math.abs(normal.dot(ap));
}

test('a ball on the plate: no raft triangle comes within its surface', () => {
  const radius = 10;
  const ball = new THREE.SphereGeometry(radius, 64, 32);
  const center = new THREE.Vector3(0, 0, radius);
  const circles = Array.from({ length: 8 }, (_, i) => {
    const angle = (i / 8) * Math.PI * 2;
    return { x: Math.cos(angle) * 16, y: Math.sin(angle) * 16, r: 1.5 };
  });
  const raft = { ...DEFAULT_RAFT_SETTINGS };

  const clearance = collectModelPlateFootprint([model(ball, [0, 0, radius])], 0.85);
  const parts = buildRaftFootprintMeshes({ circles, raft, clearance });

  // The cut is the ball's footprint over the band, grown 1 mm horizontally, so
  // the hole's radius clears the ball's section at every raft height.
  const holeRing = parts.footprint[0]?.holes[0];
  assert.ok(holeRing && holeRing.length >= 3, 'the ball leaves a hole in the raft');
  const holeRadius = Math.min(...holeRing.map((p) => Math.hypot(p.x, p.y)));
  const sectionRadiusAtRaftTop = Math.sqrt(2 * radius * raft.thickness - raft.thickness ** 2);
  assert.ok(
    holeRadius >= sectionRadiusAtRaftTop + 1 - 0.01,
    `hole radius ${holeRadius} vs section ${sectionRadiusAtRaftTop}`,
  );

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let closest = Infinity;

  for (const mesh of [parts.baseMesh, parts.wallMesh]) {
    if (!mesh) continue;
    const position = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    const triangles = index ? index.count / 3 : position.count / 3;
    for (let t = 0; t < triangles; t += 1) {
      const ia = index ? index.getX(t * 3) : t * 3;
      const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.set(position.getX(ia), position.getY(ia), position.getZ(ia));
      b.set(position.getX(ib), position.getY(ib), position.getZ(ib));
      c.set(position.getX(ic), position.getY(ic), position.getZ(ic));
      closest = Math.min(closest, distanceToTriangle(center, a, b, c));
    }
  }

  // Nothing of the raft reaches the ball's surface.
  assert.ok(closest >= radius, `closest raft surface is ${closest} from the ball's centre`);
});

test('line-mode beams in a model\'s way are never drawn', () => {
  const edges: Array<[THREE.Vector2, THREE.Vector2]> = [
    // Crosses the model footprint: dropped.
    [new THREE.Vector2(-10, 0), new THREE.Vector2(10, 0)],
    // Clears it: kept.
    [new THREE.Vector2(-10, 8), new THREE.Vector2(10, 8)],
  ];
  // The cut is the model's footprint grown by the 1 mm clearance, so the model
  // itself is the 1 mm-smaller square.
  const cut: PolygonWithHoles[] = [{
    outer: [
      new THREE.Vector2(-2, -2), new THREE.Vector2(2, -2),
      new THREE.Vector2(2, 2), new THREE.Vector2(-2, 2),
    ],
    holes: [],
  }];

  const kept = filterLineRaftEdges(edges, cut, 1.5);
  assert.equal(kept.length, 1, 'only the beam that clears the model survives');
  assert.equal(kept[0][0].y, 8);

  // Half a beam width of daylight is not enough: the beam would overlap the cut.
  const grazing = filterLineRaftEdges(
    [[new THREE.Vector2(-10, 2.5), new THREE.Vector2(10, 2.5)]],
    cut,
    1.5,
  );
  assert.equal(grazing.length, 0);

  const mesh = generateUnionedLineRaftMesh(kept, {
    widthMm: 1.5,
    heightMm: 0.6,
    borderProfile: null,
  });
  const position = mesh.geometry.getAttribute('position');
  assert.ok(position.count > 0);
  for (let i = 0; i < position.count; i += 1) {
    assert.ok(
      !(Math.abs(position.getX(i)) < 1 && Math.abs(position.getY(i)) < 1),
      `beam vertex (${position.getX(i)}, ${position.getY(i)}) is inside the model`,
    );
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { generateCrenelatedWallManual } from '../generateCrenelatedWallManual';
import { raftWallBaseHeightMm } from '../computeRaftFootprint';
import { DEFAULT_RAFT_SETTINGS } from '../../RaftDefaults';

// Footprints of one raft trimmed by a neighbouring model's clearance, taken from
// a scene where scaling that model made the raft lose its lip. The cut leaves a
// notch at the front (y ≈ -17) with edges far shorter than the wall thickness,
// so the inset of the outer ring folds over itself there.
const NOTCH_WITH_SHORT_EDGES: Array<[number, number]> = [
  [-0.811, -18.097], [0.259, -17.027], [2.692, -17.027], [3.313, -17.648], [3.372, -17.507],
  [3.43, -17.066], [3.388, -16.749], [9.829, -12.29], [10.182, -12.019], [10.452, -11.667],
  [10.622, -11.257], [12.872, -0.257], [12.93, 0.184], [12.878, 16.717], [12.82, 17.158],
  [12.65, 17.568], [12.379, 17.92], [12.027, 18.191], [11.617, 18.361], [-1.23, 20.449],
  [-1.67, 20.507], [-2.111, 20.449], [-2.521, 20.279], [-2.874, 20.008], [-3.144, 19.656],
  [-11.495, 5.784], [-11.665, 5.374], [-12.915, 1.874], [-12.973, 1.434], [-12.723, -2.316],
  [-12.665, -2.757], [-11.415, -9.007], [-11.245, -9.417], [-9.495, -12.167], [-9.224, -12.519],
  [-2.754, -18.097],
];

const NOTCH_WITH_SLIVER_EDGE: Array<[number, number]> = [
  [2.039, -17.47], [2.879, -18.31], [2.932, -18.269], [10.182, -12.019], [10.452, -11.667],
  [10.622, -11.257], [12.872, -0.257], [12.93, 0.184], [12.878, 16.717], [12.82, 17.158],
  [12.65, 17.568], [12.379, 17.92], [12.027, 18.191], [11.617, 18.361], [-1.23, 20.449],
  [-1.67, 20.507], [-2.111, 20.449], [-2.521, 20.279], [-2.874, 20.008], [-3.144, 19.656],
  [-11.495, 5.784], [-11.665, 5.374], [-12.915, 1.874], [-12.973, 1.434], [-12.723, -2.316],
  [-12.665, -2.757], [-11.415, -9.007], [-11.245, -9.417], [-9.495, -12.167], [-9.224, -12.519],
  [-2.24, -18.539],
];

const raft = DEFAULT_RAFT_SETTINGS;
const wallSettings = {
  wallHeight: raft.wallHeight,
  wallThickness: raft.wallThickness,
  crenulationGapWidth: raft.crenulationGapWidth,
  crenulationSpacing: raft.crenulationSpacing,
  thickness: raftWallBaseHeightMm(raft),
  chamferAngle: raft.chamferAngle,
};
// How far the top of the wall leans out past the footprint: the lip.
const lipMm = raft.wallHeight / Math.tan((raft.chamferAngle * Math.PI) / 180);

function wallFor(ring: Array<[number, number]>) {
  const outer = ring.map(([x, y]) => new THREE.Vector2(x, y));
  const mesh = generateCrenelatedWallManual(outer, wallSettings);
  mesh.geometry.computeBoundingBox();
  const footprint = new THREE.Box2().setFromPoints(outer);
  return { geometry: mesh.geometry, bounds: mesh.geometry.boundingBox!, footprint };
}

for (const [name, ring] of [
  ['short edges', NOTCH_WITH_SHORT_EDGES],
  ['a sliver edge', NOTCH_WITH_SLIVER_EDGE],
] as const) {
  test(`a raft wall keeps its lip when a clearance notch with ${name} cuts the footprint`, () => {
    const { bounds, footprint } = wallFor(ring);

    // The notch is at the front; the back and both sides are untouched hull, so
    // the lip must lean out there by its full width, as on an uncut raft.
    const tolerance = 0.05;
    assert.ok(bounds.min.x <= footprint.min.x - lipMm + tolerance, `left lip: ${bounds.min.x} vs ${footprint.min.x}`);
    assert.ok(bounds.max.x >= footprint.max.x + lipMm - tolerance, `right lip: ${bounds.max.x} vs ${footprint.max.x}`);
    assert.ok(bounds.max.y >= footprint.max.y + lipMm - tolerance, `back lip: ${bounds.max.y} vs ${footprint.max.y}`);
  });

  test(`a raft wall cut by a clearance notch with ${name} keeps its drain channels`, () => {
    const { geometry } = wallFor(ring);
    const position = geometry.getAttribute('position');

    // A drain channel is a gap in the wall: two vertical end faces facing each
    // other across it. Count wall vertices lying on the long right-hand edge
    // (x ≈ 12.9, from y ≈ 0.2 to 16.7) at the base of the wall; a continuous
    // wall has only the edge's two ends there, a channel adds two more.
    const zBase = wallSettings.thickness;
    const ys = new Set<string>();
    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      if (Math.abs(z - zBase) > 1e-4 || y < 0.3 || y > 16.6) continue;
      if (Math.abs(x - (12.93 + (12.878 - 12.93) * ((y - 0.184) / (16.717 - 0.184)))) > 1e-3) continue;
      ys.add(y.toFixed(3));
    }
    assert.ok(ys.size >= 2, `expected a channel on the long right edge, found base vertices at y=${[...ys].join(',')}`);
  });
}

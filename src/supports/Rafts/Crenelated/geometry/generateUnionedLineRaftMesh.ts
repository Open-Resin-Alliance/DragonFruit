import * as THREE from 'three';
import { FootprintProfile } from '../RaftTypes';
import { insetConvexPolygon } from './insetConvexPolygon';
import { generateChamferedBaseFromPolygons } from './generateRaftFromFootprint';
import {
  polygonSetContains,
  polygonSetToShapes,
  ringToPolygon,
  segmentDistanceMm,
  unionPolygonSets,
  type PolygonWithHoles,
} from './polygonSet2d';

/**
 * Line-mode raft: the beam network between support roots, unioned into one solid
 * (Clipper union, holes preserved). Beams a model standing on the plate is in the
 * way of are filtered out beforehand — see `filterLineRaftEdges`.
 */

/** Beam rectangle around `a → b`, extended by half a width at each end. */
function buildBeamRing(a: THREE.Vector2, b: THREE.Vector2, widthMm: number): THREE.Vector2[] {
  const halfWidth = Math.max(0.001, widthMm / 2);
  const dir = new THREE.Vector2().subVectors(b, a);
  const length = dir.length();
  if (!Number.isFinite(length) || length < 1e-6) return [];
  dir.multiplyScalar(1 / length);

  // Extend both ends by half a width to create square caps: adjacent beams then
  // overlap in area rather than merely touching at a point, which keeps the
  // union manifold.
  const start = new THREE.Vector2().copy(a).addScaledVector(dir, -halfWidth);
  const end = new THREE.Vector2().copy(b).addScaledVector(dir, halfWidth);
  const normal = new THREE.Vector2(-dir.y, dir.x);

  return [
    new THREE.Vector2().copy(start).addScaledVector(normal, halfWidth),
    new THREE.Vector2().copy(end).addScaledVector(normal, halfWidth),
    new THREE.Vector2().copy(end).addScaledVector(normal, -halfWidth),
    new THREE.Vector2().copy(start).addScaledVector(normal, -halfWidth),
  ];
}

/**
 * Drop the beams that a model standing on the plate is in the way of.
 *
 * Cutting the beams instead would leave severed ends that have to be closed up
 * again, and a beam that was never drawn leaves the network reading as finished:
 * two clusters on opposite sides of a model stay two clusters, exactly as if the
 * model had pushed them apart. A beam whose line passes within half a beam width
 * of the clearance counts as in the way, since its own width would overlap it.
 */
export function filterLineRaftEdges(
  edges: ReadonlyArray<readonly [THREE.Vector2, THREE.Vector2]>,
  clearance: readonly PolygonWithHoles[] | null | undefined,
  beamWidthMm: number,
): Array<[THREE.Vector2, THREE.Vector2]> {
  const kept: Array<[THREE.Vector2, THREE.Vector2]> = edges.map(([a, b]) => [a, b]);
  if (!clearance || clearance.length === 0) return kept;

  const margin = Math.max(0, beamWidthMm) / 2;

  return kept.filter(([a, b]) => {
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    if (polygonSetContains(clearance, a.x, a.y)) return false;
    if (polygonSetContains(clearance, b.x, b.y)) return false;
    if (polygonSetContains(clearance, midX, midY)) return false;

    for (const poly of clearance) {
      for (const ring of [poly.outer, ...poly.holes]) {
        for (let i = 0; i < ring.length; i += 1) {
          const c = ring[i];
          const d = ring[(i + 1) % ring.length];
          if (segmentDistanceMm(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y) <= margin) return false;
        }
      }
    }
    return true;
  });
}

export function generateUnionedLineRaftMesh(
  edges: Array<[THREE.Vector2, THREE.Vector2]>,
  settings: {
    widthMm: number;
    heightMm: number;
    borderProfile?: FootprintProfile | null;
    chamferAngleDeg?: number;
  }
): THREE.Mesh {
  const width = Math.max(0.001, settings.widthMm);
  const height = Math.max(0.001, settings.heightMm);

  const subjects: PolygonWithHoles[] = [];
  for (const [a, b] of edges) {
    const ring = buildBeamRing(a, b, width);
    if (ring.length >= 3) subjects.push(ringToPolygon(ring));
  }

  // Border ring as a polygon with a hole.
  if (settings.borderProfile && settings.borderProfile.length >= 3) {
    const outer = settings.borderProfile.map((p) => new THREE.Vector2(p.x, p.y));
    const inner = insetConvexPolygon(outer, width);
    if (inner.length >= 3) subjects.push({ outer, holes: [inner] });
  }

  if (subjects.length === 0) return new THREE.Mesh(new THREE.BufferGeometry());

  const polys = unionPolygonSets(subjects);
  if (polys.length === 0) return new THREE.Mesh(new THREE.BufferGeometry());

  const angleDeg = settings.chamferAngleDeg;
  const useChamfer = typeof angleDeg === 'number' && Number.isFinite(angleDeg) && angleDeg < 89.999;

  if (!useChamfer) {
    const geometry = new THREE.ExtrudeGeometry(polygonSetToShapes(polys), {
      depth: height,
      bevelEnabled: false,
      curveSegments: 24,
    });
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry);
  }

  const chamfered = generateChamferedBaseFromPolygons(polys, {
    thickness: height,
    chamferAngle: angleDeg,
  });
  const position = chamfered.geometry.getAttribute('position');
  if (position && position.count > 0) return chamfered;

  const geometry = new THREE.ExtrudeGeometry(polygonSetToShapes(polys), {
    depth: height,
    bevelEnabled: false,
    curveSegments: 24,
  });
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry);
}

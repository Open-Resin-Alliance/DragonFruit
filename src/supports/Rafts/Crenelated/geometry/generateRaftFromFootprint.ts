import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RaftSettings, SupportBaseCircle } from '../RaftTypes';
import { generateChamferedBase } from './generateChamferedBase';
import { generatePerimeterWall } from './generatePerimeterWall';
import { generateCrenelatedWallManual } from './generateCrenelatedWallManual';
import { insetConvexPolygon } from './insetConvexPolygon';
import { signedArea2d } from './signedArea2d';
import { computeRaftFootprintPolygons, raftWallBaseHeightMm } from './computeRaftFootprint';
import type { PolygonWithHoles } from './polygonSet2d';

/**
 * Raft meshes from a footprint polygon set (see `computeRaftFootprint.ts`).
 *
 * The untrimmed footprint — one convex ring, the common case for a scene whose
 * models are lifted off the plate — keeps using the original generators, so its
 * geometry is bit-for-bit what it has always been. A trimmed footprint (holes or
 * several lobes) goes through the set-aware builders here.
 *
 * Both paths are reached through `buildRaftFootprintMeshes`, which is the single
 * seam the viewport, the exporter and the slicer share: preview and sliced raft
 * cannot disagree about the clearance.
 */

type FootprintRing = { ring: THREE.Vector2[]; isHole: boolean };

function footprintRings(polys: readonly PolygonWithHoles[]): FootprintRing[] {
  const rings: FootprintRing[] = [];
  for (const poly of polys) {
    if (poly.outer.length >= 3) rings.push({ ring: poly.outer, isHole: false });
    for (const hole of poly.holes) {
      if (hole.length >= 3) rings.push({ ring: hole, isHole: true });
    }
  }
  return rings;
}

function clampAngle(angle: number): number {
  return Math.min(90, Math.max(45, Number.isFinite(angle) ? angle : 90));
}

/**
 * Move a ring toward the solid by `distanceMm` (holes grow outward instead of
 * shrinking) with a clamped miter, so a tight concave corner — which the
 * clearance cut can produce — cannot fold the ring over itself.
 */
function insetRingForSolidSide(
  ring: readonly THREE.Vector2[],
  isHole: boolean,
  distanceMm: number,
): THREE.Vector2[] {
  const inset = insetConvexPolygon(ring as THREE.Vector2[], isHole ? -distanceMm : distanceMm);
  if (inset.length !== ring.length) return ring.map((p) => p.clone());

  const maxShift = Math.max(distanceMm * 4, 1e-4);
  return inset.map((point, index) => {
    const dx = point.x - ring[index].x;
    const dy = point.y - ring[index].y;
    const length = Math.hypot(dx, dy);
    if (length <= maxShift || length === 0) return point;
    const scale = maxShift / length;
    return new THREE.Vector2(ring[index].x + dx * scale, ring[index].y + dy * scale);
  });
}

/**
 * Chamfered raft base for a polygon set: top face is the footprint, bottom face is
 * the footprint moved inward by the chamfer, so the outer wall flares out toward
 * the top. Holes flare the other way — the bottom face opens up around the
 * clearance cut, which keeps the 1 mm gap to the model at every height.
 */
export function generateChamferedBaseFromPolygons(
  polys: readonly PolygonWithHoles[],
  settings: Pick<RaftSettings, 'thickness' | 'chamferAngle'>,
): THREE.Mesh {
  const thickness = Math.max(0, settings.thickness);
  const rings = footprintRings(polys);
  if (thickness === 0 || rings.length === 0) return new THREE.Mesh(new THREE.BufferGeometry());

  const inset = thickness * Math.tan((Math.PI / 180) * (90 - clampAngle(settings.chamferAngle)));

  const positions: number[] = [];
  const indices: number[] = [];
  const layouts: Array<{ poly: PolygonWithHoles; outerStart: number; holeStarts: number[] }> = [];

  // Top block: every ring at the full footprint, outer then its holes, so the cap
  // triangulation's index layout ([contour, ...holes]) maps straight onto it.
  let vertexCount = 0;
  for (const poly of polys) {
    const outerStart = vertexCount;
    for (const point of poly.outer) positions.push(point.x, point.y, thickness);
    vertexCount += poly.outer.length;

    const holeStarts: number[] = [];
    for (const hole of poly.holes) {
      holeStarts.push(vertexCount);
      for (const point of hole) positions.push(point.x, point.y, thickness);
      vertexCount += hole.length;
    }
    layouts.push({ poly, outerStart, holeStarts });
  }

  // Bottom block: same layout, moved toward the solid by the chamfer.
  const bottomBase = vertexCount;
  for (const poly of polys) {
    for (const point of insetRingForSolidSide(poly.outer, false, inset)) {
      positions.push(point.x, point.y, 0);
    }
    for (const hole of poly.holes) {
      for (const point of insetRingForSolidSide(hole, true, inset)) {
        positions.push(point.x, point.y, 0);
      }
    }
  }

  for (const { poly, outerStart } of layouts) {
    const ringEntries: FootprintRing[] = [
      { ring: poly.outer, isHole: false },
      ...poly.holes.map((hole) => ({ ring: hole, isHole: true })),
    ];
    let ringStart = outerStart;

    for (const { ring, isHole } of ringEntries) {
      const topStart = ringStart;
      const bottomStart = bottomBase + topStart;
      // A ring is wound for its role when an outer runs counter-clockwise (solid
      // on its left) and a hole clockwise. Clipper emits exactly that, but an
      // inverted ring would otherwise produce a shell with inward normals, so the
      // winding decides the quad order rather than the outer/hole flag alone.
      const flip = isHole === (signedArea2d(ring) > 0);
      for (let i = 0; i < ring.length; i += 1) {
        const next = (i + 1) % ring.length;
        const a = topStart + i;
        const b = topStart + next;
        const c = bottomStart + next;
        const d = bottomStart + i;
        if (flip) {
          indices.push(a, b, c, a, c, d);
        } else {
          indices.push(a, c, b, a, d, c);
        }
      }
      ringStart += ring.length;
    }
  }

  for (const { poly, outerStart, holeStarts } of layouts) {
    // triangulateShape numbers its result over [outer, hole0, hole1, ...]; map
    // that layout back onto this polygon's vertices once.
    const contourToVertex: number[] = [];
    for (let i = 0; i < poly.outer.length; i += 1) contourToVertex.push(outerStart + i);
    for (let holeIndex = 0; holeIndex < poly.holes.length; holeIndex += 1) {
      for (let i = 0; i < poly.holes[holeIndex].length; i += 1) {
        contourToVertex.push(holeStarts[holeIndex] + i);
      }
    }

    for (const triangle of THREE.ShapeUtils.triangulateShape(poly.outer, poly.holes)) {
      const mapped = triangle.map((index) => contourToVertex[index]);
      if (mapped.some((index) => index === undefined)) continue;

      indices.push(mapped[0], mapped[1], mapped[2]);
      // Bottom cap, reversed winding, same vertices in the bottom block.
      indices.push(bottomBase + mapped[0], bottomBase + mapped[2], bottomBase + mapped[1]);
    }
  }

  if (!positions.every((value) => Number.isFinite(value))) {
    return new THREE.Mesh(new THREE.BufferGeometry());
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry);
}

function mergeWallParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  // mergeGeometries refuses mixed indexed/non-indexed or mixed attribute sets:
  // the crenelated wall is indexed, ExtrudeGeometry's is not, and only one of
  // them carries UVs.
  const prepared: THREE.BufferGeometry[] = [];
  for (const geometry of parts) {
    const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    if (!nonIndexed) continue;
    for (const name of Object.keys(nonIndexed.attributes)) {
      if (name !== 'position' && name !== 'normal') nonIndexed.deleteAttribute(name);
    }
    if (!nonIndexed.getAttribute('normal')) nonIndexed.computeVertexNormals();
    prepared.push(nonIndexed);
  }
  if (prepared.length === 0) return null;
  return mergeGeometries(prepared, false);
}

/**
 * Perimeter wall around every outer ring of the set — holes are skipped: the
 * clearance cut is not the raft's perimeter, and the base closes that face.
 */
export function generateWallFromPolygons(
  polys: readonly PolygonWithHoles[],
  settings: Pick<RaftSettings, 'thickness' | 'chamferAngle' | 'wallHeight' | 'wallThickness' | 'crenulationGapWidth' | 'crenulationSpacing'>,
): THREE.Mesh | null {
  const wallHeight = Math.max(0, settings.wallHeight);
  const wallThickness = Math.max(0, settings.wallThickness);
  if (wallHeight === 0 || wallThickness === 0) return null;

  const useCrenels = settings.crenulationSpacing > 0 && settings.crenulationGapWidth > 0;
  const parts: THREE.BufferGeometry[] = [];

  for (const poly of polys) {
    if (poly.outer.length < 3) continue;
    const mesh = useCrenels
      ? generateCrenelatedWallManual(poly.outer, {
        wallHeight,
        wallThickness,
        crenulationGapWidth: settings.crenulationGapWidth,
        crenulationSpacing: settings.crenulationSpacing,
        thickness: settings.thickness,
        chamferAngle: settings.chamferAngle,
      })
      : generatePerimeterWall(poly.outer, { wallHeight, wallThickness, thickness: settings.thickness });

    const position = mesh.geometry.getAttribute('position');
    if (position && position.count > 0) parts.push(mesh.geometry);
    else mesh.geometry.dispose();
  }

  if (parts.length === 0) return null;
  const merged = mergeWallParts(parts);
  for (const part of parts) part.dispose();
  if (!merged) return null;

  merged.computeVertexNormals();
  return new THREE.Mesh(merged);
}

export function isUntrimmedFootprint(polys: readonly PolygonWithHoles[]): boolean {
  return polys.length === 1 && polys[0].holes.length === 0;
}

export type RaftFootprintMeshes = {
  footprint: PolygonWithHoles[];
  baseMesh: THREE.Mesh | null;
  wallMesh: THREE.Mesh | null;
};

/**
 * The shared raft builder: footprint (hull minus model clearance), base plate and
 * perimeter wall for the solid modes. Line mode builds its beams from the same
 * footprint via `generateUnionedLineRaftMesh`.
 */
export function buildRaftFootprintMeshes(args: {
  circles: readonly SupportBaseCircle[];
  raft: RaftSettings;
  clearance?: readonly PolygonWithHoles[] | null;
}): RaftFootprintMeshes {
  const { circles, raft } = args;
  const footprint = computeRaftFootprintPolygons({
    circles,
    raft,
    clearance: args.clearance,
  });
  if (footprint.length === 0) return { footprint, baseMesh: null, wallMesh: null };

  const untrimmed = isUntrimmedFootprint(footprint);
  const useCrenels = raft.crenulationSpacing > 0 && raft.crenulationGapWidth > 0;
  const wallBaseHeight = raftWallBaseHeightMm(raft);

  let baseMesh: THREE.Mesh | null = null;
  if (raft.bottomMode === 'solid') {
    baseMesh = untrimmed
      ? generateChamferedBase(footprint[0].outer, {
        thickness: raft.thickness,
        chamferAngle: raft.chamferAngle,
      })
      : generateChamferedBaseFromPolygons(footprint, {
        thickness: raft.thickness,
        chamferAngle: raft.chamferAngle,
      });
  }

  let wallMesh: THREE.Mesh | null = null;
  if (raft.wallEnabled) {
    if (untrimmed) {
      const profile = footprint[0].outer;
      wallMesh = useCrenels
        ? generateCrenelatedWallManual(profile, {
          wallHeight: raft.wallHeight,
          wallThickness: raft.wallThickness,
          crenulationGapWidth: raft.crenulationGapWidth,
          crenulationSpacing: raft.crenulationSpacing,
          thickness: wallBaseHeight,
          chamferAngle: raft.chamferAngle,
        })
        : generatePerimeterWall(profile, {
          wallHeight: raft.wallHeight,
          wallThickness: raft.wallThickness,
          thickness: wallBaseHeight,
        });
    } else {
      wallMesh = generateWallFromPolygons(footprint, {
        thickness: wallBaseHeight,
        chamferAngle: raft.chamferAngle,
        wallHeight: raft.wallHeight,
        wallThickness: raft.wallThickness,
        crenulationGapWidth: raft.crenulationGapWidth,
        crenulationSpacing: raft.crenulationSpacing,
      });
    }
  }

  return { footprint, baseMesh, wallMesh };
}

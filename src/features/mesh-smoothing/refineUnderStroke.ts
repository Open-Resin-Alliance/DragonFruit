import * as THREE from 'three';
import { quantizeToCell } from '@/utils/math';

/**
 * Splitting the faces a smoothing stroke covers, so the brush has vertices to move.
 *
 * Smoothing moves vertices and nothing else, so it can only reshape a surface where the
 * mesh has them. The model's mesh is the one it edits, read as its file wrote it, and a
 * coarse mesh has a handful: on a 12-triangle cube a stroke over a corner moves that one
 * corner and tilts the three faces that meet there, all the way across. The stroke's faces
 * are split first, down to an edge no longer than the brush radius, and only near the
 * stroke: the rest of the mesh, and every triangle id outside the stroke, is left as it
 * was. The surface does not move — an edge is split at its midpoint — so the copy is the
 * model's own shape with more vertices where the brush is about to work.
 */

/** Longest edge left under the brush, as a fraction of its radius. */
export const STROKE_EDGE_PER_RADIUS = 1;
/**
 * Passes of splitting. Each halves the longest edge of the faces it touches, so this
 * reaches a brush-sized edge from a face 2^16 times longer: a 0.1mm brush on a face
 * several metres across.
 */
const MAX_PASSES = 16;
/** Triangles one stroke may add. A stroke is a brush-wide band; this is a long one. */
export const STROKE_REFINE_MAX_ADDED_TRIANGLES = 200_000;
/** The smoothing topology's weld tolerance (`topologyCache`), so the two agree. */
const WELD_TOLERANCE = 1e-4;
/** Vertex ids fit 26 bits, so an edge key `a * 2^26 + b` stays an exact double. */
const EDGE_KEY_BASE = 2 ** 26;

const edgeKey = (a: number, b: number): number => (a < b ? a * EDGE_KEY_BASE + b : b * EDGE_KEY_BASE + a);

/**
 * The mesh with the faces near the stroke split until no edge there is longer than
 * `maxEdge`, or `null` when there is nothing to split (the common case) or the mesh is
 * one this does not rebuild — per-vertex data beyond position and normal, or more than
 * one material group, which the split would have to invent.
 *
 * `samples` are the stroke's brush centres, xyz in the geometry's own space; a face is
 * near when it comes within `radius` of one. Triangle `i` of the input is triangle `i` of
 * the output, or the first of its pieces when it was split; the other pieces are
 * appended. The result is a non-indexed soup with face normals and a bounding box.
 */
export function refineUnderStroke(
  geometry: THREE.BufferGeometry,
  samples: ArrayLike<number>,
  radius: number,
  maxEdge: number,
): THREE.BufferGeometry | null {
  const source = geometry.getAttribute('position');
  if (!source || source.itemSize !== 3 || source.count === 0) return null;
  if (!(radius > 0) || !(maxEdge > 0) || samples.length < 3) return null;
  for (const name of Object.keys(geometry.attributes)) {
    if (name !== 'position' && name !== 'normal') return null;
  }

  const index = geometry.getIndex();
  const cornerCount = index ? index.count : source.count;
  const triangleCount = Math.floor(cornerCount / 3);
  // One material over the whole mesh (what the importers give) carries over; several
  // would need the split to say which piece belongs to which.
  if (geometry.groups.length > 1) return null;
  const [group] = geometry.groups;
  if (group && (group.start !== 0 || group.count < cornerCount)) return null;

  const strokeBox = new THREE.Box3();
  const point = new THREE.Vector3();
  for (let i = 0; i + 2 < samples.length; i += 3) {
    strokeBox.expandByPoint(point.set(samples[i], samples[i + 1], samples[i + 2]));
  }
  strokeBox.expandByScalar(radius);

  // Every stroke on every mesh asks, and most have nothing to split: answer that from
  // the corners as they are, before paying to weld the mesh.
  if (!anyLongFaceNear(source, index, triangleCount, strokeBox, maxEdge)) return null;

  // Weld, so a split edge is split for both faces that share it.
  const positions: number[] = [];
  const welded = new Map<string, number>();
  const cornerIds = new Array<number>(triangleCount * 3);
  for (let corner = 0; corner < triangleCount * 3; corner++) {
    const vertex = index ? index.getX(corner) : corner;
    const x = source.getX(vertex);
    const y = source.getY(vertex);
    const z = source.getZ(vertex);
    const key = `${quantizeToCell(x, WELD_TOLERANCE)},${quantizeToCell(y, WELD_TOLERANCE)},${quantizeToCell(z, WELD_TOLERANCE)}`;
    let id = welded.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      positions.push(x, y, z);
      welded.set(key, id);
    }
    cornerIds[corner] = id;
  }
  if (positions.length / 3 >= EDGE_KEY_BASE) return null;

  const corners = cornerIds; // corners[3t + k]: the welded vertex at corner k of triangle t
  const triangle = new THREE.Triangle();
  const faceBox = new THREE.Box3();
  const closest = new THREE.Vector3();
  const radiusSquared = radius * radius;
  const maxEdgeSquared = maxEdge * maxEdge;

  const vertexAt = (id: number, into: THREE.Vector3) =>
    into.set(positions[id * 3], positions[id * 3 + 1], positions[id * 3 + 2]);
  const lengthSquared = (a: number, b: number) => {
    const dx = positions[a * 3] - positions[b * 3];
    const dy = positions[a * 3 + 1] - positions[b * 3 + 1];
    const dz = positions[a * 3 + 2] - positions[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };
  /** Corner `k` whose edge (k, k+1) is the triangle's longest, if it is too long. */
  const tooLongEdge = (t: number): number => {
    let longest = -1;
    let longestSquared = maxEdgeSquared;
    for (let k = 0; k < 3; k++) {
      const squared = lengthSquared(corners[t * 3 + k], corners[t * 3 + ((k + 1) % 3)]);
      if (squared > longestSquared) {
        longestSquared = squared;
        longest = k;
      }
    }
    return longest;
  };
  const isNearStroke = (t: number): boolean => {
    vertexAt(corners[t * 3], triangle.a);
    vertexAt(corners[t * 3 + 1], triangle.b);
    vertexAt(corners[t * 3 + 2], triangle.c);
    faceBox.makeEmpty().expandByPoint(triangle.a).expandByPoint(triangle.b).expandByPoint(triangle.c);
    if (!faceBox.intersectsBox(strokeBox)) return false;
    for (let i = 0; i + 2 < samples.length; i += 3) {
      point.set(samples[i], samples[i + 1], samples[i + 2]);
      if (point.distanceToSquared(faceBox.clampPoint(point, closest)) > radiusSquared) continue;
      triangle.closestPointToPoint(point, closest);
      if (closest.distanceToSquared(point) <= radiusSquared) return true;
    }
    return false;
  };

  let candidates: number[] = [];
  for (let t = 0; t < triangleCount; t++) {
    if (tooLongEdge(t) >= 0 && isNearStroke(t)) candidates.push(t);
  }
  if (candidates.length === 0) return null;

  // Which triangles hold each edge, so a split reaches the face on its other side.
  const facesOfEdge = new Map<number, number[]>();
  const addFace = (t: number) => {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(corners[t * 3 + k], corners[t * 3 + ((k + 1) % 3)]);
      const faces = facesOfEdge.get(key);
      if (faces) faces.push(t);
      else facesOfEdge.set(key, [t]);
    }
  };
  const removeFace = (t: number) => {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(corners[t * 3 + k], corners[t * 3 + ((k + 1) % 3)]);
      const faces = facesOfEdge.get(key);
      if (!faces) continue;
      const at = faces.indexOf(t);
      if (at >= 0) faces.splice(at, 1);
      if (faces.length === 0) facesOfEdge.delete(key);
    }
  };
  for (let t = 0; t < triangleCount; t++) addFace(t);

  let triangles = triangleCount;
  const budget = triangleCount + STROKE_REFINE_MAX_ADDED_TRIANGLES;
  for (let pass = 0; pass < MAX_PASSES && candidates.length > 0 && triangles < budget; pass++) {
    // Each candidate's longest edge, given one shared midpoint.
    const midpoints = new Map<number, number>();
    for (const t of candidates) {
      const k = tooLongEdge(t);
      if (k < 0) continue;
      const a = corners[t * 3 + k];
      const b = corners[t * 3 + ((k + 1) % 3)];
      const key = edgeKey(a, b);
      if (midpoints.has(key)) continue;
      midpoints.set(key, positions.length / 3);
      positions.push(
        (positions[a * 3] + positions[b * 3]) / 2,
        (positions[a * 3 + 1] + positions[b * 3 + 1]) / 2,
        (positions[a * 3 + 2] + positions[b * 3 + 2]) / 2,
      );
    }
    if (positions.length / 3 >= EDGE_KEY_BASE) break;

    // Every face on a split edge is split, the candidates and their neighbours alike.
    const toSplit = new Set<number>();
    for (const key of midpoints.keys()) {
      for (const t of facesOfEdge.get(key) ?? []) toSplit.add(t);
    }

    const pieces: number[] = [];
    for (const t of toSplit) {
      const v = [corners[t * 3], corners[t * 3 + 1], corners[t * 3 + 2]];
      const m = [0, 1, 2].map((k) => midpoints.get(edgeKey(v[k], v[(k + 1) % 3])) ?? -1);
      const split = m.filter((id) => id >= 0).length;
      // Rotate so the split edges come first: (0,1) alone, or (0,1) and (1,2).
      let r = 0;
      if (split === 1) r = m.findIndex((id) => id >= 0);
      else if (split === 2) r = (m.findIndex((id) => id < 0) + 1) % 3;
      const [v0, v1, v2] = [v[r], v[(r + 1) % 3], v[(r + 2) % 3]];
      const [m0, m1, m2] = [m[r], m[(r + 1) % 3], m[(r + 2) % 3]];
      const faces: number[][] = split === 1
        ? [[v0, m0, v2], [m0, v1, v2]]
        : split === 2
          ? [[v0, m0, m1], [m0, v1, m1], [v0, m1, v2]]
          : [[v0, m0, m2], [m0, v1, m1], [m2, m1, v2], [m0, m1, m2]];

      removeFace(t);
      faces.forEach((face, i) => {
        const slot = i === 0 ? t : triangles++;
        corners[slot * 3] = face[0];
        corners[slot * 3 + 1] = face[1];
        corners[slot * 3 + 2] = face[2];
        addFace(slot);
        pieces.push(slot);
      });
    }

    candidates = pieces.filter((t) => tooLongEdge(t) >= 0 && isNearStroke(t));
  }

  const soup = new Float32Array(triangles * 9);
  for (let corner = 0; corner < triangles * 3; corner++) {
    const id = corners[corner];
    soup[corner * 3] = positions[id * 3];
    soup[corner * 3 + 1] = positions[id * 3 + 1];
    soup[corner * 3 + 2] = positions[id * 3 + 2];
  }
  const refined = new THREE.BufferGeometry();
  refined.setAttribute('position', new THREE.BufferAttribute(soup, 3));
  if (group) refined.addGroup(0, triangles * 3, group.materialIndex);
  refined.computeVertexNormals();
  refined.computeBoundingBox();
  refined.computeBoundingSphere();
  return refined;
}

/**
 * Whether any face with an edge over `maxEdge` has its bounding box inside the stroke's:
 * the cheap, conservative half of the test, on the unwelded corners.
 */
function anyLongFaceNear(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: THREE.BufferAttribute | null,
  triangleCount: number,
  strokeBox: THREE.Box3,
  maxEdge: number,
): boolean {
  const maxEdgeSquared = maxEdge * maxEdge;
  const { min, max } = strokeBox;
  const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (let t = 0; t < triangleCount; t++) {
    for (let k = 0; k < 3; k++) {
      p[k].fromBufferAttribute(position, index ? index.getX(t * 3 + k) : t * 3 + k);
    }
    if (Math.max(p[0].x, p[1].x, p[2].x) < min.x || Math.min(p[0].x, p[1].x, p[2].x) > max.x) continue;
    if (Math.max(p[0].y, p[1].y, p[2].y) < min.y || Math.min(p[0].y, p[1].y, p[2].y) > max.y) continue;
    if (Math.max(p[0].z, p[1].z, p[2].z) < min.z || Math.min(p[0].z, p[1].z, p[2].z) > max.z) continue;
    if (
      p[0].distanceToSquared(p[1]) > maxEdgeSquared
      || p[1].distanceToSquared(p[2]) > maxEdgeSquared
      || p[2].distanceToSquared(p[0]) > maxEdgeSquared
    ) return true;
  }
  return false;
}

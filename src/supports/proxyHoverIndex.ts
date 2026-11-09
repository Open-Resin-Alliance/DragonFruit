import * as THREE from 'three';
import type { Vec3 } from './types';

/**
 * Hover picking for the proxy support batches.
 *
 * The batches cannot answer a raycast per instance: three walks every instance of
 * an `InstancedMesh` once the mesh's bounding sphere is hit, and a support batch
 * spans the plate, so a hover costs O(supports) on every pointer move. Nor can a
 * box per model stand in for them: it covers the gaps between supports, so
 * hovering empty space tints a model and hovering the model itself stops
 * highlighting it.
 *
 * So the supports are indexed into a grid over the plate, and a ray only tests
 * the cells it crosses. A target is a segment with a radius, which is what both a
 * straight shaft and a root are, and the test is a ray-to-segment distance, so a
 * hit means the pointer is genuinely on (or within a grab tolerance of) a
 * support.
 */
export type ProxyHoverTarget = {
  /** The model the hover resolves to. */
  modelId?: string;
  /** The instance index inside the batch that drew it. */
  index: number;
  start: Vec3;
  end: Vec3;
  /** Shaft or root radius, in millimetres. */
  radius: number;
};

export type ProxyHoverIndex = {
  cellSize: number;
  originX: number;
  originY: number;
  cellCountX: number;
  cellCountY: number;
  cells: Map<number, ProxyHoverTarget[]>;
};

/** Wide enough that a plate of supports does not put dozens in one cell. */
const DEFAULT_CELL_SIZE_MM = 6;

export type ProxyHoverHit = {
  target: ProxyHoverTarget;
  distance: number;
};

function clampCell(value: number, count: number): number {
  return Math.min(count - 1, Math.max(0, value));
}

/**
 * Index `targets` into cells of `cellSize`, covering the segment each one spans
 * plus its radius, so a ray only has to test the cells it actually crosses.
 */
export function buildProxyHoverIndex(
  targets: readonly ProxyHoverTarget[],
  cellSize = DEFAULT_CELL_SIZE_MM,
): ProxyHoverIndex | null {
  if (targets.length === 0) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const target of targets) {
    minX = Math.min(minX, target.start.x - target.radius, target.end.x - target.radius);
    minY = Math.min(minY, target.start.y - target.radius, target.end.y - target.radius);
    maxX = Math.max(maxX, target.start.x + target.radius, target.end.x + target.radius);
    maxY = Math.max(maxY, target.start.y + target.radius, target.end.y + target.radius);
  }

  const cellCountX = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const cellCountY = Math.max(1, Math.ceil((maxY - minY) / cellSize));
  const cells = new Map<number, ProxyHoverTarget[]>();

  for (const target of targets) {
    const x0 = clampCell(Math.floor((Math.min(target.start.x, target.end.x) - target.radius - minX) / cellSize), cellCountX);
    const x1 = clampCell(Math.floor((Math.max(target.start.x, target.end.x) + target.radius - minX) / cellSize), cellCountX);
    const y0 = clampCell(Math.floor((Math.min(target.start.y, target.end.y) - target.radius - minY) / cellSize), cellCountY);
    const y1 = clampCell(Math.floor((Math.max(target.start.y, target.end.y) + target.radius - minY) / cellSize), cellCountY);

    for (let cy = y0; cy <= y1; cy += 1) {
      for (let cx = x0; cx <= x1; cx += 1) {
        const key = cy * cellCountX + cx;
        const bucket = cells.get(key);
        if (bucket) bucket.push(target);
        else cells.set(key, [target]);
      }
    }
  }

  return { cellSize, originX: minX, originY: minY, cellCountX, cellCountY, cells };
}

/**
 * The targets a ray reaches, nearest first.
 *
 * A hit means the ray passes within the target's radius plus `toleranceAt`, and
 * the reported `distance` is how far along the ray that closest approach is, so
 * callers can sort by depth. `toleranceAt` takes that distance, not the miss: a
 * miss is near zero whenever the pointer is anywhere near a support, so sizing a
 * grab radius by it leaves a hit only when the pointer is exactly on one.
 */
export function raycastProxyHoverIndex(
  index: ProxyHoverIndex,
  ray: THREE.Ray,
  toleranceAt: (distance: number) => number,
): ProxyHoverHit[] {
  const hits: ProxyHoverHit[] = [];
  const seen = new Set<ProxyHoverTarget>();

  // The ray's parameter range where its XY projection is inside the index.
  let tEnter = 0;
  let tExit = Number.POSITIVE_INFINITY;
  const axes: Array<[number, number, number, number]> = [
    [ray.origin.x, ray.direction.x, index.originX, index.originX + index.cellCountX * index.cellSize],
    [ray.origin.y, ray.direction.y, index.originY, index.originY + index.cellCountY * index.cellSize],
  ];
  for (const [origin, direction, min, max] of axes) {
    if (Math.abs(direction) < 1e-9) {
      if (origin < min || origin > max) return hits;
      continue;
    }
    const first = (min - origin) / direction;
    const second = (max - origin) / direction;
    tEnter = Math.max(tEnter, Math.min(first, second));
    tExit = Math.min(tExit, Math.max(first, second));
  }
  if (tExit < tEnter) return hits;

  const point = new THREE.Vector3();
  const cellOf = (t: number) => {
    point.copy(ray.direction).multiplyScalar(t).add(ray.origin);
    return {
      x: clampCell(Math.floor((point.x - index.originX) / index.cellSize), index.cellCountX),
      y: clampCell(Math.floor((point.y - index.originY) / index.cellSize), index.cellCountY),
    };
  };

  // Amanatides and Woo: step from cell to cell, taking the nearer of the two
  // axis crossings, so no cell the ray crosses is skipped.
  const stepX = ray.direction.x >= 0 ? 1 : -1;
  const stepY = ray.direction.y >= 0 ? 1 : -1;
  const deltaX = Math.abs(ray.direction.x) < 1e-9 ? Number.POSITIVE_INFINITY : Math.abs(index.cellSize / ray.direction.x);
  const deltaY = Math.abs(ray.direction.y) < 1e-9 ? Number.POSITIVE_INFINITY : Math.abs(index.cellSize / ray.direction.y);

  let { x: cellX, y: cellY } = cellOf(tEnter);
  const startPoint = new THREE.Vector3().copy(ray.direction).multiplyScalar(tEnter).add(ray.origin);
  const tAtBoundary = (axis: 'x' | 'y', cell: number, step: number, origin: number, direction: number) => {
    if (Math.abs(direction) < 1e-9) return Number.POSITIVE_INFINITY;
    const boundary = origin + (cell + (step > 0 ? 1 : 0)) * index.cellSize;
    return tEnter + (boundary - startPoint[axis]) / direction;
  };

  let tNextX = tAtBoundary('x', cellX, stepX, index.originX, ray.direction.x);
  let tNextY = tAtBoundary('y', cellY, stepY, index.originY, ray.direction.y);

  const start = new THREE.Vector3();
  const end = new THREE.Vector3();
  const closestOnRay = new THREE.Vector3();

  for (let guard = 0; guard < 4096; guard += 1) {
    const bucket = index.cells.get(cellY * index.cellCountX + cellX);
    if (bucket) {
      for (const target of bucket) {
        if (seen.has(target)) continue;
        seen.add(target);
        start.set(target.start.x, target.start.y, target.start.z);
        end.set(target.end.x, target.end.y, target.end.z);
        // `distanceSqToSegment` reports how far the ray *misses* the segment, and
        // hands back where on the ray the two come closest. The grab radius
        // belongs to that point's depth, not to the miss: a miss is near zero
        // whenever the pointer is anywhere close to a support, so sizing the
        // tolerance by it left a hit only when the pointer was exactly on one.
        const missDistanceSq = ray.distanceSqToSegment(start, end, closestOnRay);
        if (!Number.isFinite(missDistanceSq)) continue;
        const missDistance = Math.sqrt(missDistanceSq);
        const distance = closestOnRay.distanceTo(ray.origin);
        if (missDistance > target.radius + toleranceAt(distance)) continue;
        hits.push({ target, distance });
      }
    }

    if (tNextX < tNextY) {
      if (tNextX > tExit) break;
      cellX += stepX;
      tNextX += deltaX;
    } else {
      if (tNextY > tExit) break;
      cellY += stepY;
      tNextY += deltaY;
    }
    if (cellX < 0 || cellX >= index.cellCountX || cellY < 0 || cellY >= index.cellCountY) break;
  }

  hits.sort((a, b) => a.distance - b.distance);
  return hits;
}

/**
 * A raycast for a batch mesh, answering from `index` rather than walking every
 * instance the batch holds.
 *
 * It runs as `object.raycast(raycaster, intersects)`, and every intersection
 * names that object: R3F walks `hit.object` up the parents to find the handlers,
 * so a hit that names no object is dispatched to nobody and the batch goes
 * inert. `toleranceAt` receives the depth of the closest approach.
 */
export function createProxyHoverRaycast(
  index: ProxyHoverIndex,
  toleranceAt: (distance: number) => number,
): THREE.Object3D['raycast'] {
  return function proxyHoverRaycast(
    this: THREE.Object3D,
    raycaster: THREE.Raycaster,
    intersects: THREE.Intersection[],
  ) {
    for (const hit of raycastProxyHoverIndex(index, raycaster.ray, toleranceAt)) {
      intersects.push({
        distance: hit.distance,
        point: raycaster.ray.at(hit.distance, new THREE.Vector3()),
        object: this,
        instanceId: hit.target.index,
      } as THREE.Intersection);
    }
  };
}

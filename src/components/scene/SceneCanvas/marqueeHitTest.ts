/**
 * Screen-space hit tests for the shift+drag marquee.
 *
 * Follows the CAD convention: dragging left-to-right selects only what the
 * rectangle encloses completely ("window"), dragging right-to-left selects
 * anything the rectangle touches ("crossing").
 *
 * Everything here works on points already projected to container pixels. A
 * `null` point means the projection failed (behind the camera, outside clip
 * space): a window drag rejects the whole shape, a crossing drag ignores it.
 */

export type MarqueeMode = 'window' | 'crossing';

export type MarqueePoint = { x: number; y: number };

export type MarqueeRect = { minX: number; minY: number; maxX: number; maxY: number };

/** Endpoint index pairs into the shape's point list. */
export type MarqueeSegment = [number, number];

export function marqueeRectForDrag(
  start: MarqueePoint,
  current: MarqueePoint,
): MarqueeRect {
  return {
    minX: Math.min(start.x, current.x),
    maxX: Math.max(start.x, current.x),
    minY: Math.min(start.y, current.y),
    maxY: Math.max(start.y, current.y),
  };
}

export function marqueeModeForDrag(start: MarqueePoint, current: MarqueePoint): MarqueeMode {
  return current.x < start.x ? 'crossing' : 'window';
}

export function isPointInsideMarquee(rect: MarqueeRect, point: MarqueePoint): boolean {
  return point.x >= rect.minX
    && point.x <= rect.maxX
    && point.y >= rect.minY
    && point.y <= rect.maxY;
}

/** Liang-Barsky clip: true when any part of the segment lies inside the rect. */
function segmentIntersectsMarquee(
  rect: MarqueeRect,
  a: MarqueePoint,
  b: MarqueePoint,
): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edgeDistances = [-dx, dx, -dy, dy];
  const edgeOffsets = [a.x - rect.minX, rect.maxX - a.x, a.y - rect.minY, rect.maxY - a.y];

  let enter = 0;
  let exit = 1;

  for (let i = 0; i < 4; i += 1) {
    if (edgeDistances[i] === 0) {
      // Parallel to this edge: outside it means the segment can never enter.
      if (edgeOffsets[i] < 0) return false;
      continue;
    }

    const crossing = edgeOffsets[i] / edgeDistances[i];

    if (edgeDistances[i] < 0) {
      if (crossing > exit) return false;
      if (crossing > enter) enter = crossing;
    } else {
      if (crossing < enter) return false;
      if (crossing < exit) exit = crossing;
    }
  }

  return true;
}

/**
 * Hit test for a shape described by its projected points, plus the segments
 * connecting them. Exact for supports, which are chains of thin struts.
 */
export function shapeHitsMarquee(
  rect: MarqueeRect,
  points: Array<MarqueePoint | null>,
  segments: MarqueeSegment[],
  mode: MarqueeMode,
): boolean {
  if (points.length === 0) return false;

  if (mode === 'window') {
    return points.every((point) => point !== null && isPointInsideMarquee(rect, point));
  }

  for (const point of points) {
    if (point && isPointInsideMarquee(rect, point)) return true;
  }

  for (const [from, to] of segments) {
    const a = points[from];
    const b = points[to];
    if (a && b && segmentIntersectsMarquee(rect, a, b)) return true;
  }

  return false;
}

/** Ray casting: whether a projected polygon encloses a point. */
function ringContainsPoint(ring: MarqueePoint[], point: MarqueePoint): boolean {
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];

    const straddles = (a.y > point.y) !== (b.y > point.y);
    if (!straddles) continue;

    const crossingX = a.x + (((point.y - a.y) / (b.y - a.y)) * (b.x - a.x));
    if (point.x < crossingX) inside = !inside;
  }

  return inside;
}

/**
 * Hit test for a closed outline, such as the profile of a raft. Unlike a run of
 * struts, an outline has an inside: a rectangle that fits entirely within it
 * touches no edge, and is still over the raft.
 */
export function ringHitsMarquee(
  rect: MarqueeRect,
  ring: Array<MarqueePoint | null>,
  mode: MarqueeMode,
): boolean {
  if (ring.length < 3) return false;

  if (mode === 'window') {
    return ring.every((point) => point !== null && isPointInsideMarquee(rect, point));
  }

  const projected = ring.filter((point): point is MarqueePoint => point !== null);
  if (projected.length < 3) return false;

  for (const point of projected) {
    if (isPointInsideMarquee(rect, point)) return true;
  }

  for (let i = 0, j = projected.length - 1; i < projected.length; j = i, i += 1) {
    if (segmentIntersectsMarquee(rect, projected[j], projected[i])) return true;
  }

  return ringContainsPoint(projected, { x: rect.minX, y: rect.minY });
}

/**
 * A model's mesh as projected pixels: one entry per vertex, plus the bounds
 * they span. `dropped` marks vertices that fell outside clip space.
 */
export type ProjectedMesh = {
  xs: Float32Array;
  ys: Float32Array;
  count: number;
  bounds: MarqueeRect | null;
  dropped: boolean;
};

/**
 * Hit test for a model against its own mesh.
 *
 * A window drag encloses the mesh when every vertex is inside, which is exact.
 * A crossing drag looks for a vertex inside the rectangle: on a dense mesh that
 * is the surface, but a rectangle smaller than a single projected triangle can
 * slip between vertices and miss.
 */
export function meshHitsMarquee(
  rect: MarqueeRect,
  mesh: ProjectedMesh,
  mode: MarqueeMode,
): boolean {
  if (mesh.count === 0 || !mesh.bounds) return false;

  if (mode === 'window') {
    if (mesh.dropped) return false;
    return mesh.bounds.minX >= rect.minX
      && mesh.bounds.maxX <= rect.maxX
      && mesh.bounds.minY >= rect.minY
      && mesh.bounds.maxY <= rect.maxY;
  }

  // Cheap rejection before walking the vertices.
  if (
    mesh.bounds.minX > rect.maxX
    || mesh.bounds.maxX < rect.minX
    || mesh.bounds.minY > rect.maxY
    || mesh.bounds.maxY < rect.minY
  ) {
    return false;
  }

  const { xs, ys, count } = mesh;
  for (let i = 0; i < count; i += 1) {
    const x = xs[i];
    if (x < rect.minX || x > rect.maxX) continue;
    const y = ys[i];
    if (y < rect.minY || y > rect.maxY) continue;
    return true;
  }

  return false;
}

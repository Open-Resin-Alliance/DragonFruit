import * as THREE from 'three';
import { signedArea2d } from './signedArea2d';

const PARALLEL_EPS = 1e-8;

/**
 * Offset a counter-clockwise ring inward by `distanceMm` (outward when negative),
 * keeping one output point per input vertex.
 *
 * Moving every edge along its normal and intersecting neighbours (what
 * `insetConvexPolygon` does) is exact on a convex ring, but where the ring turns
 * inward around edges shorter than the offset, the moved edges overshoot each
 * other and the result folds over itself. A clearance cut leaves exactly that: a
 * notch with edges of a few hundredths of a millimetre. Here an edge whose moved
 * copy points backwards has no length left at this offset, so it is dropped and
 * its neighbours meet directly; its vertices share that meeting point. The ring
 * keeps its vertex count, which the crenelated wall needs to pair each outer
 * vertex with its inner and top counterparts.
 *
 * Only these local folds are resolved. A ring that still crosses itself (two
 * far-apart sides closer than the offset) is the caller's to reject.
 *
 * Returns null for a clockwise or degenerate ring, or when fewer than three
 * edges survive.
 */
export function offsetRingResolvingFolds(
  ring: readonly THREE.Vector2[],
  distanceMm: number,
): THREE.Vector2[] | null {
  const n = ring.length;
  if (n < 3 || signedArea2d(ring as THREE.Vector2[]) <= 0) return null;

  const linePoints: THREE.Vector2[] = [];
  const lineDirs: THREE.Vector2[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dir = new THREE.Vector2().subVectors(b, a);
    const length = dir.length();
    if (length === 0) return null;
    dir.multiplyScalar(1 / length);
    // The left normal points into a counter-clockwise ring.
    linePoints.push(new THREE.Vector2(a.x - dir.y * distanceMm, a.y + dir.x * distanceMm));
    lineDirs.push(dir);
  }

  const meet = (before: number, after: number): THREE.Vector2 => {
    const p1 = linePoints[before];
    const d1 = lineDirs[before];
    const p2 = linePoints[after];
    const d2 = lineDirs[after];
    const denom = d1.x * d2.y - d1.y * d2.x;
    if (Math.abs(denom) < PARALLEL_EPS) {
      // Parallel neighbours (a dropped edge between two collinear ones): the
      // moved lines coincide, so either point on them will do.
      return p2.clone();
    }
    const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / denom;
    return new THREE.Vector2(p1.x + t * d1.x, p1.y + t * d1.y);
  };

  const alive = new Array<boolean>(n).fill(true);
  let aliveCount = n;
  const previousAlive = (edge: number) => {
    let i = (edge - 1 + n) % n;
    while (!alive[i]) i = (i - 1 + n) % n;
    return i;
  };
  const nextAlive = (edge: number) => {
    let i = (edge + 1) % n;
    while (!alive[i]) i = (i + 1) % n;
    return i;
  };

  // Drop the most reversed edge, then look again: dropping one changes where its
  // neighbours meet, which can unfold or fold the edges next to it.
  for (;;) {
    let worst = -1;
    let worstAlong = 0;
    for (let edge = 0; edge < n; edge += 1) {
      if (!alive[edge]) continue;
      const start = meet(previousAlive(edge), edge);
      const end = meet(edge, nextAlive(edge));
      const along = (end.x - start.x) * lineDirs[edge].x + (end.y - start.y) * lineDirs[edge].y;
      if (along < worstAlong) {
        worstAlong = along;
        worst = edge;
      }
    }
    if (worst < 0) break;
    alive[worst] = false;
    aliveCount -= 1;
    if (aliveCount < 3) return null;
  }

  // Vertex i sits between edge i-1 and edge i; when either was dropped, it goes
  // to where the surviving edges around it meet.
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < n; i += 1) {
    const before = alive[(i - 1 + n) % n] ? (i - 1 + n) % n : previousAlive((i - 1 + n) % n);
    const after = alive[i] ? i : nextAlive(i);
    out.push(meet(before, after));
  }
  return out;
}

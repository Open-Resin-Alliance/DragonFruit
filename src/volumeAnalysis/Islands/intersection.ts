import type { DetectedIsland } from './types';
import { footprintBounds } from './voxelFootprint';

/**
 * Classifies the two detector outputs against each other (Part C). Both sets are
 * in the same world / build-plate frame (one shared scan transform), so matching
 * is a direct XY-radius + Z-band proximity test — no frame conversion.
 *
 * Produces per-island `class` (`intersection` / `voxelOnly` / `minimaOnly`) and
 * the comparison statistics, including the superset verdict the user wanted to
 * watch (is mesh-minima ⊇ voxel?).
 */

export interface IntersectionOptions {
  /** Max horizontal distance (mm) for a voxel↔minima match. */
  xyToleranceMm: number;
  /** Max vertical distance (mm) for a match. */
  zBandMm: number;
}

export interface IntersectionStats {
  voxelTotal: number;
  minimaTotal: number;
  matched: number;
  /** voxel islands with no minima match = the voxel − mesh exclusion set. */
  voxelOnly: number;
  /** minima with no voxel match = the mesh − voxel exclusion set. */
  minimaOnly: number;
  /** Every voxel island has a minima match (mesh minima ⊇ voxel islands). */
  minimaSupersetOfVoxel: boolean;
  /** Every minima has a voxel match (voxel islands ⊇ mesh minima). */
  voxelSupersetOfMinima: boolean;
  /** Mean 3D offset (mm) between matched partners — a calibration signal. */
  meanMatchOffsetMm: number;
}

export interface ClassifiedIslands {
  /** Copies of the inputs with `class` + `matchedWith` populated (voxel then minima). */
  islands: DetectedIsland[];
  stats: IntersectionStats;
}

interface CandidatePair {
  vIdx: number;
  mIdx: number;
  rank: number;
  d2: number;
}

/**
 * Global shortest-distance matching with many-to-one coincident grouping.
 *
 * Pass 1 sorts all valid `(vIdx, mIdx)` pairs by `(distSq, rank, vIdx, mIdx)`
 * where `rank = vi.isDetached ? 0 : 1` and locks 1-to-1 primary matches.
 * Pass 2 attaches remaining minima within tolerance of an already-matched
 * voxel island onto `vi.subApexes` as plain `{ x, y, z }` points.
 */
export function classifyIntersection(
  voxel: DetectedIsland[],
  minima: DetectedIsland[],
  opts: IntersectionOptions,
): ClassifiedIslands {
  const v = voxel.map((i) => {
    const copy = { ...i };
    delete copy.subApexes;
    return copy;
  });
  const m = minima.map((i) => ({ ...i }));
  const xyTol2 = opts.xyToleranceMm * opts.xyToleranceMm;

  const vBounds = v.map((vi) => {
    const vox = vi.contactVoxels;
    return vox !== undefined && vox.count > 0 ? footprintBounds(vox) : null;
  });

  const pairs: CandidatePair[] = [];
  for (let i = 0; i < v.length; i++) {
    const vi = v[i];
    if (!Number.isFinite(vi.baseZ)) continue;
    const vox = vi.contactVoxels;
    const bounds = vBounds[i];
    const rank = vi.isDetached ? 0 : 1;
    const rawZ = Number.isFinite(vi.rawBaseZ) ? (vi.rawBaseZ as number) : vi.baseZ;

    for (let j = 0; j < m.length; j++) {
      const mj = m[j];
      const mx = mj.contact.x;
      const my = mj.contact.y;
      if (!Number.isFinite(mx) || !Number.isFinite(my) || !Number.isFinite(mj.baseZ)) continue;

      const dzBase = vi.baseZ - mj.baseZ;
      const dzRaw = rawZ - mj.baseZ;
      const dz = Math.abs(dzRaw) < Math.abs(dzBase) ? dzRaw : dzBase;
      if (!(Math.abs(dz) <= opts.zBandMm)) continue;

      let xy2: number;
      if (vox !== undefined && vox.count > 0 && bounds) {
        if (
          mx < bounds.minX - opts.xyToleranceMm ||
          mx > bounds.maxX + opts.xyToleranceMm ||
          my < bounds.minY - opts.xyToleranceMm ||
          my > bounds.maxY + opts.xyToleranceMm
        ) {
          continue;
        }
        xy2 = Infinity;
        const xy = vox.xy;
        for (let k = 0; k < vox.count; k++) {
          const dx = xy[k * 2] - mx;
          const dy = xy[k * 2 + 1] - my;
          const p2 = dx * dx + dy * dy;
          if (p2 < xy2) xy2 = p2;
        }
      } else {
        const dx = vi.contact.x - mx;
        const dy = vi.contact.y - my;
        xy2 = dx * dx + dy * dy;
      }
      if (!(xy2 <= xyTol2)) continue;
      const d2 = xy2 + dz * dz;
      if (!Number.isFinite(d2)) continue;
      pairs.push({ vIdx: i, mIdx: j, rank, d2 });
    }
  }

  pairs.sort((a, b) => (a.d2 - b.d2) || (a.rank - b.rank) || (a.vIdx - b.vIdx) || (a.mIdx - b.mIdx));

  const voxelMatched = new Array<boolean>(v.length).fill(false);
  const matchedMinimaIndices = new Set<number>();
  let matched = 0;
  let offsetSum = 0;

  // Pass 1: 1-to-1 primary anchor match sorted globally by shortest distance.
  for (const pair of pairs) {
    if (voxelMatched[pair.vIdx] || matchedMinimaIndices.has(pair.mIdx)) continue;
    const vi = v[pair.vIdx];
    const mj = m[pair.mIdx];
    voxelMatched[pair.vIdx] = true;
    matchedMinimaIndices.add(pair.mIdx);

    vi.class = 'intersection';
    mj.class = 'intersection';
    vi.matchedWith = mj.id;
    mj.matchedWith = vi.id;

    const oldBaseZ = vi.baseZ;
    const zDelta = mj.baseZ - oldBaseZ;
    vi.contact = mj.contact.clone(); // Snap voxel island contact to matched mesh minimum coordinate
    vi.baseZ = mj.baseZ;
    if (vi.contactVoxels && vi.contactVoxels.z !== null && zDelta !== 0) {
      const shiftedZ = new Float32Array(vi.contactVoxels.z);
      for (let k = 0; k < vi.contactVoxels.count; k++) {
        shiftedZ[k] += zDelta;
      }
      vi.contactVoxels = {
        xy: vi.contactVoxels.xy,
        z: shiftedZ,
        count: vi.contactVoxels.count,
      };
    }

    matched++;
    offsetSum += Math.sqrt(pair.d2);
  }

  // Pass 2: Many-to-one coincident grouping for extra minima near an already-matched voxel base.
  for (const pair of pairs) {
    if (matchedMinimaIndices.has(pair.mIdx) || !voxelMatched[pair.vIdx]) continue;
    const vi = v[pair.vIdx];
    const mj = m[pair.mIdx];
    matchedMinimaIndices.add(pair.mIdx);
    mj.class = 'intersection';
    mj.matchedWith = vi.id;
    if (!vi.subApexes) vi.subApexes = [];
    vi.subApexes.push({ x: mj.contact.x, y: mj.contact.y, z: mj.contact.z });
  }

  for (let i = 0; i < v.length; i++) {
    if (!voxelMatched[i]) {
      v[i].class = 'voxelOnly';
      v[i].matchedWith = null;
    }
  }
  for (let j = 0; j < m.length; j++) {
    if (!matchedMinimaIndices.has(j)) {
      m[j].class = 'minimaOnly';
      m[j].matchedWith = null;
    }
  }

  const voxelTotal = v.length;
  const minimaTotal = m.length;
  const voxelOnly = voxelTotal - matched;
  const minimaOnly = minimaTotal - matchedMinimaIndices.size;

  const stats: IntersectionStats = {
    voxelTotal,
    minimaTotal,
    matched,
    voxelOnly,
    minimaOnly,
    minimaSupersetOfVoxel: voxelTotal > 0 && voxelOnly === 0,
    voxelSupersetOfMinima: minimaTotal > 0 && minimaOnly === 0,
    meanMatchOffsetMm: matched > 0 ? offsetSum / matched : 0,
  };

  return { islands: [...v, ...m], stats };
}

import type { DetectedIsland } from './types';

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

/**
 * Greedy nearest-neighbour matching (n is small, so O(voxel·minima) is fine).
 * Each voxel island claims the closest unused minima within tolerance.
 */
export function classifyIntersection(
  voxel: DetectedIsland[],
  minima: DetectedIsland[],
  opts: IntersectionOptions,
): ClassifiedIslands {
  const v = voxel.map((i) => ({ ...i }));
  const m = minima.map((i) => ({ ...i }));
  const xyTol2 = opts.xyToleranceMm * opts.xyToleranceMm;
  const minimaUsed = new Array(m.length).fill(false);

  let matched = 0;
  let offsetSum = 0;

  for (const vi of v) {
    let bestIdx = -1;
    let bestD2 = Infinity;
    for (let j = 0; j < m.length; j++) {
      if (minimaUsed[j]) continue;
      const mj = m[j];
      const dz = vi.baseZ - mj.baseZ;
      if (Math.abs(dz) > opts.zBandMm) continue;
      const dx = vi.contact.x - mj.contact.x;
      const dy = vi.contact.y - mj.contact.y;
      const xy2 = dx * dx + dy * dy;
      if (xy2 > xyTol2) continue;
      const d2 = xy2 + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestIdx = j;
      }
    }

    if (bestIdx >= 0) {
      const mj = m[bestIdx];
      minimaUsed[bestIdx] = true;
      vi.class = 'intersection';
      mj.class = 'intersection';
      vi.matchedWith = mj.id;
      mj.matchedWith = vi.id;
      vi.contact = mj.contact.clone(); // Snap voxel island contact to matched mesh minimum coordinate
      matched++;
      offsetSum += Math.sqrt(bestD2);
    } else {
      vi.class = 'voxelOnly';
      vi.matchedWith = null;
    }
  }

  for (let j = 0; j < m.length; j++) {
    if (!minimaUsed[j]) {
      m[j].class = 'minimaOnly';
      m[j].matchedWith = null;
    }
  }

  const voxelTotal = v.length;
  const minimaTotal = m.length;
  const voxelOnly = voxelTotal - matched;
  const minimaOnly = minimaTotal - matched;

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

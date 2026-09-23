import { footprintX, footprintY, type VoxelFootprint } from './voxelFootprint';

/**
 * One visible island: the point selection and camera focus key on, plus the
 * contact footprint the overlay draws.
 *
 * Coordinates are world / build-plate millimeters — the frame the island
 * detectors emit and `StlMesh` places the model in — so the overlay is mounted
 * with an identity transform at the scene root, not inside the model group.
 */
export interface IslandVisual {
  /** Numeric marker id, as produced by `markerIdFor`. */
  markerId: number;
  /** Render type: 0 voxel, 1 minima, 2 intersection, 3 consolidated voxel. */
  type: number;
  centerX: number;
  centerY: number;
  baseZ: number;
  /** Disc radius (mm) for islands that carry no footprint. */
  radius: number;
  /** Contact footprint at the base layer, or null to draw a single disc. */
  footprint: VoxelFootprint | null;
}

/**
 * Per-instance buffers for the island overlay.
 *
 * One instance per contact voxel, so the drawn area is the island's real
 * detected footprint instead of a dot cloud, and the instance count is a
 * buffer size rather than a shader constant. Nothing here is capped: the old
 * surface-dot decal dropped every marker past the 80th in a Z band and kept at
 * most four islands per fragment.
 */
export interface IslandInstances {
  /** `(x, y, z, radius)` per instance, world mm. */
  centerRadius: Float32Array;
  /** `(markerId, type)` per instance. */
  meta: Float32Array;
  count: number;
}

export const EMPTY_ISLAND_INSTANCES: IslandInstances = {
  centerRadius: new Float32Array(0),
  meta: new Float32Array(0),
  count: 0,
};

/**
 * Fraction of the scan pixel size a footprint disc is drawn at. A disc of half
 * the cell diagonal (1/√2 ≈ 0.707) would just touch its neighbours; 0.75
 * overlaps them slightly so a filled footprint has no seam between discs.
 */
export const VOXEL_DISC_RADIUS_FACTOR = 0.75;

/**
 * Packs visible islands into one instance buffer.
 *
 * `voxelRadiusMm` is the disc radius that tiles the scan grid (see
 * {@link VOXEL_DISC_RADIUS_FACTOR}); islands without a footprint fall back to
 * their own `radius` at their contact point.
 */
export function buildIslandInstances(
  visuals: readonly IslandVisual[],
  voxelRadiusMm: number,
): IslandInstances {
  let count = 0;
  for (const visual of visuals) {
    const footprint = visual.footprint;
    count += footprint && footprint.count > 0 ? footprint.count : 1;
  }
  if (count === 0) return EMPTY_ISLAND_INSTANCES;

  const centerRadius = new Float32Array(count * 4);
  const meta = new Float32Array(count * 2);
  let i = 0;

  for (const visual of visuals) {
    const footprint = visual.footprint;
    if (footprint && footprint.count > 0) {
      for (let voxel = 0; voxel < footprint.count; voxel++, i++) {
        centerRadius[i * 4] = footprintX(footprint, voxel);
        centerRadius[i * 4 + 1] = footprintY(footprint, voxel);
        centerRadius[i * 4 + 2] = visual.baseZ;
        centerRadius[i * 4 + 3] = voxelRadiusMm;
        meta[i * 2] = visual.markerId;
        meta[i * 2 + 1] = visual.type;
      }
    } else {
      centerRadius[i * 4] = visual.centerX;
      centerRadius[i * 4 + 1] = visual.centerY;
      centerRadius[i * 4 + 2] = visual.baseZ;
      centerRadius[i * 4 + 3] = visual.radius;
      meta[i * 2] = visual.markerId;
      meta[i * 2 + 1] = visual.type;
      i++;
    }
  }

  return { centerRadius, meta, count };
}

import * as THREE from 'three';
import { type DetectedIsland, type TipInfo, SUPPORTED_RADIUS_MM } from './types';
import { SpatialHashGrid2D } from './spatialHashGrid2D';

/**
 * Shared, default-ON island filter for BOTH detectors (voxel + minima).
 *
 * Dependency-injected and tab-agnostic: this module never imports `src/supports/*`.
 * The caller (page-level wiring) extracts existing support-tip world positions
 * from the supports store and passes them in via `supportTips`, so the Islands
 * module is equally usable with zero supports or on a branch without a Support tab.
 */

export interface IslandFilterInput {
  /** Existing support-tip world positions with diameters for the active model (world mm, Z-up). */
  supportTips: TipInfo[];
  /** Build-plate plane Z (world mm). Contacts at/below this (+eps) are "grounded". */
  plateZ: number;
  /** "Already supported" proximity radius (mm). Defaults to {@link SUPPORTED_RADIUS_MM}. */
  supportedRadiusMm?: number;
  /** Tolerance (mm) above `plateZ` still counted as plate-contact. */
  groundedEpsilonMm?: number;
  /** Layer height in mm for Z tolerance. */
  layerHeightMm?: number;
}

export interface IslandFilterToggles {
  /** Reveal islands already covered by a support tip. Default false (they are hidden). */
  showAlreadySupported: boolean;
  /** Reveal islands sitting on the build-plate plane. Default false (they are hidden). */
  showPlateContact: boolean;
}

export const DEFAULT_FILTER_TOGGLES: IslandFilterToggles = {
  showAlreadySupported: false,
  showPlateContact: false,
};

/**
 * Annotate each island with `supported` / `grounded` flags. Mutates and returns
 * the same array.
 */
export function annotateFilterFlags(
  islands: DetectedIsland[],
  input: IslandFilterInput,
): DetectedIsland[] {
  const groundedEps = input.groundedEpsilonMm ?? 1e-3;
  const plateCeil = input.plateZ + groundedEps;
  const layerHeight = input.layerHeightMm ?? 0.25;
  const zTolerance = 2 * layerHeight;

  // Build grid over supportTips
  const grid = new SpatialHashGrid2D<TipInfo>(1.0);
  let maxRadius = input.supportedRadiusMm ?? SUPPORTED_RADIUS_MM;

  for (const tip of input.supportTips) {
    grid.insert(tip.pos.x, tip.pos.y, tip);
    const actualRadius = tip.diameterMm / 2 + 0.15;
    if (actualRadius > maxRadius) {
      maxRadius = actualRadius;
    }
  }

  for (const island of islands) {
    island.grounded = island.contact.z <= plateCeil;

    const candidates = grid.query(island.contact.x, island.contact.y, maxRadius);
    let isSupported = false;
    for (const tip of candidates) {
      const actualRadius = tip.diameterMm / 2 + 0.15;
      const dz = Math.abs(tip.pos.z - island.contact.z);
      if (dz <= zTolerance) {
        const dx = tip.pos.x - island.contact.x;
        const dy = tip.pos.y - island.contact.y;
        if (dx * dx + dy * dy <= actualRadius * actualRadius) {
          isSupported = true;
          break;
        }
      }
    }
    island.supported = isSupported;
  }
  return islands;
}

/**
 * Apply the visibility toggles to produce the subset shown in 3D and in the
 * browser list. Default toggles hide both supported and plate-contact islands,
 * so ←/→ stepping skips them.
 */
export function applyFilter(
  islands: DetectedIsland[],
  toggles: IslandFilterToggles,
): DetectedIsland[] {
  return islands.filter((island) => {
    if (island.supported && !toggles.showAlreadySupported) return false;
    if (island.grounded && !toggles.showPlateContact) return false;
    return true;
  });
}

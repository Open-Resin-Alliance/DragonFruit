import { annotateFilterFlags } from './filtering';
import { SpatialHashGrid2D } from './spatialHashGrid2D';
import { type DetectedIsland, type TipInfo } from './types';
import { footprintX, footprintY, footprintZ } from './voxelFootprint';

export interface IslandGridEntry {
  islandIndex: number;
  x: number;
  y: number;
  z: number;
}

/**
 * Indexes every contact voxel of every island for tip proximity queries.
 *
 * Kept separate from {@link annotateAndCountSupports} because it depends only on
 * the islands: placing a single support changes the tips, not the geometry, and
 * rebuilding this grid over hundreds of thousands of voxels on every placement
 * was the bulk of the freeze after each click. Entry indices refer to positions
 * in `islands`, which `annotateAndCountSupports` preserves.
 */
export function buildIslandContactGrid(islands: DetectedIsland[]): SpatialHashGrid2D<IslandGridEntry> {
  const grid = new SpatialHashGrid2D<IslandGridEntry>(1.0);
  islands.forEach((island, islandIndex) => {
    const footprint = island.contactVoxels;
    if (footprint && footprint.count > 0) {
      for (let i = 0; i < footprint.count; i++) {
        const vx = footprintX(footprint, i);
        const vy = footprintY(footprint, i);
        const fz = footprintZ(footprint, i);
        const z = fz != null && Number.isFinite(fz) ? fz : island.contact.z;
        grid.insert(vx, vy, { islandIndex, x: vx, y: vy, z });
      }
    } else {
      grid.insert(island.contact.x, island.contact.y, { islandIndex, x: island.contact.x, y: island.contact.y, z: island.contact.z });
    }
  });
  return grid;
}

export function annotateAndCountSupports(
  islands: DetectedIsland[],
  grid: SpatialHashGrid2D<IslandGridEntry>,
  supportTips: TipInfo[],
  plateZ: number,
  areaPerSupport: number,
  layerHeightMm?: number,
): DetectedIsland[] {
  const annotated = annotateFilterFlags(islands.map((i) => ({ ...i })), { supportTips, plateZ, layerHeightMm });

  for (const island of annotated) {
    island.supportCount = 0;
  }

  const supportedIslandsThisTip = new Set<number>();
  const zTolerance = layerHeightMm ? 2 * layerHeightMm : 0.5;

  for (const tip of supportTips) {
    supportedIslandsThisTip.clear();
    const actualRadius = tip.diameterMm / 2 + 0.15;
    const actualRadiusSq = actualRadius * actualRadius;

    const candidates = grid.query(tip.pos.x, tip.pos.y, actualRadius);

    for (const cand of candidates) {
      if (supportedIslandsThisTip.has(cand.islandIndex)) continue;

      const dz = Math.abs(tip.pos.z - cand.z);
      if (dz > zTolerance) continue;

      const dx = tip.pos.x - cand.x;
      const dy = tip.pos.y - cand.y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= actualRadiusSq) {
        supportedIslandsThisTip.add(cand.islandIndex);
      }
    }

    for (const idx of supportedIslandsThisTip) {
      annotated[idx].supportCount = (annotated[idx].supportCount ?? 0) + 1;
    }
  }

  for (const island of annotated) {
    const area = island.areaMm2 ?? 0;
    island.supported = (island.supportCount ?? 0) > 0;
    const requiredSupports = Math.max(1, Math.ceil(area / areaPerSupport));
    island.fullySupported = (island.supportCount ?? 0) >= requiredSupports;
  }

  return annotated;
}

import type { DetectedIsland } from './types';
// PORTABILITY: the ONLY analysis-domain reference here is the `IslandMarker`
// *type* (erased at build — no runtime coupling). The renderer `IslandOverlay`
// is mounted by page-level wiring, not imported here. If the IslandScan infra is
// ever removed, vendor the `IslandMarker` type + `IslandOverlay`; nothing else in
// `Islands/` touches that infra.
import type { IslandMarker } from '@/volumeAnalysis/IslandScan/islandOverlayLogic';

/**
 * Converts unified {@link DetectedIsland}s into the `IslandMarker` shape consumed
 * by the existing `IslandOverlay` renderer (the "puck" used by the voxel
 * approach), so we reuse that renderer recolored per source/class rather than
 * writing a new one. Islands are already in world / build-plate mm, so markers
 * are world-space and `IslandOverlay` must be mounted with an identity transform
 * (no `getScanVisualPosition` double-apply).
 */

/**
 * Shared puck metrics. The voxel, mesh-minima, and intersection layers all use
 * the SAME radius/thickness/opacity — only the hue differs per layer. Centralised
 * here so Part C's intersection pucks match the voxel pucks exactly.
 */
export const PUCK_BASE_RADIUS_MM = 0.1; // 0.2 mm diameter floor
export const ISLAND_LAYER_COLORS = {
  voxel: '#87cefa', // pale blue
  minima: '#00ff00', // green
  intersection: '#ff0000', // red
} as const;

export interface PuckOptions {
  /** Fallback puck radius (mm) when an island has no area (e.g. mesh minima). */
  defaultRadiusMm?: number;
  /** Puck disc thickness (mm). */
  heightMm?: number;
  /** Radial sample count for the cylinder. */
  segments?: number;
}

export interface PuckResult {
  markers: IslandMarker[];
  /** numeric markerId → source island, for selection / camera fly-to lookups. */
  byMarkerId: Map<number, DetectedIsland>;
}

const VOXEL_ID_OFFSET = 0;
const MINIMA_ID_OFFSET = 1_000_000;

/**
 * Stable numeric marker id (the legacy `IslandOverlay`/`CameraFocusController`
 * key on numbers). Derived from the island's string id + a per-source offset so
 * ids stay unique across the blue/green/red layers and stable across re-renders.
 * Intersection markers reuse their underlying voxel island's id by design.
 */
export function markerIdFor(island: DetectedIsland): number {
  const digits = island.id.replace(/^\D+/, '');
  const n = digits.length ? parseInt(digits, 10) : 0;
  return (island.source === 'minima' ? MINIMA_ID_OFFSET : VOXEL_ID_OFFSET) + n;
}

export function buildIslandPucks(
  islands: DetectedIsland[],
  opts: PuckOptions = {},
): PuckResult {
  const defaultRadius = opts.defaultRadiusMm ?? PUCK_BASE_RADIUS_MM;

  const markers: IslandMarker[] = [];
  const byMarkerId = new Map<number, DetectedIsland>();

  for (const island of islands) {
    const id = markerIdFor(island);

    // Radius from contact area when available (voxel), else the default (minima).
    const radius =
      island.areaMm2 && island.areaMm2 > 0
        ? Math.max(defaultRadius, Math.sqrt(island.areaMm2 / Math.PI))
        : defaultRadius;

    markers.push({
      id,
      centerX: island.contact.x,
      centerY: island.contact.y,
      baseZ: island.contact.z,
      pixelCount: 1,
      radius,
    });
    byMarkerId.set(id, island);
  }

  return { markers, byMarkerId };
}

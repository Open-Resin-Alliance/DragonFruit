import type { ProfileLayerColorBand } from '@/features/shaders/mesh/types';
import { compileLayerSettingsRanges, type LayerSettingsRange } from './layerSettingsRanges';

/** Resolve scene PLS ownership into print-height colors, independent of the active plate's EOF. */
export function buildLayerSettingsProfileBands(
  ranges: readonly LayerSettingsRange[],
  colors: ReadonlyMap<string, string>,
  layerHeightMm: number,
): ProfileLayerColorBand[] {
  if (ranges.length === 0) return [];
  if (!Number.isFinite(layerHeightMm) || layerHeightMm <= 0) {
    throw new RangeError('Profile view requires a finite, positive layer height.');
  }
  const bands: ProfileLayerColorBand[] = [];
  // Compilation is interval-based, so this retains taller plates without a per-layer allocation.
  for (const segment of compileLayerSettingsRanges(ranges, 0xffffffff, layerHeightMm)) {
    const color = colors.get(segment.rangeId);
    if (!color) continue;
    const lowerMm = (segment.startLayer - 1) * layerHeightMm;
    const upperMm = segment.endLayer * layerHeightMm;
    const previous = bands[bands.length - 1];
    if (previous && previous.upperMm === lowerMm && previous.color === color) {
      previous.upperMm = upperMm;
    } else {
      bands.push({ lowerMm, upperMm, color });
    }
  }
  return bands;
}

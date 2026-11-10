import type { LayerSliderRangeBand } from '../../components/controls/LayerSlider';
import {
  compileLayerSettingsRanges,
  layerSettingsRangeInfluence,
  resolveLayerSettingsRangeBounds,
  type LayerSettingsRange,
} from './layerSettingsRanges';

/** Nominal winner cores keep their existing cells; feathers are independent paint-only records. */
export function buildLayerSettingsRangeBands(
  ranges: readonly LayerSettingsRange[],
  colors: ReadonlyMap<string, string>,
  totalLayers: number,
  printing: boolean,
  layerHeightMm: number,
  label: (range: LayerSettingsRange) => string,
): LayerSliderRangeBand[] {
  if (totalLayers === 0) return [];
  const segments = compileLayerSettingsRanges(ranges, totalLayers, layerHeightMm);
  const originals = ranges.map((range, index) => {
    const bounds = resolveLayerSettingsRangeBounds(range, layerHeightMm);
    return { range, index, bounds, span: bounds ? bounds.endLayer - bounds.startLayer + 1 : 0 };
  });
  const byId = new Map(originals.map((original) => [original.range.id, original]));
  const paintOrders = new Map([...originals]
    .sort((a, b) => b.span - a.span || a.index - b.index)
    .map((original, paintOrder) => [original.range.id, paintOrder]));
  const bands: LayerSliderRangeBand[] = [];
  for (const segment of segments) {
    const color = colors.get(segment.rangeId);
    if (!color) continue;
    const original = byId.get(segment.rangeId)!;
    const bottomPercent = printing
      ? totalLayers === 1 ? 0 : 100 * (Math.max(1, segment.startLayer - 0.5) - 1) / (totalLayers - 1)
      : 100 * (segment.startLayer - 1) / totalLayers;
    const topPercent = printing
      ? totalLayers === 1 ? 100 : 100 * (Math.min(totalLayers, segment.endLayer + 0.5) - 1) / (totalLayers - 1)
      : 100 * segment.endLayer / totalLayers;
    bands.push({
      id: `${segment.rangeId}:${segment.startLayer}:${segment.endLayer}`,
      bottomPercent,
      topPercent,
      color,
      label: label(original.range),
      paintOrder: paintOrders.get(segment.rangeId),
    });
  }

  const percentAt = (layer: number): number => printing
    ? 100 * (layer - 1) / (totalLayers - 1)
    : 100 * layer / totalLayers;
  for (const { range, bounds } of originals) {
    const color = colors.get(range.id);
    if (!color || (!range.blendStart && !range.blendEnd)) continue;
    // Use physical endpoints for mm feathers, not the rounded nominal winner cells.
    const start = range.unit === 'mm' ? Math.fround(range.startMm) : range.startLayer;
    const end = range.unit === 'mm' ? Math.fround(range.endMm) : range.endLayer;
    const unitHeight = range.unit === 'mm' ? layerHeightMm : 1;
    const addFeather = (edge: 'start' | 'end', distance: number | undefined): void => {
      if (!distance) return;
      const lower = edge === 'start' ? start - distance : end;
      const upper = edge === 'start' ? start : end + distance;
      const opacityAt = (layer: number): number => layerSettingsRangeInfluence(range, layer, layerHeightMm);
      if (printing && totalLayers === 1) {
        // A singleton rail represents one plane, not a rescaled section of the ramp.
        if (bounds && bounds.startLayer <= 1 && bounds.endLayer >= 1) return;
        const position = range.unit === 'mm' ? Math.fround(layerHeightMm) : 1;
        if (position < lower || position > upper || opacityAt(1) === 0) return;
        bands.push({
          id: `${range.id}:feather:${edge}`,
          bottomPercent: 0,
          topPercent: 100,
          color,
          label: label(range),
          feather: { bottomOpacity: opacityAt(1), topOpacity: opacityAt(1) },
          paintOrder: paintOrders.get(range.id),
        });
        return;
      }
      const rawBottom = percentAt(lower / unitHeight);
      const rawTop = percentAt(upper / unitHeight);
      // Do not paint inside this range's own nominal core. The sharp gap mask removes
      // its exact pixel separator; phase still comes from the original physical ramp.
      const coreBoundary = bounds ? percentAt(edge === 'start'
        ? bounds.startLayer - (printing ? 0.5 : 1)
        : bounds.endLayer + (printing ? 0.5 : 0)) : undefined;
      const bottomPercent = Math.max(0, rawBottom, edge === 'end' ? coreBoundary ?? -Infinity : -Infinity);
      const topPercent = Math.min(100, rawTop, edge === 'start' ? coreBoundary ?? Infinity : Infinity);
      if (topPercent <= bottomPercent) return;
      const layerAt = (percent: number): number => printing
        ? 1 + percent * (totalLayers - 1) / 100
        : percent * totalLayers / 100;
      bands.push({
        id: `${range.id}:feather:${edge}`,
        bottomPercent,
        topPercent,
        color,
        label: label(range),
        feather: {
          bottomOpacity: opacityAt(layerAt(bottomPercent)),
          topOpacity: opacityAt(layerAt(topPercent)),
        },
        paintOrder: paintOrders.get(range.id),
      });
    };
    addFeather('start', range.blendStart);
    addFeather('end', range.blendEnd);
  }
  return bands.some((band) => band.feather)
    ? bands.sort((a, b) => (a.paintOrder ?? 0) - (b.paintOrder ?? 0))
    : bands;
}

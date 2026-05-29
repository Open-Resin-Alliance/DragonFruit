import {
  type ROIRegion,
  type VoxlROIExtension,
  type VoxlROIRunLength,
  type VoxlROIRegion,
} from './supportPainterTypes';

// ─── RLE Codec for Persistent ROIs [RLE_CODEC] ───
// [AGENT_NOTE] Compresses a sorted index list into alternating [start, count] run-length segments.
// Extremely fast, reliable fallback for all geometric selections including isolated and non-manifold triangles.

/**
 * Compresses an array of numbers (triangle IDs) into RLE spans.
 */
export function compressRLE(triangleIds: number[]): VoxlROIRunLength[] {
  if (triangleIds.length === 0) return [];
  const sorted = [...triangleIds].sort((a, b) => a - b);
  const spans: VoxlROIRunLength[] = [];
  let start = sorted[0];
  let count = 1;

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === start + count) {
      count++;
    } else {
      spans.push({ start, count });
      start = sorted[i];
      count = 1;
    }
  }
  spans.push({ start, count });
  return spans;
}

/**
 * Decompresses RLE spans back into an array of triangle IDs.
 */
export function decompressRLE(spans: VoxlROIRunLength[]): number[] {
  const ids: number[] = [];
  for (const span of spans) {
    for (let i = 0; i < span.count; i++) {
      ids.push(span.start + i);
    }
  }
  return ids;
}

/**
 * Converts in-memory ROIRegion map into a JSON-safe VoxlROIExtension object.
 * Supports Version 2 boundary-loops and RLE fallback.
 */
/**
 * Converts all in-memory ROIRegions across all models into a JSON-safe VoxlROIExtension object.
 * Supports Version 2 boundary-loops, RLE fallback, and model-specific grouping.
 */
export function serializeROIsForVoxl(
  regionsByModel: Map<string, Map<string, ROIRegion>>,
  activeModelId: string
): VoxlROIExtension {
  const list: VoxlROIRegion[] = [];

  for (const [modelId, modelRegions] of regionsByModel.entries()) {
    for (const r of modelRegions.values()) {
      const rleSpans = r.rleSpans || compressRLE(Array.from(r.triangleIds));
      list.push({
        id: r.id,
        brushType: r.brushType,
        seedTriangleId: r.seedTriangleId,
        color: r.color,
        createdAt: r.createdAt,
        loops: r.loops,
        rleSpans,
        brush: r.brush,
        support: r.support,
        modelId, // Save the model ID per region
        placedCount: r.placedCount,
        attemptedCount: r.attemptedCount,
        customBrush: r.customBrush, // Safely serialized V3 field
      });
    }
  }

  return {
    kind: 'support-painter-rois',
    version: 1, // Keep version at 1 for backwards compatibility with prior loaders
    modelId: activeModelId,
    regions: list,
  };
}

/**
 * Converts VoxlROIExtension back into a grouped Map<string, Map<string, ROIRegion>>.
 * Reconstructs triangle sets from RLE or loops grouped by their target modelId.
 */
export function deserializeROIsFromVoxl(
  ext: VoxlROIExtension
): Map<string, Map<string, ROIRegion>> {
  const result = new Map<string, Map<string, ROIRegion>>();

  for (const r of ext.regions) {
    const targetModelId = r.modelId || ext.modelId; // Fallback to primary modelId if not present
    let modelMap = result.get(targetModelId);
    if (!modelMap) {
      modelMap = new Map<string, ROIRegion>();
      result.set(targetModelId, modelMap);
    }

    // Reconstruct triangle IDs from RLE spans
    const triangleIdsList = r.rleSpans && r.rleSpans.length > 0
      ? decompressRLE(r.rleSpans)
      : [];

    modelMap.set(r.id, {
      id: r.id,
      brushType: r.brushType,
      seedTriangleId: r.seedTriangleId,
      triangleIds: new Set(triangleIdsList),
      color: r.color,
      proposedOnly: false,
      createdAt: r.createdAt,
      loops: r.loops,
      rleSpans: r.rleSpans,
      brush: r.brush,
      support: r.support,
      modelId: targetModelId,
      loadedFromVoxl: true,
      placedCount: r.placedCount,
      attemptedCount: r.attemptedCount,
      customBrush: r.customBrush, // Safely deserialized V3 field
    });
  }
  return result;
}

/**
 * Type guard to validate whether an unknown value is a valid VoxlROIExtension.
 * Supports both Version 1 and Version 2 formats.
 */
export function isVoxlROIExtension(v: unknown): v is VoxlROIExtension {
  if (typeof v !== 'object' || v === null) return false;
  const candidate = v as Partial<VoxlROIExtension>;
  return (
    candidate.kind === 'support-painter-rois' &&
    (candidate.version === 1 || candidate.version === 2) &&
    typeof candidate.modelId === 'string' &&
    Array.isArray(candidate.regions)
  );
}

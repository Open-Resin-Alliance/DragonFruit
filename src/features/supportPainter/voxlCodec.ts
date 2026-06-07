import {
  type ROIRegion,
  type VoxlROIExtension,
  type VoxlROIRunLength,
  type VoxlROIRegion,
  type BrushType,
  type SupportPlacementScript,
  upgradePipeline,
  BRUSH_COLORS,
} from './supportPainterTypes';
import { type SupportPreset } from '../../supports/Settings/types';

const KNOWN_BRUSH_TYPES = new Set<string>([
  'MacroFace', 'TexturedFace', 'Ridge', 'Point', 'RoughEdge', 'SoftRidge', 'Ring',
  'ManualCircle', 'ManualSquare', 'Marker', 'PointPath', 'MinimaIslands',
  'Unk Legacy Brush'
]);

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
 * Supports Version 2 boundary-loops, RLE fallback, model-specific grouping, and Version 4 packed assets.
 */
export function serializeROIsForVoxl(
  regionsByModel: Map<string, Map<string, ROIRegion>>,
  activeModelId: string,
  allPlacementScripts?: Map<string, SupportPlacementScript>,
  allSupportPresets?: SupportPreset[]
): VoxlROIExtension {
  const list: VoxlROIRegion[] = [];
  const packedScripts = new Map<string, SupportPlacementScript>();
  const packedPresets = new Map<string, SupportPreset>();

  for (const [modelId, modelRegions] of regionsByModel.entries()) {
    for (const r of modelRegions.values()) {
      const rleSpans = compressRLE(Array.from(r.triangleIds));
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
        placementScriptId: r.placementScriptId,
      });

      // Find referenced custom scripts
      const scriptId = r.placementScriptId;
      if (scriptId && allPlacementScripts && !scriptId.startsWith('default-') && scriptId !== 'unsaved') {
        const script = allPlacementScripts.get(scriptId);
        if (script && !script.isBuiltIn) {
          packedScripts.set(scriptId, script);
        }
      }
    }
  }

  // Scan operations to pack referenced custom support presets
  const checkOpsForPresets = (ops: any[]) => {
    if (!ops || !allSupportPresets) return;
    for (const op of ops) {
      const presetId = op.supportPresetId;
      if (presetId && !['detail', 'structure', 'anchor'].includes(presetId)) {
        const preset = allSupportPresets.find(p => p.id === presetId);
        if (preset && !preset.isBuiltIn) {
          packedPresets.set(presetId, preset);
        }
      }
    }
  };

  // Check custom scripts we are packing
  for (const script of packedScripts.values()) {
    checkOpsForPresets(script.operations);
  }

  // Check inline custom brushes in all regions
  for (const [_, modelRegions] of regionsByModel.entries()) {
    for (const r of modelRegions.values()) {
      if (r.customBrush && r.customBrush.operations) {
        checkOpsForPresets(r.customBrush.operations);
      }
    }
  }

  const extension: VoxlROIExtension = {
    kind: 'support-painter-rois',
    version: 4, // Version 4 packs custom placement scripts and support presets
    modelId: activeModelId,
    regions: list,
  };

  if (packedScripts.size > 0) {
    extension.customPlacementScripts = Array.from(packedScripts.values());
  }
  if (packedPresets.size > 0) {
    extension.customSupportPresets = Array.from(packedPresets.values());
  }

  return extension;
}

/**
 * Converts VoxlROIExtension back into a grouped Map<string, Map<string, ROIRegion>>.
 * Reconstructs triangle sets from RLE or loops grouped by their target modelId.
 */
export function deserializeROIsFromVoxl(
  ext: VoxlROIExtension
): Map<string, Map<string, ROIRegion>> {
  const result = new Map<string, Map<string, ROIRegion>>();
  const version = ext.version || 1;

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

    let brushType = r.brushType;
    if ((brushType as string) === 'CylinderMinima') {
      brushType = 'SoftRidge';
    } else if ((brushType as string) === 'CylinderSides') {
      brushType = 'RoughEdge';
    } else if (!KNOWN_BRUSH_TYPES.has(brushType)) {
      brushType = 'Unk Legacy Brush';
    }

    let customBrush = undefined;
    if (r.customBrush) {
      let baseBrush = r.customBrush.baseBrush;
      if (baseBrush) {
        if ((baseBrush as string) === 'CylinderMinima') {
          baseBrush = 'SoftRidge';
        } else if ((baseBrush as string) === 'CylinderSides') {
          baseBrush = 'RoughEdge';
        } else if (!KNOWN_BRUSH_TYPES.has(baseBrush)) {
          baseBrush = 'Unk Legacy Brush';
        }
      }
      // Omit baseBrush property entirely if it's undefined to match original object structure in tests
      const { baseBrush: _, ...restCustomBrush } = r.customBrush;
      
      let operations = r.customBrush.operations || [];
      if (version < 3) {
        // Upgrade legacy flat/fixed pipeline to default operations list
        operations = upgradePipeline(operations, brushType);
      } else {
        // If version >= 3, keep custom operations exactly but map dynamic defaults to ensure full compatibility
        operations = operations.map(op => ({
          id: op.id || `${op.type}-${Math.random().toString(36).substr(2, 9)}`,
          type: op.type,
          enabled: op.enabled !== false,
          supportPresetId: op.supportPresetId || 'default-light',
          isIntervalDirectlyEdited: op.isIntervalDirectlyEdited ?? false,
          isEndIntervalDirectlyEdited: op.isEndIntervalDirectlyEdited ?? false,
          insetDistanceMm: op.insetDistanceMm ?? 0.0,
          wrapFraction: op.wrapFraction ?? 1.0,
          enableZHeightDensity: op.enableZHeightDensity ?? false,
          minimaStartInterval: op.minimaStartInterval ?? 0.5,
          minimaEndInterval: op.minimaEndInterval ?? 'auto',
          zFactor: op.zFactor ?? 2.0,
          zFactorCurve: op.zFactorCurve ?? 'linear',
          suppression: {
            enabled: op.suppression?.enabled ?? false,
            distanceMm: op.suppression?.distanceMm ?? 4.0,
            suppressAgainst: op.suppression?.suppressAgainst ?? [],
          },
          spacing: {
            baseSpacingMm: op.spacing?.baseSpacingMm ?? 4.0,
            sequence: op.spacing?.sequence,
            solverMode: op.spacing?.solverMode ?? 'standard',
            useInflectionPoints: op.spacing?.useInflectionPoints ?? false,
            infillPattern: op.spacing?.infillPattern ?? 'PoissonDisc',
            seedFromMinima: op.spacing?.seedFromMinima ?? true,
            attemptLeafCreation: op.spacing?.attemptLeafCreation ?? false,
          }
        }));
      }

      customBrush = {
        ...restCustomBrush,
        ...(baseBrush ? { baseBrush } : {}),
        operations,
      };
    }

    const color = brushType === 'Unk Legacy Brush' ? '#E11D48' : (r.color || BRUSH_COLORS[brushType]);

    const resolvedScriptId = r.placementScriptId || (customBrush ? (customBrush.id || `custom-script-${r.id}`) : `default-${brushType}`);

    modelMap.set(r.id, {
      id: r.id,
      brushType,
      seedTriangleId: r.seedTriangleId,
      triangleIds: new Set(triangleIdsList),
      color,
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
      customBrush,
      placementScriptId: resolvedScriptId,
    });
  }
  return result;
}

/**
 * Type guard to validate whether an unknown value is a valid VoxlROIExtension.
 * Supports Version 1, 2, and 3 formats.
 */
export function isVoxlROIExtension(v: unknown): v is VoxlROIExtension {
  if (typeof v !== 'object' || v === null) return false;
  const candidate = v as Partial<VoxlROIExtension>;
  return (
    candidate.kind === 'support-painter-rois' &&
    (candidate.version === 1 || candidate.version === 2 || candidate.version === 3 || candidate.version === 4) &&
    typeof candidate.modelId === 'string' &&
    Array.isArray(candidate.regions)
  );
}

import * as THREE from 'three';
import {
  type BrushType,
  type BrushInteractionPhase,
  type BrushModifierKeys,
  type ROIRegion,
  type TriangleColorMap,
  type SupportPainterState,
  type CommitRegionPayload,
  type VoxlROIExtension,
  type SuppressionSettings,
  type SupportPainterToast,
  type CustomBrushTemplate,
  type LocalMinimum,
  type CustomSupportOperation,
  type SupportPlacementScript,
  type CustomSupportOperationType,
  type ConflictItem,
  type FailedPlacementCandidate,
  BRUSH_COLORS,
  upgradePipeline,
  arePipelinesEquivalent,
} from './supportPainterTypes';
import { type ClientAdjacencyMap, proposeRegionOnClient, expandPathWithDijkstra, walkPointPathPolygon } from './useClientAdjacencyMap';
import { deserializeROIsFromVoxl } from './voxlCodec';
import { getPresetById, importCustomPreset, getPresetList } from '@/supports/Settings/presets';
import { getSnapshot as getSupportSnapshot, setSnapshot as setSupportSnapshot } from '@/supports/state';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_EDIT_REPLACE } from '@/supports/history/actionTypes';
import { getShaftProfile } from '@/supports/Settings';

const KNOWN_BRUSH_TYPES = new Set<string>([
  'MacroFace', 'TexturedFace', 'Ridge', 'Point', 'RoughEdge', 'SoftRidge', 'Ring',
  'ManualCircle', 'ManualSquare', 'Marker', 'PointPath', 'PointPerimeter', 'SharpCorner', 'MinimaIslands',
  'Unk Legacy Brush'
]);

const listeners = new Set<() => void>();

let isActive = false;
let activeBrush: BrushType = 'MacroFace';
let interactionPhase: BrushInteractionPhase = 'Idle';
let modifierKeys: BrushModifierKeys = { alt: false, shift: false };
let regions = new Map<string, ROIRegion>();
const regionsByModel = new Map<string, Map<string, ROIRegion>>();
let activeModelId: string | null = null;
let triangleColorMap: TriangleColorMap = new Map();
let hoveredTriangleId: number | null = null;
let hoveredWorldPoint: [number, number, number] | null = null;
let proposedTriangleIds = new Set<number>();
let directGenEnabled = false;
let selectedRegionId: string | null = null;
let selectedRegionIds = new Set<string>();
let lastSelectedIndex: number | null = null;
let clientAdjacencyMap: ClientAdjacencyMap | null = null;
let isBuildingAdjacencyMap = false;


// ─── Extended Spacing & Suppression Parameters [STORE_STATE] ───
// [AGENT_NOTE] Stored in local module variables and exposed via the store snapshot.
let perimeterSpacingOverride: number | null = null;
let infillSpacingOverride:    number | null = null;

const DEFAULT_SUPPRESSION_SETTINGS: SuppressionSettings = {
  minima: {
    mode: 'current',
    types: ['minima'],
  },
  perimeter: {
    mode: 'none',
    types: [],
  },
  infill: {
    mode: 'all',
    types: ['minima', 'perimeter', 'infill'],
  },
  centerline: {
    mode: 'none',
    types: [],
  },
};

let suppressionSettings: SuppressionSettings = { ...DEFAULT_SUPPRESSION_SETTINGS };
let toast: SupportPainterToast | null = null;
let toastTimeout: NodeJS.Timeout | null = null;

// ─── Granular Storage / Tracking Mode State ───
let roiTrackingMode: 'none' | 'session' | 'voxl' = 'voxl'; // Default persistent mode

// ─── Version 3 Custom Support Brushes State ───
let customBrushes = new Map<string, CustomBrushTemplate>();
let activeCustomBrushId: string | null = null;

let smartBrushesDisplayMode: 'std' | 'ext' = 'std';
let modelStatsCardCollapsed = false;

// ─── Support Placement Scripts State ───
const placementScripts = new Map<string, SupportPlacementScript>();
let activePlacementScriptId: string | null = null;
let brushDefaultScripts = new Map<string, string>();

const BRUSH_TYPES_LIST: BrushType[] = [
  'Marker', 'MacroFace', 'TexturedFace', 'Ridge', 'Point', 'RoughEdge', 'SoftRidge', 'Ring',
  'ManualCircle', 'ManualSquare', 'PointPath', 'PointPerimeter', 'SharpCorner', 'MinimaIslands'
];

function getDefaultOperationsForBrush(brushType: BrushType, defaultSpacing = 4.0): CustomSupportOperation[] {
  const isMinimaIslands = brushType === 'MinimaIslands';
  const isLineBrush = brushType === 'Ridge' || brushType === 'SoftRidge' || brushType === 'PointPath' || brushType === 'SharpCorner';
  const isPointPerimeter = brushType === 'PointPerimeter';
  const isMarkerOrPointPath = brushType === 'PointPath' || brushType === 'Marker' || brushType === 'SharpCorner';

  return [
    {
      type: 'minima' as const,
      enabled: isMinimaIslands || (!isMarkerOrPointPath && !isPointPerimeter && !isLineBrush),
      suppression: {
        enabled: true,
        distanceMm: 0.8,
        suppressAgainst: ['minima'] as CustomSupportOperationType[],
      },
      spacing: {
        baseSpacingMm: defaultSpacing,
        attemptLeafCreation: true,
        leafInterval: 4.0,
      },
    },
    {
      type: 'perimeter' as const,
      enabled: isPointPerimeter || (!isMinimaIslands && !isMarkerOrPointPath && !isLineBrush),
      suppression: {
        enabled: false,
        distanceMm: defaultSpacing,
        suppressAgainst: [] as CustomSupportOperationType[],
      },
      spacing: {
        baseSpacingMm: defaultSpacing,
        solverMode: 'standard' as const,
        useInflectionPoints: false,
      },
    },
    {
      type: 'infill' as const,
      enabled: isPointPerimeter || (!isMinimaIslands && !isLineBrush),
      suppression: {
        enabled: true,
        distanceMm: defaultSpacing,
        suppressAgainst: ['minima', 'perimeter', 'infill'] as CustomSupportOperationType[],
      },
      spacing: {
        baseSpacingMm: defaultSpacing,
        infillPattern: 'PoissonDisc' as const,
        seedFromMinima: true,
      },
    },
    {
      type: 'centerline' as const,
      enabled: !isMinimaIslands && isLineBrush,
      suppression: {
        enabled: true,
        distanceMm: defaultSpacing,
        suppressAgainst: ['minima', 'perimeter', 'infill', 'centerline'] as CustomSupportOperationType[],
      },
      spacing: {
        baseSpacingMm: defaultSpacing,
        seedFromMinima: true,
      },
    },
  ].map(op => ({
    ...op,
    minimaStartInterval: 0,
    minimaEndInterval: 100,
    endSpacingMm: defaultSpacing,
    wrapFraction: 100,
  })).filter(op => op.enabled);
}

function _getDefaultScriptIdForBrush(brush: BrushType, pathMode?: 'line' | 'polygon', customBrushId?: string | null): string {
  const key = customBrushId ? customBrushId : (brush === 'PointPath' && pathMode ? `PointPath-${pathMode}` : brush);
  if (brushDefaultScripts.has(key)) {
    const customId = brushDefaultScripts.get(key)!;
    if (placementScripts.has(customId)) {
      return customId;
    }
  }

  if (customBrushId) {
    const customBrush = customBrushes.get(customBrushId);
    if (customBrush) {
      const matched = Array.from(placementScripts.values()).find(script => {
        const scriptOps = upgradePipeline(script.operations, customBrush.baseBrush || 'MacroFace');
        return arePipelinesEquivalent(scriptOps, customBrush.operations);
      });
      if (matched) return matched.id;
    }
    return 'unsaved';
  }

  switch (brush) {
    case 'MacroFace':
    case 'TexturedFace':
    case 'Point':
    case 'ManualCircle':
    case 'ManualSquare':
    case 'PointPerimeter':
      return 'default-perimeter-infill-structure';
    case 'Marker':
    case 'Ring':
    case 'RoughEdge':
    case 'Unk Legacy Brush':
      return 'default-infill-only-structure';
    case 'PointPath':
    case 'SharpCorner':
    case 'Ridge':
    case 'SoftRidge':
      return 'default-centerline-detail';
    case 'MinimaIslands':
      return 'default-minima-only-detail';
    default:
      return 'default-perimeter-infill-structure';
  }
}

function initializeDefaultPlacementScripts() {
  placementScripts.clear();

  // 1. Default - Perimeter + Infill (Structure)
  placementScripts.set('default-perimeter-infill-structure', {
    id: 'default-perimeter-infill-structure',
    name: 'Default - Perimeter + Infill (Structure)',
    isBuiltIn: true,
    isReadOnly: true,
    operations: [
      {
        id: crypto.randomUUID?.() || Math.random().toString(36).substring(2),
        type: 'perimeter',
        enabled: true,
        supportPresetId: 'structure',
        minimaStartInterval: 0,
        minimaEndInterval: 100,
        endSpacingMm: 2.5,
        wrapFraction: 100,
        suppression: {
          enabled: false,
          distanceMm: 6.0,
          suppressAgainst: [],
        },
        spacing: {
          baseSpacingMm: 2.5,
          solverMode: 'standard',
          useInflectionPoints: false,
        },
      },
      {
        id: crypto.randomUUID?.() || Math.random().toString(36).substring(2),
        type: 'infill',
        enabled: true,
        supportPresetId: 'structure',
        minimaStartInterval: 0,
        minimaEndInterval: 100,
        endSpacingMm: 3.0,
        wrapFraction: 100,
        suppression: {
          enabled: true,
          distanceMm: 3.0,
          suppressAgainst: ['minima', 'perimeter', 'infill'],
        },
        spacing: {
          baseSpacingMm: 3.0,
          infillPattern: 'PoissonDisc',
          seedFromMinima: true,
        },
      }
    ]
  });

  // 2. Default - Infill only (Structure)
  placementScripts.set('default-infill-only-structure', {
    id: 'default-infill-only-structure',
    name: 'Default - Infill only (Structure)',
    isBuiltIn: true,
    isReadOnly: true,
    operations: [
      {
        id: crypto.randomUUID?.() || Math.random().toString(36).substring(2),
        type: 'infill',
        enabled: true,
        supportPresetId: 'structure',
        minimaStartInterval: 0,
        minimaEndInterval: 100,
        endSpacingMm: 2.5,
        wrapFraction: 100,
        suppression: {
          enabled: true,
          distanceMm: 2.5,
          suppressAgainst: ['minima', 'perimeter', 'infill'],
        },
        spacing: {
          baseSpacingMm: 2.5,
          infillPattern: 'PoissonDisc',
          seedFromMinima: true,
        },
      }
    ]
  });

  // 3. Default - Centerline (Detail)
  placementScripts.set('default-centerline-detail', {
    id: 'default-centerline-detail',
    name: 'Default - Centerline (Detail)',
    isBuiltIn: true,
    isReadOnly: true,
    operations: [
      {
        id: crypto.randomUUID?.() || Math.random().toString(36).substring(2),
        type: 'centerline',
        enabled: true,
        supportPresetId: 'detail',
        minimaStartInterval: 0,
        minimaEndInterval: 100,
        endSpacingMm: 4.8,
        wrapFraction: 100,
        suppression: {
          enabled: true,
          distanceMm: 1.5,
          suppressAgainst: ['minima', 'perimeter', 'infill', 'centerline'],
        },
        spacing: {
          baseSpacingMm: 1.5,
          seedFromMinima: true,
        },
      }
    ]
  });

  // 4. Default - Minima only (Detail)
  placementScripts.set('default-minima-only-detail', {
    id: 'default-minima-only-detail',
    name: 'Default - Minima only (Detail)',
    isBuiltIn: true,
    isReadOnly: true,
    operations: [
      {
        id: crypto.randomUUID?.() || Math.random().toString(36).substring(2),
        type: 'minima',
        enabled: true,
        supportPresetId: 'detail',
        minimaStartInterval: 0,
        minimaEndInterval: 100,
        endSpacingMm: 4.0,
        wrapFraction: 100,
        suppression: {
          enabled: true,
          distanceMm: 0.8,
          suppressAgainst: ['minima'],
        },
        spacing: {
          baseSpacingMm: 4.0,
          attemptLeafCreation: true,
          leafInterval: 4.0,
        },
      }
    ]
  });

  // 5. Flat Base Supports (Z Demo)
  placementScripts.set('default-flat-base-z-demo', {
    id: 'default-flat-base-z-demo',
    name: 'Flat Base Supports (Z Demo)',
    isBuiltIn: true,
    isReadOnly: true,
    operations: [
      {
        id: crypto.randomUUID?.() || Math.random().toString(36).substring(2),
        type: 'perimeter',
        enabled: true,
        suppression: {
          enabled: false,
          distanceMm: 0.7,
          suppressAgainst: []
        },
        spacing: {
          baseSpacingMm: 0.8,
          solverMode: 'standard',
          useInflectionPoints: false
        },
        minimaStartInterval: 0,
        minimaEndInterval: 100,
        endSpacingMm: 4,
        wrapFraction: 100,
        supportPresetId: 'detail',
        enableZHeightDensity: true,
        isIntervalDirectlyEdited: true
      },
      {
        id: crypto.randomUUID?.() || Math.random().toString(36).substring(2),
        type: 'perimeter',
        enabled: true,
        supportPresetId: 'anchor',
        isIntervalDirectlyEdited: true,
        insetDistanceMm: 1,
        wrapFraction: 30,
        enableZHeightDensity: true,
        minimaStartInterval: 0,
        minimaEndInterval: 100,
        endSpacingMm: 2,
        zFactor: 2,
        zFactorCurve: 'linear',
        suppression: {
          enabled: false,
          distanceMm: 0.9,
          suppressAgainst: [
            'minima',
            'perimeter',
            'infill',
            'centerline'
          ]
        },
        spacing: {
          baseSpacingMm: 1,
          solverMode: 'standard',
          useInflectionPoints: false,
          infillPattern: 'PoissonDisc',
          seedFromMinima: true,
          attemptLeafCreation: false
        }
      },
      {
        id: crypto.randomUUID?.() || Math.random().toString(36).substring(2),
        type: 'infill',
        enabled: true,
        supportPresetId: 'structure',
        isIntervalDirectlyEdited: true,
        insetDistanceMm: 0,
        wrapFraction: 100,
        enableZHeightDensity: true,
        minimaStartInterval: 0,
        minimaEndInterval: 100,
        endSpacingMm: 3,
        zFactor: 2,
        zFactorCurve: 'linear',
        suppression: {
          enabled: true,
          distanceMm: 0.9,
          suppressAgainst: [
            'minima',
            'perimeter',
            'infill'
          ]
        },
        spacing: {
          baseSpacingMm: 1,
          solverMode: 'standard',
          useInflectionPoints: false,
          infillPattern: 'PoissonDisc',
          seedFromMinima: true,
          attemptLeafCreation: false
        }
      }
    ]
  });
}

const SCRIPTS_LOCAL_STORAGE_KEY = 'dragonfruit.support-painter.placement-scripts';
const BRUSH_DEFAULTS_STORAGE_KEY = 'dragonfruit.support-painter.brush-defaults';

function savePlacementScriptsToLocalStorage() {
  try {
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      const customList = Array.from(placementScripts.values()).filter(s => !s.isBuiltIn);
      localStorage.setItem(SCRIPTS_LOCAL_STORAGE_KEY, JSON.stringify(customList));
    }
  } catch (err) {
    console.error('[SupportPainterStore] Failed to persist placement scripts', err);
  }
}

function saveBrushDefaultsToLocalStorage() {
  try {
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      localStorage.setItem(BRUSH_DEFAULTS_STORAGE_KEY, JSON.stringify(Array.from(brushDefaultScripts.entries())));
    }
  } catch (err) {
    console.error('[SupportPainterStore] Failed to persist brush defaults', err);
  }
}

function loadBrushDefaultsFromLocalStorage() {
  try {
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(BRUSH_DEFAULTS_STORAGE_KEY);
      if (raw) {
        brushDefaultScripts = new Map(JSON.parse(raw));
      }
    }
  } catch (err) {
    console.error('[SupportPainterStore] Failed to restore brush defaults', err);
  }
}

function loadPlacementScriptsFromLocalStorage() {
  try {
    initializeDefaultPlacementScripts();
    loadBrushDefaultsFromLocalStorage();
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(SCRIPTS_LOCAL_STORAGE_KEY);
      if (raw) {
        const customList = JSON.parse(raw) as SupportPlacementScript[];
        for (const script of customList) {
          const baseType = script.operations.find((op: CustomSupportOperation) => op.enabled)?.type || 'perimeter';
          const brushTypeMap: Record<string, BrushType> = {
            minima: 'MinimaIslands',
            perimeter: 'MacroFace',
            infill: 'MacroFace',
            centerline: 'Ridge',
          };
          const resolvedBrush = brushTypeMap[baseType] || 'MacroFace';
          const upgradedOps = upgradePipeline(script.operations, resolvedBrush);
          placementScripts.set(script.id, {
            ...script,
            isBuiltIn: false,
            operations: upgradedOps,
          });
        }
      }
    }
  } catch (err) {
    console.error('[SupportPainterStore] Failed to restore placement scripts', err);
  }
}

function savePlacementScriptToFile(script: SupportPlacementScript) {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke('save_support_painter_file', {
        id: script.id,
        content: JSON.stringify(script, null, 2),
      }).catch(err => {
        console.error('[SupportPainterStore] Failed to save placement script file', err);
      });
    });
  }
}

function deletePlacementScriptFile(id: string) {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke('delete_support_painter_file', { id }).catch(err => {
        console.error('[SupportPainterStore] Failed to delete placement script file', err);
      });
    });
  }
}

async function loadPlacementScriptsFromFilesystem() {
  try {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      const { invoke } = await import('@tauri-apps/api/core');
      const files = await invoke<string[]>('load_support_painter_files');
      if (files && files.length > 0) {
        for (const fileContent of files) {
          try {
            const script = JSON.parse(fileContent) as SupportPlacementScript;
            if (script && script.id) {
              const baseType = script.operations.find((op: CustomSupportOperation) => op.enabled)?.type || 'perimeter';
              const brushTypeMap: Record<string, BrushType> = {
                minima: 'MinimaIslands',
                perimeter: 'MacroFace',
                infill: 'MacroFace',
                centerline: 'Ridge',
              };
              const resolvedBrush = brushTypeMap[baseType] || 'MacroFace';
              const upgradedOps = upgradePipeline(script.operations, resolvedBrush);
              
              placementScripts.set(script.id, {
                ...script,
                isBuiltIn: false,
                operations: upgradedOps,
              });
            }
          } catch (e) {
            console.error('[SupportPainterStore] Failed to parse script file:', e);
          }
        }
        savePlacementScriptsToLocalStorage();
        updateSnapshot();
        notify();
      }
    }
  } catch (err) {
    console.error('[SupportPainterStore] Failed to load placement scripts from filesystem', err);
  }
}

// ─── Version 4 Manual Geodesic Brushes State ───
let brushRadiusMm = 4.0;
let scannedMinima: LocalMinimum[] = [];

// ─── Marker Brush State ───
let markerRadiusMm = 0.2;
let markerTipShape: 'circle' | 'line' | 'rectangle' | 'square' | 'hexagon' = 'circle';
let markerTipRotationDeg = 0;
let markerEraserMode = false;
let markerCollisionMode: 'fence' | 'push' | 'merge' = 'merge';

// ─── Point Path Brush State ───
let pointPathPoints: { point: [number, number, number]; faceIndex: number; normal?: [number, number, number] }[] = [];
let pointPathWidthMm = 0.2;
let pointPathMode: 'line' | 'polygon' = 'line';
let pointPathClosed = false;

// ─── Sharp Corner Brush State ───
let sharpCornerDihedralThresholdDeg = 35;
let sharpCornerWrapCurves = true;

// ─── Phase III Active Brush Pipeline Override State ───
let activeBrushPipeline: CustomSupportOperation[] | null = null;
let conflictState: { conflicts: ConflictItem[]; pendingRoiExt: VoxlROIExtension } | null = null;

// ─── Phase 4 Failed Placements Tracking & Walker State ───
let failedCandidates: FailedPlacementCandidate[] = [];
let activeFailureIndex: number | null = null;

const LOCAL_STORAGE_KEY = 'dragonfruit.support-painter.custom-brushes';

function saveCustomBrushesToLocalStorage() {
  try {
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      const list = Array.from(customBrushes.values());
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(list));
    }
  } catch (err) {
    console.error('[SupportPainterStore] Failed to persist custom brushes', err);
  }
}

function loadCustomBrushesFromLocalStorage() {
  try {
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (raw) {
        const list = JSON.parse(raw) as CustomBrushTemplate[];
        customBrushes.clear();
        for (const brush of list) {
          let baseBrush = brush.baseBrush;
          if (baseBrush) {
            if ((baseBrush as string) === 'CylinderMinima') {
              baseBrush = 'SoftRidge';
            } else if ((baseBrush as string) === 'CylinderSides') {
              baseBrush = 'RoughEdge';
            } else if (!KNOWN_BRUSH_TYPES.has(baseBrush)) {
              baseBrush = 'Unk Legacy Brush';
            }
          }

          let color = brush.color;
          if (baseBrush === 'Unk Legacy Brush') {
            color = '#E11D48';
          }

          const upgradedBrush = {
            ...brush,
            baseBrush,
            color,
            operations: upgradePipeline(brush.operations, baseBrush || 'MacroFace'),
          };
          customBrushes.set(brush.id, upgradedBrush);
        }
      }
    }
  } catch (err) {
    console.error('[SupportPainterStore] Failed to restore custom brushes', err);
  }
}

// Initial invocation on module load
loadCustomBrushesFromLocalStorage();
loadPlacementScriptsFromLocalStorage();
loadPlacementScriptsFromFilesystem();

let storeSnapshot: SupportPainterState = {
  isActive,
  activeBrush,
  interactionPhase,
  modifierKeys,
  regions,
  scannedMinima: [],
  triangleColorMap,
  hoveredTriangleId,
  hoveredWorldPoint,
  proposedTriangleIds,
  directGenEnabled,
  perimeterSpacingOverride,
  infillSpacingOverride,
  suppressionSettings: { ...suppressionSettings },
  toast: null,
  roiTrackingMode,
  selectedRegionId,
  selectedRegionIds: new Set(selectedRegionIds),
  lastSelectedIndex,
  customBrushes: new Map(customBrushes),
  activeCustomBrushId,
  placementScripts: new Map(placementScripts),
  activePlacementScriptId,
  brushRadiusMm,
  markerRadiusMm,
  markerTipShape,
  markerTipRotationDeg,
  markerEraserMode,
  markerCollisionMode,
  pointPathPoints: [],
  pointPathWidthMm,
  pointPathMode,
  pointPathClosed,
  sharpCornerDihedralThresholdDeg,
  sharpCornerWrapCurves,
  activeBrushPipeline: null,
  conflictState: null,
  failedCandidates: [],
  activeFailureIndex: null,
  clientAdjacencyMap: null,
  isBuildingAdjacencyMap: false,

  smartBrushesDisplayMode,
  modelStatsCardCollapsed,
};


function notify() {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (err) {
      console.error('[SupportPainterStore] listener error', err);
    }
  });
}

function updateSnapshot() {
  storeSnapshot = {
    isActive,
    activeBrush,
    interactionPhase,
    modifierKeys,
    regions: new Map(regions),
    regionsByModel: new Map(Array.from(regionsByModel.entries()).map(([k, v]) => [k, new Map(v)])),
    scannedMinima: [...scannedMinima],
    triangleColorMap: new Map(triangleColorMap),
    hoveredTriangleId,
    hoveredWorldPoint,
    proposedTriangleIds: new Set(proposedTriangleIds),
    directGenEnabled,
    perimeterSpacingOverride,
    infillSpacingOverride,
    suppressionSettings: { ...suppressionSettings },
    toast: toast ? { ...toast } : null,
    roiTrackingMode,
    selectedRegionId,
    selectedRegionIds: new Set(selectedRegionIds),
    lastSelectedIndex,
    customBrushes: new Map(customBrushes),
    activeCustomBrushId,
    placementScripts: new Map(placementScripts),
    activePlacementScriptId,
    brushRadiusMm,
    markerRadiusMm,
    markerTipShape,
    markerTipRotationDeg,
    markerEraserMode,
    markerCollisionMode,
    pointPathPoints: [...pointPathPoints],
    pointPathWidthMm,
    pointPathMode,
    pointPathClosed,
    sharpCornerDihedralThresholdDeg,
    sharpCornerWrapCurves,
    activeBrushPipeline: activeBrushPipeline ? [...activeBrushPipeline] : null,
    conflictState: conflictState ? { ...conflictState } : null,
    failedCandidates: [...failedCandidates],
    activeFailureIndex,
    clientAdjacencyMap,
    isBuildingAdjacencyMap,

    smartBrushesDisplayMode,
    modelStatsCardCollapsed,
  };
}


function _remapSupportsRoiId(state: any, sourceRoiIds: string[], targetRoiId: string): any {
  const sourceSet = new Set(sourceRoiIds);
  const remapEntity = (record: any) => {
    if (!record) return record;
    const next: any = {};
    for (const [id, value] of Object.entries(record)) {
      const val = value as any;
      if (val.roiId && sourceSet.has(val.roiId)) {
        next[id] = { ...val, roiId: targetRoiId };
      } else {
        next[id] = val;
      }
    }
    return next;
  };

  return {
    ...state,
    roots: remapEntity(state.roots),
    trunks: remapEntity(state.trunks),
    branches: remapEntity(state.branches),
    leaves: remapEntity(state.leaves),
    twigs: remapEntity(state.twigs),
    sticks: remapEntity(state.sticks),
    anchors: remapEntity(state.anchors),
  };
}

function hexToRgb(hex: string): [number, number, number] {
  if (!hex || typeof hex !== 'string') {
    return [225, 29, 72]; // Safe default fallback (Marker Red `#E11D48`)
  }
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) || 0;
  const g = parseInt(clean.substring(2, 4), 16) || 0;
  const b = parseInt(clean.substring(4, 6), 16) || 0;
  return [r, g, b];
}

function dilate(triangleSet: Set<number>, map: ClientAdjacencyMap): Set<number> {
  const dilated = new Set(triangleSet);
  for (const triId of triangleSet) {
    const neighbors = map.faceToFaces[triId] || [];
    for (const n of neighbors) {
      dilated.add(n);
    }
  }
  return dilated;
}

function erode(triangleSet: Set<number>, map: ClientAdjacencyMap): Set<number> {
  const eroded = new Set<number>();
  for (const triId of triangleSet) {
    const neighbors = map.faceToFaces[triId] || [];
    let keep = true;
    for (const n of neighbors) {
      if (!triangleSet.has(n)) {
        keep = false;
        break;
      }
    }
    if (keep) {
      eroded.add(triId);
    }
  }
  return eroded;
}

function hasIslandsOrHoles(triangleSet: Set<number>, map: ClientAdjacencyMap): boolean {
  if (triangleSet.size === 0) return false;

  // 1. Check for disconnected components (islands)
  const visited = new Set<number>();
  let componentsCount = 0;

  for (const triId of triangleSet) {
    if (visited.has(triId)) continue;
    componentsCount++;
    if (componentsCount > 1) return true; // Found disjointed islands!

    // BFS to find connected component
    const queue: number[] = [triId];
    visited.add(triId);
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const adjs = map.faceToFaces[curr] || [];
      for (const adj of adjs) {
        if (triangleSet.has(adj) && !visited.has(adj)) {
          visited.add(adj);
          queue.push(adj);
        }
      }
    }
  }

  // 2. Check for internal holes (unselected faces where at least 2 neighbors are selected)
  for (const triId of triangleSet) {
    const neighbors = map.faceToFaces[triId] || [];
    for (const n of neighbors) {
      if (!triangleSet.has(n)) {
        const nNeighbors = map.faceToFaces[n] || [];
        let selectedCount = 0;
        for (const nn of nNeighbors) {
          if (triangleSet.has(nn)) {
            selectedCount++;
          }
        }
        if (selectedCount >= 2) {
          return true; // Found a hole!
        }
      }
    }
  }

  return false;
}

function morphologicalClosing(triangleSet: Set<number>, map: ClientAdjacencyMap): Set<number> {
  if (!hasIslandsOrHoles(triangleSet, map)) {
    return triangleSet;
  }
  return erode(dilate(triangleSet, map), map);
}

function _recomputeTriangleColorMap(): TriangleColorMap {
  const map: TriangleColorMap = new Map();
  // 1. Committed regions
  for (const region of regions.values()) {
    const isVectorBrush = region.brushType === 'PointPath' || region.brushType === 'PointPerimeter' || region.brushType === 'SharpCorner';
    if (isVectorBrush) {
      continue;
    }
    const rgb = hexToRgb(region.color);
    const isSelected = selectedRegionIds.has(region.id);
    const alpha = isSelected ? 200 : 255;
    for (const triId of region.triangleIds) {
      map.set(triId, [rgb[0], rgb[1], rgb[2], alpha]);
    }
  }
  // 2. Proposed/hover preview
  const isVectorActive = activeBrush === 'PointPath' || activeBrush === 'PointPerimeter' || activeBrush === 'SharpCorner';
  if (!isVectorActive) {
    const activeColor = BRUSH_COLORS[activeBrush];
    const rgbActive = hexToRgb(activeColor);
    for (const triId of proposedTriangleIds) {
      map.set(triId, [rgbActive[0], rgbActive[1], rgbActive[2], 128]);
    }
  }
  return map;
}

let activeMeshGetter: (() => THREE.Mesh | null) | null = null;

export const supportPainterStore = {
  registerActiveMeshGetter(getter: () => THREE.Mesh | null) {
    activeMeshGetter = getter;
  },

  getActiveMesh(): THREE.Mesh | null {
    return activeMeshGetter ? activeMeshGetter() : null;
  },

  getSnapshot(): SupportPainterState {
    return storeSnapshot;
  },

  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  activate() {
    if (isActive) return;
    isActive = true;
    interactionPhase = 'Idle';
    hoveredTriangleId = null;
    proposedTriangleIds.clear();
    pointPathPoints = [];
    pointPathClosed = false;
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
  },

  deactivate() {
    if (!isActive) return;
    isActive = false;
    interactionPhase = 'Idle';
    hoveredTriangleId = null;
    proposedTriangleIds.clear();
    scannedMinima = [];
    pointPathPoints = [];
    pointPathClosed = false;
    clientAdjacencyMap = null; // Clean up memory cache
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
  },

  setDirectGenEnabled(enabled: boolean) {
    if (directGenEnabled === enabled) return;
    directGenEnabled = enabled;
    updateSnapshot();
    notify();
  },

  getClientAdjacencyMap(): ClientAdjacencyMap | null {
    return clientAdjacencyMap;
  },

  setClientAdjacencyMap(map: ClientAdjacencyMap | null) {
    clientAdjacencyMap = map;
    updateSnapshot();
    notify();
  },

  setSmartBrushesDisplayMode(mode: 'std' | 'ext') {
    if (smartBrushesDisplayMode === mode) return;
    smartBrushesDisplayMode = mode;
    if (mode === 'std') {
      const hiddenBrushes = new Set<BrushType>(['Point', 'RoughEdge', 'SoftRidge', 'Ring', 'PointPath', 'PointPerimeter', 'SharpCorner']);
      if (hiddenBrushes.has(activeBrush)) {
        this.setActiveBrush('MacroFace');
        return;
      }
    }
    updateSnapshot();
    notify();
  },

  setModelStatsCardCollapsed(collapsed: boolean) {
    if (modelStatsCardCollapsed === collapsed) return;
    modelStatsCardCollapsed = collapsed;
    updateSnapshot();
    notify();
  },


  setActiveBrush(brush: BrushType) {
    if (activeBrush === brush) return;
    activeBrush = brush;
    
    pointPathPoints = [];
    pointPathClosed = false;
    
    const isMarker = brush === 'Marker' || (activeCustomBrushId !== null && customBrushes.get(activeCustomBrushId)?.baseBrush === 'Marker');
    if (isMarker && directGenEnabled) {
      directGenEnabled = false;
    }
    
    const defaultScriptId = _getDefaultScriptIdForBrush(brush, brush === 'PointPath' ? pointPathMode : undefined, activeCustomBrushId);
    activePlacementScriptId = defaultScriptId;
    
    const script = placementScripts.get(defaultScriptId);
    if (script) {
      activeBrushPipeline = JSON.parse(JSON.stringify(script.operations));
    } else {
      activeBrushPipeline = null;
    }
    
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
  },

  setModifierKeys(keys: Partial<BrushModifierKeys>) {
    let changed = false;
    if (keys.alt !== undefined && modifierKeys.alt !== keys.alt) {
      modifierKeys.alt = keys.alt;
      changed = true;
    }
    if (keys.shift !== undefined && modifierKeys.shift !== keys.shift) {
      modifierKeys.shift = keys.shift;
      changed = true;
    }
    if (changed) {
      updateSnapshot();
      notify();
    }
  },

  setIsBuildingAdjacencyMap(building: boolean) {
    if (isBuildingAdjacencyMap !== building) {
      isBuildingAdjacencyMap = building;
      updateSnapshot();
      notify();
    }
  },


  setHoveredTriangle(id: number | null, worldPoint?: [number, number, number] | null) {
    let changed = false;
    let faceChanged = false;
    if (hoveredTriangleId !== id) {
      hoveredTriangleId = id;
      changed = true;
      faceChanged = true;
    }
    if (!hoveredWorldPoint && !worldPoint) {
      // do nothing
    } else if (!hoveredWorldPoint || !worldPoint || hoveredWorldPoint[0] !== worldPoint[0] || hoveredWorldPoint[1] !== worldPoint[1] || hoveredWorldPoint[2] !== worldPoint[2]) {
      hoveredWorldPoint = worldPoint || null;
      changed = true;
    }
    
    if (changed) {
      if (id === null && activeBrush === 'SharpCorner') {
        pointPathPoints = [];
      }
      const isVectorBrush = activeBrush === 'PointPath' || activeBrush === 'PointPerimeter' || activeBrush === 'SharpCorner';
      if (faceChanged && !isVectorBrush) {
        proposedTriangleIds.clear();
        if (id !== null) {
          proposedTriangleIds.add(id);
        }
      } else if (isVectorBrush) {
        proposedTriangleIds.clear();
      }
      triangleColorMap = _recomputeTriangleColorMap();
      updateSnapshot();
      notify();
    }
  },

  setProposedTriangleIds(ids: number[] | Set<number>) {
    proposedTriangleIds = new Set(ids);
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
  },

  setHoveredAndProposed(
    id: number | null,
    worldPoint: [number, number, number] | null,
    proposedIds: number[] | Set<number>
  ) {
    let changed = false;
    if (hoveredTriangleId !== id) {
      hoveredTriangleId = id;
      changed = true;
    }
    if (!hoveredWorldPoint && !worldPoint) {
      // do nothing
    } else if (
      !hoveredWorldPoint ||
      !worldPoint ||
      hoveredWorldPoint[0] !== worldPoint[0] ||
      hoveredWorldPoint[1] !== worldPoint[1] ||
      hoveredWorldPoint[2] !== worldPoint[2]
    ) {
      hoveredWorldPoint = worldPoint;
      changed = true;
    }

    const newProposedSet = new Set(proposedIds);
    let proposedChanged = false;
    if (proposedTriangleIds.size !== newProposedSet.size) {
      proposedChanged = true;
    } else {
      for (const tid of newProposedSet) {
        if (!proposedTriangleIds.has(tid)) {
          proposedChanged = true;
          break;
        }
      }
    }

    if (changed || proposedChanged) {
      proposedTriangleIds = newProposedSet;
      triangleColorMap = _recomputeTriangleColorMap();
      updateSnapshot();
      notify();
    }
  },

  commitPaintStroke(
    hoveredId: number | null,
    worldPoint: [number, number, number] | null,
    proposedIds: number[] | Set<number>,
    isSubtract: boolean,
    selectedRegionId: string | null
  ) {
    // 1. Update hover info
    hoveredTriangleId = hoveredId;
    hoveredWorldPoint = worldPoint;

    // 2. Apply stroke
    if (isSubtract) {
      const idsSet = new Set(proposedIds);
      for (const [id, region] of regions.entries()) {
        const nextSet = new Set<number>();
        let changed = false;
        for (const tid of region.triangleIds) {
          if (idsSet.has(tid)) {
            changed = true;
          } else {
            nextSet.add(tid);
          }
        }
        if (changed) {
          if (nextSet.size === 0) {
            regions.delete(id);
          } else {
            region.triangleIds = nextSet;
            region.rleSpans = undefined;
            region.loops = undefined;
            this.pruneOrphans(id);
          }
        }
      }
    } else if (selectedRegionId) {
      const region = regions.get(selectedRegionId);
      if (region) {
        let nextSet = new Set(region.triangleIds);
        for (const tid of proposedIds) {
          nextSet.add(tid);
        }
        const isMarker = region.brushType === 'Marker' || (region.customBrush && region.customBrush.baseBrush === 'Marker');
        if (isMarker && clientAdjacencyMap) {
          nextSet = morphologicalClosing(nextSet, clientAdjacencyMap);
        }
        region.triangleIds = nextSet;
        region.rleSpans = undefined;
        region.loops = undefined;

        // Handle collisions
        const collisionMode = region.customBrush
          ? (region.customBrush.selection.markerCollisionMode ?? 'fence')
          : markerCollisionMode;

        if (isMarker) {
          if (collisionMode === 'push') {
            for (const [otherId, otherReg] of regions.entries()) {
              if (otherId === selectedRegionId) continue;
              let intersected = false;
              const nextOtherSet = new Set<number>();
              for (const tid of otherReg.triangleIds) {
                if (nextSet.has(tid)) {
                  intersected = true;
                } else {
                  nextOtherSet.add(tid);
                }
              }
              if (intersected) {
                if (nextOtherSet.size === 0) {
                  regions.delete(otherId);
                } else {
                  otherReg.triangleIds = nextOtherSet;
                  otherReg.rleSpans = undefined;
                  otherReg.loops = undefined;
                  this.pruneOrphans(otherId);
                }
              }
            }
          } else if (collisionMode === 'merge') {
            const mergedIds = new Set<string>();
            for (const [otherId, otherReg] of regions.entries()) {
              if (otherId === selectedRegionId) continue;
              let hasOverlap = false;
              for (const tid of otherReg.triangleIds) {
                if (nextSet.has(tid)) {
                  hasOverlap = true;
                  break;
                }
              }
              if (hasOverlap) {
                for (const tid of otherReg.triangleIds) {
                  nextSet.add(tid);
                }
                mergedIds.add(otherId);
              }
            }
            if (mergedIds.size > 0) {
              region.triangleIds = nextSet;
              for (const otherId of mergedIds) {
                regions.delete(otherId);
                const supportState = getSupportSnapshot();
                const nextSupportState = _remapSupportsRoiId(supportState, [otherId], selectedRegionId);
                setSupportSnapshot(nextSupportState);
              }
            }
          }
        }
      }
    }

    // 3. Clear preview proposedTriangleIds since the stroke is committed
    proposedTriangleIds.clear();

    // 4. Update snapshot and notify exactly ONCE
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
  },

  setInteractionPhase(phase: BrushInteractionPhase) {
    if (interactionPhase === phase) return;
    interactionPhase = phase;
    updateSnapshot();
    notify();
  },

  commitRegion(payload: CommitRegionPayload): string {
    const activeCustomBrush = activeCustomBrushId ? customBrushes.get(activeCustomBrushId) : undefined;
    const isMarker = payload.brushType === 'Marker' || (activeCustomBrush && activeCustomBrush.baseBrush === 'Marker');
    const eraserMode = activeCustomBrush ? activeCustomBrush.selection.markerEraserMode : markerEraserMode;
    const collisionMode = activeCustomBrush ? (activeCustomBrush.selection.markerCollisionMode ?? 'fence') : markerCollisionMode;

    let triangleIds = proposedTriangleIds.size > 0
      ? new Set(proposedTriangleIds)
      : new Set([payload.seedTriangleId]);

    // 1. Selective Eraser Mode handling
    if (isMarker && eraserMode) {
      this.subtractTrianglesFromRegions(triangleIds);
      proposedTriangleIds.clear();
      return '';
    }

    if (isMarker && clientAdjacencyMap) {
      triangleIds = morphologicalClosing(triangleIds, clientAdjacencyMap);
    }

    const id = crypto.randomUUID?.() || Math.random().toString(36).substring(2);
    const color = activeCustomBrush ? activeCustomBrush.color : BRUSH_COLORS[payload.brushType];

    const trunkWidth = getShaftProfile()?.diameterMm ?? 1.5;
    const defaultSpacing = trunkWidth * 4.0;
    const resolvedOps = activeBrushPipeline || (activeCustomBrush?.operations) || getDefaultOperationsForBrush(payload.brushType, defaultSpacing);
    const customBrushOverride = {
      id: activeCustomBrush ? activeCustomBrush.id : `temp-pipeline-${Date.now()}`,
      name: activeCustomBrush ? activeCustomBrush.name : `Temp ${payload.brushType} Config`,
      color,
      baseBrush: activeCustomBrush ? activeCustomBrush.baseBrush : payload.brushType,
      selection: activeCustomBrush ? { ...activeCustomBrush.selection } : {
        normalConeAngleMinDeg: 0,
        normalConeAngleMaxDeg: 90,
        overhangSlopeMinDeg: 0,
        overhangSlopeMaxDeg: 90,
        curvatureMin: 0,
        curvatureMax: 1,
        dihedralAngleToleranceDeg: 0,
      },
      operations: JSON.parse(JSON.stringify(resolvedOps)),
    };

    const scriptId = activePlacementScriptId || _getDefaultScriptIdForBrush(activeCustomBrush ? activeCustomBrush.baseBrush || payload.brushType : payload.brushType, payload.brushType === 'PointPath' ? pointPathMode : undefined);

    const newRegion: ROIRegion = {
      id,
      brushType: payload.brushType,
      seedTriangleId: payload.seedTriangleId,
      triangleIds: new Set(triangleIds),
      color,
      proposedOnly: false,
      createdAt: Date.now(),
      customBrush: customBrushOverride,
      placementScriptId: scriptId,
      modelId: activeModelId ?? undefined,
    };

    regions.set(id, newRegion);
    selectedRegionId = id; // Auto-select the newly created region

    // 2. Additive collision modes handling
    if (isMarker) {
      if (collisionMode === 'push') {
        // Erode other ROIs
        for (const [otherId, otherReg] of regions.entries()) {
          if (otherId === id) continue;
          let intersected = false;
          const nextOtherSet = new Set<number>();
          for (const tid of otherReg.triangleIds) {
            if (triangleIds.has(tid)) {
              intersected = true;
            } else {
              nextOtherSet.add(tid);
            }
          }
          if (intersected) {
            if (nextOtherSet.size === 0) {
              regions.delete(otherId);
            } else {
              otherReg.triangleIds = nextOtherSet;
              otherReg.rleSpans = undefined;
              otherReg.loops = undefined;
              this.pruneOrphans(otherId);
            }
          }
        }
      } else if (collisionMode === 'merge') {
        // Merge with touched ROIs
        const touchedIds: string[] = [];
        for (const [otherId, otherReg] of regions.entries()) {
          if (otherId === id) continue;
          for (const tid of otherReg.triangleIds) {
            if (triangleIds.has(tid)) {
              touchedIds.push(otherId);
              break;
            }
          }
        }
        if (touchedIds.length > 0) {
          const nextSet = new Set(newRegion.triangleIds);
          for (const otherId of touchedIds) {
            const otherReg = regions.get(otherId)!;
            for (const tid of otherReg.triangleIds) {
              nextSet.add(tid);
            }
            regions.delete(otherId);
          }
          newRegion.triangleIds = nextSet;

          // Remap supports belonging to merged ROIs to the new unified ROI
          const supportState = getSupportSnapshot();
          const nextSupportState = _remapSupportsRoiId(supportState, touchedIds, id);
          setSupportSnapshot(nextSupportState);
        }
      }
    }

    proposedTriangleIds.clear();
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
    return id;
  },

  appendTrianglesToRegion(regionId: string, triangleIds: Set<number> | number[]) {
    const region = regions.get(regionId);
    if (!region) return;

    let nextSet = new Set(region.triangleIds);
    for (const tid of triangleIds) {
      nextSet.add(tid);
    }

    const isMarker = region.brushType === 'Marker' || (region.customBrush && region.customBrush.baseBrush === 'Marker');
    if (isMarker && clientAdjacencyMap) {
      nextSet = morphologicalClosing(nextSet, clientAdjacencyMap);
    }

    region.triangleIds = nextSet;
    region.rleSpans = undefined;
    region.loops = undefined;

    // Handle Erode / Push / Merge collisions for the appended stroke triangles
    const collisionMode = region.customBrush
      ? (region.customBrush.selection.markerCollisionMode ?? 'fence')
      : markerCollisionMode;

    if (isMarker) {
      if (collisionMode === 'push') {
        // Erode other ROIs
        for (const [otherId, otherReg] of regions.entries()) {
          if (otherId === regionId) continue;
          let intersected = false;
          const nextOtherSet = new Set<number>();
          for (const tid of otherReg.triangleIds) {
            if (nextSet.has(tid)) {
              intersected = true;
            } else {
              nextOtherSet.add(tid);
            }
          }
          if (intersected) {
            if (nextOtherSet.size === 0) {
              regions.delete(otherId);
            } else {
              otherReg.triangleIds = nextOtherSet;
              otherReg.rleSpans = undefined;
              otherReg.loops = undefined;
              this.pruneOrphans(otherId);
            }
          }
        }
      } else if (collisionMode === 'merge') {
        // Merge with touched ROIs
        const touchedIds: string[] = [];
        for (const [otherId, otherReg] of regions.entries()) {
          if (otherId === regionId) continue;
          for (const tid of otherReg.triangleIds) {
            if (nextSet.has(tid)) {
              touchedIds.push(otherId);
              break;
            }
          }
        }
        if (touchedIds.length > 0) {
          for (const otherId of touchedIds) {
            const otherReg = regions.get(otherId)!;
            for (const tid of otherReg.triangleIds) {
              nextSet.add(tid);
            }
            regions.delete(otherId);
          }
          region.triangleIds = nextSet;
          region.rleSpans = undefined;
          region.loops = undefined;

          // Remap supports belonging to merged ROIs to the active unified ROI
          const supportState = getSupportSnapshot();
          const nextSupportState = _remapSupportsRoiId(supportState, touchedIds, regionId);
          setSupportSnapshot(nextSupportState);
        }
      }
    }

    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
  },

  subtractTrianglesFromRegions(triangleIds: Set<number> | number[]) {
    const idsSet = new Set(triangleIds);
    for (const [id, region] of regions.entries()) {
      const nextSet = new Set<number>();
      let changed = false;
      for (const tid of region.triangleIds) {
        if (idsSet.has(tid)) {
          changed = true;
        } else {
          nextSet.add(tid);
        }
      }
      if (changed) {
        if (nextSet.size === 0) {
          regions.delete(id);
        } else {
          region.triangleIds = nextSet;
          region.rleSpans = undefined;
          region.loops = undefined;
          this.pruneOrphans(id);
        }
      }
    }
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
  },

  removeRegion(regionId: string) {
    if (!regions.has(regionId)) return;

    const sortedRegions = Array.from(regions.values()).sort((a, b) => b.createdAt - a.createdAt);
    const idx = sortedRegions.findIndex(r => r.id === regionId);

    regions.delete(regionId);

    if (selectedRegionIds.has(regionId) || selectedRegionId === regionId) {
      selectedRegionIds.delete(regionId);
      
      const remainingRegions = Array.from(regions.values()).sort((a, b) => b.createdAt - a.createdAt);
      let nextSelectedId: string | null = null;
      if (remainingRegions.length > 0) {
        const nextIdx = Math.min(idx, remainingRegions.length - 1);
        nextSelectedId = remainingRegions[nextIdx].id;
      }
      
      selectedRegionId = nextSelectedId;
      selectedRegionIds = nextSelectedId ? new Set([nextSelectedId]) : new Set();
      lastSelectedIndex = nextSelectedId ? Math.min(idx, remainingRegions.length - 1) : null;
    }

    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
  },

  removeRegionContainingTriangle(triangleId: number): string | null {
    let foundId: string | null = null;
    for (const [id, region] of regions.entries()) {
      if (region.triangleIds.has(triangleId)) {
        foundId = id;
        break;
      }
    }
    if (foundId) {
      regions.delete(foundId);
      triangleColorMap = _recomputeTriangleColorMap();
      updateSnapshot();
      notify();
    }
    return foundId;
  },

  setActiveModelId(modelId: string | null) {
    if (activeModelId === modelId) return;
    activeModelId = modelId;
    if (modelId) {
      let modelRegions = regionsByModel.get(modelId);
      if (!modelRegions) {
        modelRegions = new Map<string, ROIRegion>();
        regionsByModel.set(modelId, modelRegions);
      }
      regions = modelRegions;
    } else {
      regions = new Map<string, ROIRegion>();
    }
    proposedTriangleIds.clear();
    hoveredTriangleId = null;
    scannedMinima = [];
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
  },

  restoreRegions(nextRegions: Map<string, ROIRegion>) {
    regions = new Map(nextRegions);
    if (activeModelId) {
      regionsByModel.set(activeModelId, regions);
    }
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
  },

  loadFromVoxl(ext: VoxlROIExtension) {
    const conflicts: ConflictItem[] = [];

    if (ext.version === 4) {
      if (ext.customPlacementScripts) {
        for (const imported of ext.customPlacementScripts) {
          const local = placementScripts.get(imported.id);
          if (local && !local.isBuiltIn) {
            const different = local.name !== imported.name || !arePipelinesEquivalent(local.operations, imported.operations);
            if (different) {
              conflicts.push({
                id: imported.id,
                type: 'script',
                name: imported.name,
                localName: local.name,
                importedValue: imported,
                localValue: local,
              });
            }
          }
        }
      }

      if (ext.customSupportPresets) {
        for (const imported of ext.customSupportPresets) {
          const local = getPresetById(imported.id);
          if (local && !local.isBuiltIn) {
            const different = local.name !== imported.name || JSON.stringify(local.settings) !== JSON.stringify(imported.settings);
            if (different) {
              conflicts.push({
                id: imported.id,
                type: 'preset',
                name: imported.name,
                localName: local.name,
                importedValue: imported,
                localValue: local,
              });
            }
          }
        }
      }
    }

    if (conflicts.length > 0) {
      conflictState = {
        conflicts,
        pendingRoiExt: ext,
      };
      updateSnapshot();
      notify();
      return;
    }

    this.executeLoadFromVoxl(ext);
  },

  executeLoadFromVoxl(ext: VoxlROIExtension, resolutions?: Record<string, 'overwrite' | 'keepLocal' | 'rename'>) {
    // 1. Process custom scripts
    if (ext.customPlacementScripts) {
      for (const script of ext.customPlacementScripts) {
        const res = resolutions?.[script.id];
        if (res === 'keepLocal') {
          continue;
        } else if (res === 'rename') {
          const newId = `${script.id}-imported-${Date.now()}`;
          const newName = `${script.name} (Imported)`;
          const renamedScript = {
            ...script,
            id: newId,
            name: newName,
            isBuiltIn: false,
          };
          this.addPlacementScript(renamedScript);
          this.remapScriptIdInExtension(ext, script.id, newId);
        } else {
          this.addPlacementScript({
            ...script,
            isBuiltIn: false,
          });
        }
      }
    }

    // 2. Process custom support presets
    if (ext.customSupportPresets) {
      for (const preset of ext.customSupportPresets) {
        const res = resolutions?.[preset.id];
        if (res === 'keepLocal') {
          continue;
        } else if (res === 'rename') {
          const newId = `${preset.id}-imported-${Date.now()}`;
          const newName = `${preset.name} (Imported)`;
          const renamedPreset = {
            ...preset,
            id: newId,
            name: newName,
            isBuiltIn: false,
          };
          importCustomPreset(renamedPreset);
          this.remapPresetIdInExtension(ext, preset.id, newId);
        } else {
          importCustomPreset({
            ...preset,
            isBuiltIn: false,
          });
        }
      }
    }

    // 3. Process regions
    const loadedRegions = deserializeROIsFromVoxl(ext);
    for (const [mId, mRegions] of loadedRegions.entries()) {
      regionsByModel.set(mId, mRegions);
      
      for (const region of mRegions.values()) {
        const scriptId = region.placementScriptId;
        if (scriptId && !scriptId.startsWith('default-') && scriptId !== 'unsaved') {
          if (region.customBrush && !placementScripts.has(scriptId)) {
            this.addPlacementScript({
              id: scriptId,
              name: region.customBrush.name || `Imported Custom Script`,
              operations: region.customBrush.operations,
              isBuiltIn: false,
              isReadOnly: false,
            });
          }
        }
      }
    }

    if (activeModelId) {
      let modelRegions = regionsByModel.get(activeModelId);
      if (!modelRegions) {
        modelRegions = new Map<string, ROIRegion>();
        regionsByModel.set(activeModelId, modelRegions);
      }
      regions = modelRegions;
    } else {
      regions = new Map<string, ROIRegion>();
    }
    proposedTriangleIds.clear();
    hoveredTriangleId = null;
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
  },

  remapScriptIdInExtension(ext: VoxlROIExtension, oldId: string, newId: string) {
    for (const region of ext.regions) {
      if (region.placementScriptId === oldId) {
        region.placementScriptId = newId;
      }
    }
  },

  remapPresetIdInExtension(ext: VoxlROIExtension, oldId: string, newId: string) {
    for (const region of ext.regions) {
      if (region.customBrush?.operations) {
        for (const op of region.customBrush.operations) {
          if (op.supportPresetId === oldId) {
            op.supportPresetId = newId;
          }
        }
      }
    }
    if (ext.customPlacementScripts) {
      for (const script of ext.customPlacementScripts) {
        for (const op of script.operations) {
          if (op.supportPresetId === oldId) {
            op.supportPresetId = newId;
          }
        }
      }
    }
  },

  resolveImportConflicts(resolutions: Record<string, 'overwrite' | 'keepLocal' | 'rename'>) {
    if (!conflictState) return;
    const ext = conflictState.pendingRoiExt;
    conflictState = null;
    this.executeLoadFromVoxl(ext, resolutions);
  },

  cancelImportConflicts() {
    conflictState = null;
    updateSnapshot();
    notify();
  },

  getAllRegionsByModel(): Map<string, Map<string, ROIRegion>> {
    return new Map(regionsByModel);
  },

  clearAll() {
    if (regions.size === 0) return;
    regions.clear();
    proposedTriangleIds.clear();
    hoveredTriangleId = null;
    scannedMinima = [];
    selectedRegionId = null;
    selectedRegionIds.clear();
    lastSelectedIndex = null;
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
  },

  clearPending() {
    let changed = false;
    for (const [id, r] of regions.entries()) {
      if (r.support === undefined && r.loops === undefined) {
        regions.delete(id);
        selectedRegionIds.delete(id);
        if (selectedRegionId === id) {
          selectedRegionId = null;
        }
        changed = true;
      }
    }
    if (!changed) return;

    if (selectedRegionId === null) {
      const remainingRegions = Array.from(regions.values()).sort((a, b) => b.createdAt - a.createdAt);
      if (remainingRegions.length > 0) {
        selectedRegionId = remainingRegions[0].id;
        selectedRegionIds = new Set([remainingRegions[0].id]);
        lastSelectedIndex = 0;
      } else {
        selectedRegionIds.clear();
        lastSelectedIndex = null;
      }
    }

    proposedTriangleIds.clear();
    hoveredTriangleId = null;
    scannedMinima = [];
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
  },


  // ─── Extended Spacing, Suppression & Toast Actions ───
  // [AGENT_NOTE] Invoked by the UI panels and support scripting engine to coordinate updates.

  setPerimeterSpacingOverride(val: number | null) {
    if (perimeterSpacingOverride === val) return;
    perimeterSpacingOverride = val;
    updateSnapshot();
    notify();
  },

  setInfillSpacingOverride(val: number | null) {
    if (infillSpacingOverride === val) return;
    infillSpacingOverride = val;
    updateSnapshot();
    notify();
  },

  setSuppressionSettings(settings: SuppressionSettings) {
    suppressionSettings = { ...settings };
    updateSnapshot();
    notify();
  },

  showToast(lines: string[]) {
    if (toastTimeout) clearTimeout(toastTimeout);
    toast = { id: Date.now(), lines };
    updateSnapshot();
    notify();

    toastTimeout = setTimeout(() => {
      toast = null;
      updateSnapshot();
      notify();
    }, 4500);
  },

  clearToast() {
    if (toastTimeout) clearTimeout(toastTimeout);
    toast = null;
    updateSnapshot();
    notify();
  },

  setRoiTrackingMode(mode: 'none' | 'session' | 'voxl') {
    if (roiTrackingMode === mode) return;
    roiTrackingMode = mode;
    
    // If switched to 'none', immediately purge all memory regions.
    if (mode === 'none') {
      regions.clear();
      proposedTriangleIds.clear();
      hoveredTriangleId = null;
      triangleColorMap = _recomputeTriangleColorMap();
    }
    
    updateSnapshot();
    notify();
  },

  stripRoiData(modelId?: string | null) {
    // Purges active ROI map globally or for the specific model.
    if (modelId) {
      regionsByModel.delete(modelId);
      if (modelId === activeModelId) {
        regions = new Map<string, ROIRegion>();
        regionsByModel.set(modelId, regions);
      }
    } else {
      regionsByModel.clear();
      regions.clear();
    }
    proposedTriangleIds.clear();
    hoveredTriangleId = null;
    scannedMinima = [];
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
  },

  setSelectedRegionId(id: string | null) {
    if (selectedRegionId === id) return;
    selectedRegionId = id;
    selectedRegionIds = id ? new Set([id]) : new Set();
    lastSelectedIndex = null;
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
  },

  setSelectedRegionIds(ids: Set<string>, index?: number | null) {
    selectedRegionIds = new Set(ids);
    selectedRegionId = ids.size > 0 ? Array.from(ids)[ids.size - 1] : null;
    if (index !== undefined) {
      lastSelectedIndex = index;
    }
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
  },

  addCustomBrush(brush: CustomBrushTemplate) {
    customBrushes.set(brush.id, brush);
    saveCustomBrushesToLocalStorage();
    updateSnapshot();
    notify();
  },

  updateCustomBrush(id: string, updates: Partial<CustomBrushTemplate>) {
    const existing = customBrushes.get(id);
    if (!existing) return;
    const updated = {
      ...existing,
      ...updates,
      selection: { ...existing.selection, ...updates.selection },
      operations: updates.operations ? [...updates.operations] : existing.operations,
    };
    customBrushes.set(id, updated);
    saveCustomBrushesToLocalStorage();
    updateSnapshot();
    notify();
  },

  deleteCustomBrush(id: string) {
    if (!customBrushes.has(id)) return;
    customBrushes.delete(id);
    if (activeCustomBrushId === id) {
      activeCustomBrushId = null;
    }
    saveCustomBrushesToLocalStorage();
    updateSnapshot();
    notify();
  },

  setActiveCustomBrushId(id: string | null) {
    if (activeCustomBrushId === id) return;
    activeCustomBrushId = id;
    
    const isMarker = activeBrush === 'Marker' || (id !== null && customBrushes.get(id)?.baseBrush === 'Marker');
    if (isMarker && directGenEnabled) {
      directGenEnabled = false;
    }
    
    const defaultScriptId = _getDefaultScriptIdForBrush(activeBrush, activeBrush === 'PointPath' ? pointPathMode : undefined, id);
    activePlacementScriptId = defaultScriptId;
    
    const script = placementScripts.get(defaultScriptId);
    if (script) {
      activeBrushPipeline = JSON.parse(JSON.stringify(script.operations));
    } else {
      activeBrushPipeline = null;
    }
    
    updateSnapshot();
    notify();
  },

  setBrushRadiusMm(radius: number) {
    const clamped = Math.max(0.5, Math.min(50, radius));
    if (brushRadiusMm === clamped) return;
    brushRadiusMm = clamped;
    updateSnapshot();
    notify();
  },

  adjustBrushRadiusMm(delta: number) {
    const clamped = Math.max(0.5, Math.min(50, brushRadiusMm + delta));
    if (brushRadiusMm === clamped) return;
    brushRadiusMm = clamped;
    updateSnapshot();
    notify();
  },

  setMarkerRadiusMm(radius: number) {
    const clamped = Math.max(0.1, Math.min(50, radius));
    if (markerRadiusMm === clamped) return;
    markerRadiusMm = clamped;
    updateSnapshot();
    notify();
  },

  adjustMarkerRadiusMm(delta: number) {
    const clamped = Math.max(0.1, Math.min(50, markerRadiusMm + delta));
    if (markerRadiusMm === clamped) return;
    markerRadiusMm = clamped;
    updateSnapshot();
    notify();
  },

  setMarkerTipShape(shape: 'circle' | 'line' | 'rectangle' | 'square' | 'hexagon') {
    if (markerTipShape === shape) return;
    markerTipShape = shape;
    updateSnapshot();
    notify();
  },

  setMarkerTipRotationDeg(deg: number) {
    if (markerTipRotationDeg === deg) return;
    markerTipRotationDeg = deg;
    updateSnapshot();
    notify();
  },

  setMarkerEraserMode(mode: boolean) {
    if (markerEraserMode === mode) return;
    markerEraserMode = mode;
    updateSnapshot();
    notify();
  },

  setMarkerCollisionMode(mode: 'fence' | 'push' | 'merge') {
    if (markerCollisionMode === mode) return;
    markerCollisionMode = mode;
    updateSnapshot();
    notify();
  },

  booleanOperate(type: 'union' | 'subtract' | 'intersect', roiIdA: string, roiIdB: string) {
    const rA = regions.get(roiIdA);
    const rB = regions.get(roiIdB);
    if (!rA || !rB) return;

    // Capture states before operation for history transaction
    const beforeState = new Map(regions);
    const beforeSupport = getSupportSnapshot();

    const nextRegions = new Map(regions);
    const nextRA = { ...rA, rleSpans: undefined, loops: undefined };

    if (type === 'union') {
      nextRA.triangleIds = new Set([...rA.triangleIds, ...rB.triangleIds]);
      nextRegions.set(roiIdA, nextRA);
      nextRegions.delete(roiIdB);

      // Remap supports of the merged ROI to the unified target ROI
      const supportState = getSupportSnapshot();
      const nextSupportState = _remapSupportsRoiId(supportState, [roiIdB], roiIdA);
      setSupportSnapshot(nextSupportState);
    } else if (type === 'subtract') {
      const nextSet = new Set<number>();
      for (const id of rA.triangleIds) {
        if (!rB.triangleIds.has(id)) {
          nextSet.add(id);
        }
      }
      nextRA.triangleIds = nextSet;
      if (nextSet.size === 0) {
        nextRegions.delete(roiIdA);
      } else {
        nextRegions.set(roiIdA, nextRA);
      }
    } else if (type === 'intersect') {
      const nextSet = new Set<number>();
      for (const id of rA.triangleIds) {
        if (rB.triangleIds.has(id)) {
          nextSet.add(id);
        }
      }
      nextRA.triangleIds = nextSet;
      if (nextSet.size === 0) {
        nextRegions.delete(roiIdA);
      } else {
        nextRegions.set(roiIdA, nextRA);
      }
    }

    regions = nextRegions;
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();

    pushHistory({
      type: SUPPORT_EDIT_REPLACE,
      description: `Boolean ROI ${type}`,
      payload: {
        before: beforeSupport,
        after: getSupportSnapshot(),
        painterRegionsBefore: beforeState,
        painterRegionsAfter: nextRegions,
      },
    });
  },

  pruneOrphans(regionId: string) {
    const region = regions.get(regionId);
    if (!region || !clientAdjacencyMap || region.triangleIds.size === 0) return;
    if (region.brushType === 'MinimaIslands') return; // Exempt multi-island minima from component pruning

    const triangleIds = region.triangleIds;
    const seed = region.seedTriangleId;

    // 1. Identify the largest connected component of triangles using BFS
    const visited = new Set<number>();
    let largestComponent = new Set<number>();

    for (const triId of triangleIds) {
      if (visited.has(triId)) continue;

      const currentComponent = new Set<number>();
      const queue: number[] = [triId];
      currentComponent.add(triId);
      visited.add(triId);

      while (queue.length > 0) {
        const curr = queue.shift()!;
        const adjs = clientAdjacencyMap.faceToFaces[curr] || [];
        for (const adj of adjs) {
          if (triangleIds.has(adj) && !currentComponent.has(adj)) {
            currentComponent.add(adj);
            visited.add(adj);
            queue.push(adj);
          }
        }
      }

      if (currentComponent.size > largestComponent.size) {
        largestComponent = currentComponent;
      }
    }

    const mainComponent = largestComponent;

    // 2. Dynamic seed replacement: pick a new seed triangle from the largest component if the original seed is missing/erased
    let seedChanged = false;
    let newSeed = seed;
    if (!mainComponent.has(seed) && mainComponent.size > 0) {
      newSeed = mainComponent.values().next().value!;
      seedChanged = true;
    }

    // 3. Apply changes and notify store
    if (mainComponent.size < triangleIds.size || seedChanged) {
      if (mainComponent.size < triangleIds.size) {
        console.log(`[SupportPainterStore] Pruning ${triangleIds.size - mainComponent.size} isolated triangles.`);
      }
      const nextRegion = { 
        ...region, 
        triangleIds: mainComponent, 
        seedTriangleId: newSeed,
        rleSpans: undefined, 
        loops: undefined 
      };
      regions.set(regionId, nextRegion);
      triangleColorMap = _recomputeTriangleColorMap();
      updateSnapshot();
      notify();
    }
  },

  commitMinimaIslands(minimaList: { seedTriangleId: number }[], matrixWorld?: THREE.Matrix4) {
    if (!clientAdjacencyMap || minimaList.length === 0) return;

    const beforeState = new Map(regions);
    const beforeSupport = getSupportSnapshot();

    const mergedTriangles = new Set<number>();
    
    // Choose the first scanned coordinate as the global seed for reference
    const primarySeed = minimaList[0].seedTriangleId;
    const activeMatrix = matrixWorld || new THREE.Matrix4();

    for (const item of minimaList) {
      const proposedIds = proposeRegionOnClient(
        clientAdjacencyMap,
        item.seedTriangleId,
        'ManualCircle',
        activeMatrix,
        0.1 // 0.2mm diameter = 0.1mm radius
      );
      for (const id of proposedIds) {
        mergedTriangles.add(id);
      }
    }

    if (mergedTriangles.size === 0) return;

    // Create consolidated committed region
    const nextRegions = new Map(regions);
    const regionId = `auto-minima-${Date.now()}`;
    const newRegion: ROIRegion = {
      id: regionId,
      brushType: 'MinimaIslands',
      seedTriangleId: primarySeed,
      triangleIds: mergedTriangles,
      color: BRUSH_COLORS.MinimaIslands,
      proposedOnly: false,
      createdAt: Date.now(),
      modelId: activeModelId ?? undefined,
    };

    nextRegions.set(regionId, newRegion);
    regions = nextRegions;
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();

    // Push transaction to history
    pushHistory({
      type: SUPPORT_EDIT_REPLACE,
      description: `Auto-detect minima islands`,
      payload: {
        before: beforeSupport,
        after: getSupportSnapshot(),
        painterRegionsBefore: beforeState,
        painterRegionsAfter: nextRegions,
      },
    });
  },

  setScannedMinima(minima: LocalMinimum[]) {
    scannedMinima = minima;
    updateSnapshot();
    notify();
  },

  clearScannedMinima() {
    scannedMinima = [];
    updateSnapshot();
    notify();
  },

  addPointPathPoint(point: [number, number, number], faceIndex: number, normal?: [number, number, number]) {
    pointPathPoints = [...pointPathPoints, { point, faceIndex, normal }];
    updateSnapshot();
    notify();
  },

  clearPointPathPoints() {
    pointPathPoints = [];
    pointPathClosed = false;
    proposedTriangleIds.clear();
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
  },

  setPointPathPoints(points: { point: [number, number, number]; faceIndex: number; normal?: [number, number, number] }[]) {
    pointPathPoints = points;
    updateSnapshot();
    notify();
  },

  setPointPathWidthMm(width: number) {
    if (pointPathWidthMm === width) return;
    pointPathWidthMm = width;
    updateSnapshot();
    notify();
  },

  setSharpCornerDihedralThresholdDeg(val: number) {
    if (sharpCornerDihedralThresholdDeg === val) return;
    sharpCornerDihedralThresholdDeg = val;
    updateSnapshot();
    notify();
  },

  setSharpCornerWrapCurves(val: boolean) {
    if (sharpCornerWrapCurves === val) return;
    sharpCornerWrapCurves = val;
    updateSnapshot();
    notify();
  },

  setPointPathMode(mode: 'line' | 'polygon') {
    if (pointPathMode === mode) return;
    pointPathMode = mode;
    if (activeBrush === 'PointPath') {
      activePlacementScriptId = _getDefaultScriptIdForBrush('PointPath', mode, activeCustomBrushId);
      const script = placementScripts.get(activePlacementScriptId);
      if (script) {
        activeBrushPipeline = JSON.parse(JSON.stringify(script.operations));
      } else {
        activeBrushPipeline = null;
      }
    }
    updateSnapshot();
    notify();
  },

  setPointPathClosed(closed: boolean) {
    if (pointPathClosed === closed) return;
    pointPathClosed = closed;
    updateSnapshot();
    notify();
  },

  commitPointPathRegion(payload: { seedTriangleId: number; brushType?: BrushType; matrixWorld?: THREE.Matrix4 }): string {
    const brush = payload.brushType || activeBrush;
    const isVectorBrush = brush === 'PointPath' || brush === 'PointPerimeter' || brush === 'SharpCorner';

    if (!isVectorBrush && proposedTriangleIds.size === 0) return '';
    if (isVectorBrush && pointPathPoints.length === 0) return '';

    let finalTriangleIds = new Set<number>(proposedTriangleIds);
    if (clientAdjacencyMap && (brush === 'PointPerimeter' || (brush === 'PointPath' && pointPathMode === 'polygon'))) {
      const activeMatrix = payload.matrixWorld || new THREE.Matrix4();
      const inv = new THREE.Matrix4().copy(activeMatrix).invert();
      const localUp = new THREE.Vector3(0, 0, 1).transformDirection(inv);

      const scale = new THREE.Vector3();
      activeMatrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
      const worldScale = (scale.x + scale.y + scale.z) / 3;

      const pts = pointPathPoints.map(p => p.faceIndex);
      const computedIds = walkPointPathPolygon(clientAdjacencyMap, pts, localUp, worldScale);
      finalTriangleIds = new Set(computedIds);
    }

    const id = crypto.randomUUID?.() || Math.random().toString(36).substring(2);
    const color = BRUSH_COLORS[brush] || BRUSH_COLORS.PointPath;

    const trunkWidth = getShaftProfile()?.diameterMm ?? 1.5;
    const defaultSpacing = trunkWidth * 4.0;
    const resolvedOps = activeBrushPipeline || getDefaultOperationsForBrush(brush, defaultSpacing);
    const customBrushOverride = {
      id: `temp-pipeline-${Date.now()}`,
      name: `Temp ${brush} Config`,
      color,
      baseBrush: brush,
      selection: {
        normalConeAngleMinDeg: 0,
        normalConeAngleMaxDeg: 90,
        overhangSlopeMinDeg: 0,
        overhangSlopeMaxDeg: 90,
        curvatureMin: 0,
        curvatureMax: 1,
        dihedralAngleToleranceDeg: 0,
      },
      operations: JSON.parse(JSON.stringify(resolvedOps)),
    };

    const scriptId = activePlacementScriptId || _getDefaultScriptIdForBrush(brush);
    const newRegion: ROIRegion = {
      id,
      brushType: brush,
      seedTriangleId: payload.seedTriangleId,
      triangleIds: finalTriangleIds,
      color,
      proposedOnly: false,
      createdAt: Date.now(),
      customBrush: customBrushOverride,
      placementScriptId: scriptId,
      modelId: activeModelId ?? undefined,
      vectorPath: isVectorBrush
        ? (() => {
            const rawPath = pointPathPoints.map(p => ({
              point: [...p.point] as [number, number, number],
              normal: p.normal ? [...p.normal] as [number, number, number] : undefined,
              faceIndex: p.faceIndex
            }));
            if (clientAdjacencyMap && brush !== 'SharpCorner') {
              return expandPathWithDijkstra(clientAdjacencyMap, rawPath, pointPathClosed);
            }
            return rawPath;
          })()
        : undefined,
    };

    regions.set(id, newRegion);
    selectedRegionId = id;

    // Reset drawing state
    pointPathPoints = [];
    pointPathClosed = false;
    proposedTriangleIds.clear();

    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
    return id;
  },

  setActiveBrushPipeline(pipeline: CustomSupportOperation[] | null) {
    activeBrushPipeline = pipeline;
    updateSnapshot();
    notify();
  },

  addPlacementScript(script: SupportPlacementScript) {
    const newScript = {
      ...script,
      isBuiltIn: false,
    };
    placementScripts.set(script.id, newScript);
    savePlacementScriptsToLocalStorage();
    savePlacementScriptToFile(newScript);
    updateSnapshot();
    notify();
  },

  deletePlacementScript(id: string) {
    if (placementScripts.get(id)?.isBuiltIn) return;
    placementScripts.delete(id);
    if (activePlacementScriptId === id) {
      activePlacementScriptId = null;
    }
    savePlacementScriptsToLocalStorage();
    deletePlacementScriptFile(id);
    updateSnapshot();
    notify();
  },

  updatePlacementScript(id: string, updates: Partial<SupportPlacementScript>) {
    const existing = placementScripts.get(id);
    if (!existing || existing.isBuiltIn) return;
    const updated = {
      ...existing,
      ...updates,
      isBuiltIn: false,
    };
    placementScripts.set(id, updated);
    savePlacementScriptsToLocalStorage();
    savePlacementScriptToFile(updated);
    updateSnapshot();
    notify();
  },

  setActivePlacementScriptId(id: string | null) {
    activePlacementScriptId = id;
    updateSnapshot();
    notify();
  },

  getDefaultScriptIdForBrush(brush: BrushType, pathMode?: 'line' | 'polygon', customBrushId?: string | null): string {
    return _getDefaultScriptIdForBrush(brush, pathMode, customBrushId);
  },

  assignBrushDefault(brush: BrushType, scriptId: string, currentOperations?: CustomSupportOperation[]) {
    const key = activeCustomBrushId ? activeCustomBrushId : (brush === 'PointPath' ? `PointPath-${pointPathMode}` : brush);
    let finalScriptId = scriptId;
    if (scriptId === 'unsaved' && currentOperations) {
      const newId = `custom-default-${brush.toLowerCase()}-${Date.now()}`;
      const brushLabel = activeCustomBrushId
        ? (customBrushes.get(activeCustomBrushId)?.name || 'Custom Brush')
        : (brush === 'PointPath' ? `PointPath (${pointPathMode})` : brush);
      const newScript: SupportPlacementScript = {
        id: newId,
        name: `Default Override - ${brushLabel}`,
        operations: JSON.parse(JSON.stringify(currentOperations)),
        isBuiltIn: false,
      };
      this.addPlacementScript(newScript);
      finalScriptId = newId;
    }
    brushDefaultScripts.set(key, finalScriptId);
    saveBrushDefaultsToLocalStorage();

    activePlacementScriptId = finalScriptId;
    const script = placementScripts.get(finalScriptId);
    if (script) {
      activeBrushPipeline = JSON.parse(JSON.stringify(script.operations));
    }
    updateSnapshot();
    notify();
  },

  resetBrushDefault(brush: BrushType) {
    const keys = activeCustomBrushId
      ? [activeCustomBrushId]
      : (brush === 'PointPath' ? ['PointPath-line', 'PointPath-polygon'] : [brush]);
    for (const k of keys) {
      brushDefaultScripts.delete(k);
    }
    saveBrushDefaultsToLocalStorage();

    const defaultId = _getDefaultScriptIdForBrush(brush, brush === 'PointPath' ? pointPathMode : undefined, activeCustomBrushId);
    activePlacementScriptId = defaultId;
    const script = placementScripts.get(defaultId);
    if (script) {
      activeBrushPipeline = JSON.parse(JSON.stringify(script.operations));
    } else {
      activeBrushPipeline = null;
    }
    updateSnapshot();
    notify();
  },

  updateRegionCustomBrush(regionId: string, operations: CustomSupportOperation[], placementScriptId?: string | null) {
    const region = regions.get(regionId);
    if (!region) return;

    const baseTemplate = region.customBrush ?? {
      id: `temp-pipeline-${Date.now()}`,
      name: `Custom ROI Config`,
      color: region.color,
      baseBrush: region.brushType,
      selection: {
        normalConeAngleMinDeg: 0,
        normalConeAngleMaxDeg: 90,
        overhangSlopeMinDeg: 0,
        overhangSlopeMaxDeg: 90,
        curvatureMin: 0,
        curvatureMax: 1,
        dihedralAngleToleranceDeg: 0,
      },
      operations: [],
    };

    region.customBrush = {
      ...baseTemplate,
      operations: [...operations],
    };

    if (placementScriptId !== undefined) {
      region.placementScriptId = placementScriptId;
    }

    if (activeModelId) {
      regionsByModel.set(activeModelId, regions);
    }
    
    updateSnapshot();
    notify();
  },

  exportConfigPack(): string {
    const customScripts = Array.from(placementScripts.values()).filter(s => !s.isBuiltIn);
    const customPresets = getPresetList().filter((p: any) => !p.isBuiltIn);
    
    const pack = {
      kind: 'dragonfruit-config-pack',
      version: 1,
      exportedAt: Date.now(),
      placementScripts: customScripts,
      supportPresets: customPresets,
    };
    return JSON.stringify(pack, null, 2);
  },

  importConfigPack(packContent: string): { success: boolean; error?: string } {
    try {
      const pack = JSON.parse(packContent);
      if (pack.kind !== 'dragonfruit-config-pack') {
        return { success: false, error: 'Invalid configuration pack format.' };
      }
      
      const dummyExt: VoxlROIExtension = {
        kind: 'support-painter-rois',
        version: 4,
        modelId: 'config-pack-dummy',
        regions: [],
        customPlacementScripts: pack.placementScripts || [],
        customSupportPresets: pack.supportPresets || [],
      };
      
      // Suspend and check conflicts using existing loadFromVoxl
      this.loadFromVoxl(dummyExt);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to parse configuration pack.' };
    }
  },

  setFailedCandidates(candidates: FailedPlacementCandidate[]) {
    failedCandidates = candidates;
    activeFailureIndex = candidates.length > 0 ? 0 : null;
    updateSnapshot();
    notify();
  },

  setActiveFailureIndex(index: number | null) {
    activeFailureIndex = index;
    updateSnapshot();
    notify();
  },

  clearFailedCandidates() {
    failedCandidates = [];
    activeFailureIndex = null;
    updateSnapshot();
    notify();
  },

  goToNextFailure() {
    if (failedCandidates.length === 0) return;
    if (activeFailureIndex === null) {
      activeFailureIndex = 0;
    } else {
      activeFailureIndex = (activeFailureIndex + 1) % failedCandidates.length;
    }
    updateSnapshot();
    notify();
  },

  goToPrevFailure() {
    if (failedCandidates.length === 0) return;
    if (activeFailureIndex === null) {
      activeFailureIndex = failedCandidates.length - 1;
    } else {
      activeFailureIndex = (activeFailureIndex - 1 + failedCandidates.length) % failedCandidates.length;
    }
    updateSnapshot();
    notify();
  },
};

export function useSupportPainterState(): SupportPainterState {
  return useSyncExternalStore(
    supportPainterStore.subscribe,
    supportPainterStore.getSnapshot,
    supportPainterStore.getSnapshot
  );
}

// React import added safely
import { useSyncExternalStore } from 'react';

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
  BRUSH_COLORS,
} from './supportPainterTypes';
import { type ClientAdjacencyMap } from './useClientAdjacencyMap';
import { deserializeROIsFromVoxl } from './voxlCodec';
import { getSnapshot as getSupportSnapshot, setSnapshot as setSupportSnapshot } from '@/supports/state';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_EDIT_REPLACE } from '@/supports/history/actionTypes';

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
let proposedTriangleIds = new Set<number>();
let directGenEnabled = false;
let selectedRegionId: string | null = null;
let clientAdjacencyMap: ClientAdjacencyMap | null = null;

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
};

let suppressionSettings: SuppressionSettings = { ...DEFAULT_SUPPRESSION_SETTINGS };
let toast: SupportPainterToast | null = null;
let toastTimeout: NodeJS.Timeout | null = null;

// ─── Granular Storage / Tracking Mode State ───
let roiTrackingMode: 'none' | 'session' | 'voxl' = 'voxl'; // Default persistent mode

// ─── Version 3 Custom Support Brushes State ───
let customBrushes = new Map<string, CustomBrushTemplate>();
let activeCustomBrushId: string | null = null;

// ─── Version 4 Manual Geodesic Brushes State ───
let brushRadiusMm = 4.0;

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
          customBrushes.set(brush.id, brush);
        }
      }
    }
  } catch (err) {
    console.error('[SupportPainterStore] Failed to restore custom brushes', err);
  }
}

// Initial invocation on module load
loadCustomBrushesFromLocalStorage();

let storeSnapshot: SupportPainterState = {
  isActive,
  activeBrush,
  interactionPhase,
  modifierKeys,
  regions,
  triangleColorMap,
  hoveredTriangleId,
  proposedTriangleIds,
  directGenEnabled,
  perimeterSpacingOverride,
  infillSpacingOverride,
  suppressionSettings: { ...suppressionSettings },
  toast: null,
  roiTrackingMode,
  selectedRegionId,
  customBrushes: new Map(customBrushes),
  activeCustomBrushId,
  brushRadiusMm,
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
    triangleColorMap: new Map(triangleColorMap),
    hoveredTriangleId,
    proposedTriangleIds: new Set(proposedTriangleIds),
    directGenEnabled,
    perimeterSpacingOverride,
    infillSpacingOverride,
    suppressionSettings: { ...suppressionSettings },
    toast: toast ? { ...toast } : null,
    roiTrackingMode,
    selectedRegionId,
    customBrushes: new Map(customBrushes),
    activeCustomBrushId,
    brushRadiusMm,
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return [r, g, b];
}

function _recomputeTriangleColorMap(): TriangleColorMap {
  const map: TriangleColorMap = new Map();
  // 1. Committed regions
  for (const region of regions.values()) {
    const rgb = hexToRgb(region.color);
    const alpha = region.id === selectedRegionId ? 200 : 255;
    for (const triId of region.triangleIds) {
      map.set(triId, [rgb[0], rgb[1], rgb[2], alpha]);
    }
  }
  // 2. Proposed/hover preview
  const activeColor = BRUSH_COLORS[activeBrush];
  const rgbActive = hexToRgb(activeColor);
  for (const triId of proposedTriangleIds) {
    map.set(triId, [rgbActive[0], rgbActive[1], rgbActive[2], 128]);
  }
  return map;
}

export const supportPainterStore = {
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
  },

  setActiveBrush(brush: BrushType) {
    if (activeBrush === brush) return;
    activeBrush = brush;
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

  setHoveredTriangle(id: number | null) {
    if (hoveredTriangleId === id) return;
    hoveredTriangleId = id;
    proposedTriangleIds.clear();
    if (id !== null) {
      proposedTriangleIds.add(id);
    }
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
  },

  setProposedTriangleIds(ids: number[] | Set<number>) {
    proposedTriangleIds = new Set(ids);
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
    const id = crypto.randomUUID?.() || Math.random().toString(36).substring(2);
    const triangleIds = proposedTriangleIds.size > 0
      ? new Set(proposedTriangleIds)
      : new Set([payload.seedTriangleId]);

    const activeCustomBrush = activeCustomBrushId ? customBrushes.get(activeCustomBrushId) : undefined;
    const color = activeCustomBrush ? activeCustomBrush.color : BRUSH_COLORS[payload.brushType];

    const newRegion: ROIRegion = {
      id,
      brushType: payload.brushType,
      seedTriangleId: payload.seedTriangleId,
      triangleIds,
      color,
      proposedOnly: false,
      createdAt: Date.now(),
      customBrush: activeCustomBrush ? { ...activeCustomBrush } : undefined,
    };
    regions.set(id, newRegion);
    proposedTriangleIds.clear();
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
    return id;
  },

  removeRegion(regionId: string) {
    if (!regions.has(regionId)) return;
    regions.delete(regionId);
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
    const loadedRegions = deserializeROIsFromVoxl(ext);
    for (const [mId, mRegions] of loadedRegions.entries()) {
      regionsByModel.set(mId, mRegions);
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

  getAllRegionsByModel(): Map<string, Map<string, ROIRegion>> {
    return new Map(regionsByModel);
  },

  clearAll() {
    if (regions.size === 0) return;
    regions.clear();
    proposedTriangleIds.clear();
    hoveredTriangleId = null;
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
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
  },

  setSelectedRegionId(id: string | null) {
    if (selectedRegionId === id) return;
    selectedRegionId = id;
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

  booleanOperate(type: 'union' | 'subtract' | 'intersect', roiIdA: string, roiIdB: string) {
    const rA = regions.get(roiIdA);
    const rB = regions.get(roiIdB);
    if (!rA || !rB) return;

    // Capture states before operation for history transaction
    const beforeState = new Map(regions);
    const beforeSupport = getSupportSnapshot();

    const nextRegions = new Map(regions);
    const nextRA = { ...rA };

    if (type === 'union') {
      nextRA.triangleIds = new Set([...rA.triangleIds, ...rB.triangleIds]);
      nextRegions.set(roiIdA, nextRA);
      nextRegions.delete(roiIdB);
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

    const triangleIds = region.triangleIds;
    const seed = region.seedTriangleId;

    let mainComponent = new Set<number>();

    if (triangleIds.has(seed)) {
      const queue: number[] = [seed];
      mainComponent.add(seed);

      while (queue.length > 0) {
        const curr = queue.shift()!;
        const adjs = clientAdjacencyMap.faceToFaces[curr] || [];
        for (const adj of adjs) {
          if (triangleIds.has(adj) && !mainComponent.has(adj)) {
            mainComponent.add(adj);
            queue.push(adj);
          }
        }
      }
    } else {
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
      mainComponent = largestComponent;
    }

    if (mainComponent.size < triangleIds.size) {
      console.log(`[SupportPainterStore] Pruning ${triangleIds.size - mainComponent.size} isolated triangles.`);
      const nextRegion = { ...region, triangleIds: mainComponent };
      regions.set(regionId, nextRegion);
      triangleColorMap = _recomputeTriangleColorMap();
      updateSnapshot();
      notify();
    }
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

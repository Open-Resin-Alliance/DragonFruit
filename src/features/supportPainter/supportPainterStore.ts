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
  BRUSH_COLORS,
} from './supportPainterTypes';
import { type ClientAdjacencyMap } from './useClientAdjacencyMap';

const listeners = new Set<() => void>();

let isActive = false;
let activeBrush: BrushType = 'MacroFace';
let interactionPhase: BrushInteractionPhase = 'Idle';
let modifierKeys: BrushModifierKeys = { alt: false, shift: false };
let regions = new Map<string, ROIRegion>();
let triangleColorMap: TriangleColorMap = new Map();
let hoveredTriangleId: number | null = null;
let proposedTriangleIds = new Set<number>();
let directGenEnabled = false;
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
    for (const triId of region.triangleIds) {
      map.set(triId, [rgb[0], rgb[1], rgb[2], 255]);
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

    const newRegion: ROIRegion = {
      id,
      brushType: payload.brushType,
      seedTriangleId: payload.seedTriangleId,
      triangleIds,
      color: BRUSH_COLORS[payload.brushType],
      proposedOnly: false,
      createdAt: Date.now(),
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

  restoreRegions(nextRegions: Map<string, ROIRegion>) {
    regions = new Map(nextRegions);
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
  },

  loadFromVoxl(ext: VoxlROIExtension) {
    regions.clear();
    for (const r of ext.regions) {
      regions.set(r.id, {
        id: r.id,
        brushType: r.brushType,
        seedTriangleId: r.seedTriangleId,
        triangleIds: new Set(r.triangleIds),
        color: r.color,
        proposedOnly: false,
        createdAt: r.createdAt,
      });
    }
    triangleColorMap = _recomputeTriangleColorMap();
    updateSnapshot();
    notify();
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

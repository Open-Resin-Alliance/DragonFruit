import { SupportCollection, SupportInstance, SupportSettings, createDefaultSupportSettings } from './types';
import { SupportHistoryAction } from './historyTypes';

// In-memory normalized store. Later we can lift this into Zustand/Context, but the API here
// should already reflect a normalized collection (byId/allIds) with helper selectors.
let supports: SupportCollection = {
  byId: {},
  allIds: [],
};

let cachedSupportList: SupportInstance[] = [];

function rebuildSupportListCache() {
  cachedSupportList = supports.allIds.map((id) => supports.byId[id]).filter(Boolean) as SupportInstance[];
}

// Use the single source of truth from types.ts
let currentSettings: SupportSettings = createDefaultSupportSettings();

let nextId = 1;

type StoreListener = () => void;
const listeners = new Set<StoreListener>();

let undoStack: SupportHistoryAction[] = [];
let redoStack: SupportHistoryAction[] = [];
let historyMuted = false;

type HistoryListener = () => void;
const historyListeners = new Set<HistoryListener>();

function notify() {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (err) {
      console.error('[SupportStore] listener error', err);
    }
  });
}

function notifyHistory() {
  historyListeners.forEach((listener) => {
    try {
      listener();
    } catch (err) {
      console.error('[SupportHistory] listener error', err);
    }
  });
}

function snapshotSupport(instance: SupportInstance): SupportInstance {
  return JSON.parse(JSON.stringify(instance));
}

function pushUndo(action: SupportHistoryAction) {
  if (historyMuted) return;
  undoStack.push(action);
  redoStack = [];
  notifyHistory();
}

function withHistoryMuted<T>(fn: () => T): T {
  historyMuted = true;
  try {
    return fn();
  } finally {
    historyMuted = false;
  }
}

function storeAdd(instance: SupportInstance): SupportInstance {
  const snapshot = snapshotSupport(instance);
  supports.byId[snapshot.id] = snapshot;
  if (!supports.allIds.includes(snapshot.id)) {
    supports.allIds.push(snapshot.id);
  }
  rebuildSupportListCache();
  notify();
  return snapshot;
}

function storeRemove(id: string): SupportInstance | null {
  const existing = supports.byId[id];
  if (!existing) return null;
  const snapshot = snapshotSupport(existing);
  delete supports.byId[id];
  supports.allIds = supports.allIds.filter((existingId) => existingId !== id);
  rebuildSupportListCache();
  notify();
  return snapshot;
}

function storeUpdate(instance: SupportInstance): { previous: SupportInstance; updated: SupportInstance } | null {
  const existing = supports.byId[instance.id];
  if (!existing) return null;
  const previous = snapshotSupport(existing);
  const updated = snapshotSupport(instance);
  supports.byId[instance.id] = updated;
  rebuildSupportListCache();
  notify();
  return { previous, updated };
}

export function generateSupportId(): string {
  const id = `s${nextId}`;
  nextId += 1;
  return id;
}

export function subscribeToSupportStore(listener: StoreListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSupportCollection(): SupportCollection {
  return supports;
}

export function getSupportList(): SupportInstance[] {
  return cachedSupportList;
}

export function setSupportCollection(newCollection: SupportCollection): void {
  supports = {
    byId: { ...newCollection.byId },
    allIds: [...newCollection.allIds],
  };
  rebuildSupportListCache();
  notify();
}

export function getSupportById(id: string): SupportInstance | undefined {
  return supports.byId[id];
}

export function getCurrentSupportSettings(): SupportSettings {
  return currentSettings;
}

export function setCurrentSupportSettings(settings: SupportSettings): void {
  currentSettings = settings;
  notify();
}

/**
 * Updates the baseFlare settings on all existing supports.
 * This allows toggling the base flare feature globally.
 */
export function updateAllSupportsBaseFlare(baseFlare: { enabled: boolean; diameterMm: number; heightMm: number }): void {
  const updatedSupports: SupportInstance[] = [];

  supports.allIds.forEach((id) => {
    const support = supports.byId[id];
    if (support) {
      const updated = {
        ...support,
        settings: {
          ...support.settings,
          baseFlare: { ...baseFlare },
        },
        updatedAt: Date.now(),
      };
      supports.byId[id] = updated;
      updatedSupports.push(updated);
    }
  });

  rebuildSupportListCache();
  notify();
  console.log('[SupportStore] Updated baseFlare on', updatedSupports.length, 'supports');
}

export function addSupport(instance: SupportInstance): void {
  const snapshot = storeAdd(instance);
  pushUndo({ type: 'add', instance: snapshot });
}

export function updateSupport(instance: SupportInstance): void {
  const result = storeUpdate(instance);
  if (!result) return;
  pushUndo({ type: 'update', previous: result.previous, instance: result.updated });
}

export function removeSupport(id: string): void {
  const removed = storeRemove(id);
  if (!removed) return;
  pushUndo({ type: 'remove', instance: removed });
}

/**
 * Adds a new joint to a support at the specified position.
 * Joints are automatically sorted by their Z position along the shaft.
 */
export function addJointToSupport(
  supportId: string,
  position: { x: number; y: number; z: number }
): void {
  const support = supports.byId[supportId];
  if (!support) {
    console.warn('[SupportStore] Support not found:', supportId);
    return;
  }

  // Create new joint
  const shaftDiameter = support.settings.mid.diameterMm;
  const jointDiameter = shaftDiameter + 0.1;
  const existingJoints = support.joints || [];

  const newJoint = {
    id: `${supportId}-joint-${existingJoints.length}-${Date.now()}`,
    position,
    ballDiameterMm: jointDiameter,
    order: existingJoints.length,
    updatedAt: Date.now(),
  };

  // Add joint and keep designated tip joint first; sort others by distance from current tipEnd
  const merged = [...existingJoints, newJoint];
  const tipIdx0 = merged.findIndex((j: any) => j.isTipJoint === true);
  const tipJoint0 = tipIdx0 >= 0 ? merged[tipIdx0] : null;
  const tipLen0 = support.settings.tip.lengthMm;
  const tipDir0 = { x: support.tipNormal.x, y: support.tipNormal.y, z: support.tipNormal.z };
  const tipEnd0 = { x: support.tip.x + tipDir0.x * tipLen0, y: support.tip.y + tipDir0.y * tipLen0, z: support.tip.z + tipDir0.z * tipLen0 };
  const dist0 = (p: { x: number; y: number; z: number }) => {
    const dx = p.x - tipEnd0.x, dy = p.y - tipEnd0.y, dz = p.z - tipEnd0.z; return Math.hypot(dx, dy, dz);
  };
  const others0 = merged.filter((_, i) => i !== tipIdx0).sort((a, b) => dist0(a.position) - dist0(b.position));
  const updatedJoints = tipJoint0 ? [tipJoint0, ...others0] : others0;
  updatedJoints.forEach((j: any, i) => { j.order = i; });

  // Update support
  const updatedSupport = {
    ...support,
    joints: updatedJoints,
  };

  updateSupport(updatedSupport);
  console.log(`[SupportStore] Added joint to support ${supportId}, total joints: ${updatedJoints.length}`);
}

/**
 * Update the position of an existing joint on a support.
 * Triggers an update with undo history.
 */
export function updateJointPosition(
  supportId: string,
  jointId: string,
  position: { x: number; y: number; z: number }
): void {
  const support = supports.byId[supportId];
  if (!support || !support.joints) return;

  const idx = support.joints.findIndex((j) => j.id === jointId);
  if (idx === -1) return;

  const tipIdx = support.joints.findIndex((j: any) => j.isTipJoint === true);
  const movingTip = tipIdx !== -1 && idx === tipIdx;
  
  // Check if this is a leaf support (type 2 or has 'leaf' tag)
  const isLeaf = support.type === 2 || support.tags?.includes('leaf');
  const movedJoint = support.joints[idx] as any;
  const isLeafJoint = movedJoint.type === 'leaf';

  // Update the moved joint position first
  let nextJoints = support.joints.map((j, i) => (i === idx ? { ...j, position: { ...position }, updatedAt: Date.now() } : j));

  let nextSettings = support.settings;
  let nextTipNormal = support.tipNormal;
  let nextBase = support.base;

  // LEAF SUPPORT: Update base position when leaf joint moves
  if (isLeaf && isLeafJoint) {
    // For leaf supports, the base is the socket point (where the joint is)
    // When the joint moves, update the base to match
    nextBase = { ...position };
    console.log('[updateJointPosition] Leaf joint moved, updating base to:', nextBase);
  } else if (movingTip) {
    // Recompute tip orientation and length from tip to new joint pos
    const dirX = position.x - support.tip.x;
    const dirY = position.y - support.tip.y;
    const dirZ = position.z - support.tip.z;
    const newLen = Math.hypot(dirX, dirY, dirZ) || support.settings.tip.lengthMm;
    const newNormal = { x: dirX / (newLen || 1), y: dirY / (newLen || 1), z: dirZ / (newLen || 1) };
    nextSettings = { ...support.settings, tip: { ...support.settings.tip, lengthMm: newLen } } as any;
    nextTipNormal = newNormal;
    const tipEnd = { x: support.tip.x + newNormal.x * newLen, y: support.tip.y + newNormal.y * newLen, z: support.tip.z + newNormal.z * newLen };
    nextJoints = nextJoints.map((j, i) => (i === tipIdx ? { ...j, position: tipEnd } : j));
  }

  // Keep tip joint first; sort other joints by distance from current/new tipEnd
  const tipLen = nextSettings.tip.lengthMm;
  const tipDir = { x: nextTipNormal.x, y: nextTipNormal.y, z: nextTipNormal.z };
  const tipEnd = { x: support.tip.x + tipDir.x * tipLen, y: support.tip.y + tipDir.y * tipLen, z: support.tip.z + tipDir.z * tipLen };
  const dist = (p: { x: number; y: number; z: number }) => { const dx = p.x - tipEnd.x, dy = p.y - tipEnd.y, dz = p.z - tipEnd.z; return Math.hypot(dx, dy, dz); };
  const tipIdx2 = nextJoints.findIndex((j: any) => j.isTipJoint === true);
  const tipJoint2 = tipIdx2 >= 0 ? nextJoints[tipIdx2] : null;
  const others2 = nextJoints.filter((_, i) => i !== tipIdx2).sort((a, b) => dist(a.position) - dist(b.position));
  nextJoints = tipJoint2 ? [tipJoint2, ...others2] : others2;
  (nextJoints as any[]).forEach((j: any, i: number) => { j.order = i; });

  const updatedSupport: SupportInstance = { ...support, settings: nextSettings, tipNormal: nextTipNormal, base: nextBase, joints: nextJoints };
  updateSupport(updatedSupport);
}

/**
 * Live joint move without pushing history. Use during gizmo drag.
 * Call updateJointPosition at the end to record a single undo entry.
 */
export function updateJointPositionLive(
  supportId: string,
  jointId: string,
  position: { x: number; y: number; z: number }
): void {
  const support = supports.byId[supportId];
  if (!support || !support.joints) return;

  const idx = support.joints.findIndex((j) => j.id === jointId);
  if (idx === -1) return;

  const tipIdx = support.joints.findIndex((j: any) => j.isTipJoint === true);
  const movingTip = tipIdx !== -1 && idx === tipIdx;
  
  // Check if this is a leaf support
  const isLeaf = support.type === 2 || support.tags?.includes('leaf');
  const movedJoint = support.joints[idx] as any;
  const isLeafJoint = movedJoint.type === 'leaf';

  let nextJoints = support.joints.map((j, i) => (i === idx ? { ...j, position: { ...position } } : j));
  let nextSettings = support.settings;
  let nextTipNormal = support.tipNormal;
  let nextBase = support.base;

  // LEAF SUPPORT: Update base position when leaf joint moves (live)
  if (isLeaf && isLeafJoint) {
    nextBase = { ...position };
  } else if (movingTip) {
    const dirX = position.x - support.tip.x;
    const dirY = position.y - support.tip.y;
    const dirZ = position.z - support.tip.z;
    const newLen = Math.hypot(dirX, dirY, dirZ) || support.settings.tip.lengthMm;
    const newNormal = { x: dirX / (newLen || 1), y: dirY / (newLen || 1), z: dirZ / (newLen || 1) };
    nextSettings = { ...support.settings, tip: { ...support.settings.tip, lengthMm: newLen } } as any;
    nextTipNormal = newNormal;
    const tipEnd = { x: support.tip.x + newNormal.x * newLen, y: support.tip.y + newNormal.y * newLen, z: support.tip.z + newNormal.z * newLen };
    nextJoints = nextJoints.map((j, i) => (i === tipIdx ? { ...j, position: tipEnd } : j));
  }

  const tipLen = nextSettings.tip.lengthMm;
  const tipDir = { x: nextTipNormal.x, y: nextTipNormal.y, z: nextTipNormal.z };
  const tipEnd = { x: support.tip.x + tipDir.x * tipLen, y: support.tip.y + tipDir.y * tipLen, z: support.tip.z + tipDir.z * tipLen };
  const dist = (p: { x: number; y: number; z: number }) => { const dx = p.x - tipEnd.x, dy = p.y - tipEnd.y, dz = p.z - tipEnd.z; return Math.hypot(dx, dy, dz); };
  const tipIdx2 = nextJoints.findIndex((j: any) => j.isTipJoint === true);
  const tipJoint2 = tipIdx2 >= 0 ? nextJoints[tipIdx2] : null;
  const others2 = nextJoints.filter((_, i) => i !== tipIdx2).sort((a, b) => dist(a.position) - dist(b.position));
  nextJoints = tipJoint2 ? [tipJoint2, ...others2] : others2;
  (nextJoints as any[]).forEach((j: any, i: number) => { j.order = i; });

  const updatedSupport: SupportInstance = { ...support, settings: nextSettings, tipNormal: nextTipNormal, base: nextBase, joints: nextJoints };
  withHistoryMuted(() => updateSupport(updatedSupport));
}

export function clearSupports(): void {
  supports = { byId: {}, allIds: [] };
  nextId = 1;
  rebuildSupportListCache();
  notify();
}

export function undoSupportAction(): void {
  const action = undoStack.pop();
  if (!action) return;
  withHistoryMuted(() => {
    switch (action.type) {
      case 'add':
        if (supports.byId[action.instance.id]) {
          storeRemove(action.instance.id);
        }
        break;
      case 'remove':
        storeAdd(action.instance);
        break;
      case 'update':
        storeUpdate(action.previous);
        break;
    }
  });
  redoStack.push(action);
  notifyHistory();
}

export function redoSupportAction(): void {
  const action = redoStack.pop();
  if (!action) return;
  withHistoryMuted(() => {
    switch (action.type) {
      case 'add':
        storeAdd(action.instance);
        break;
      case 'remove':
        storeRemove(action.instance.id);
        break;
      case 'update':
        storeUpdate(action.instance);
        break;
    }
  });
  undoStack.push(action);
  notifyHistory();
}

export function subscribeSupportHistory(listener: HistoryListener): () => void {
  historyListeners.add(listener);
  return () => {
    historyListeners.delete(listener);
  };
}

// Serialization functions for save/load
export interface SerializedSupports {
  version: number;
  supports: SupportCollection;
  nextId: number;
  currentSettings: SupportSettings;
}

export function serializeSupports(): SerializedSupports {
  return {
    version: 1,
    supports: {
      byId: { ...supports.byId },
      allIds: [...supports.allIds],
    },
    nextId,
    currentSettings: JSON.parse(JSON.stringify(currentSettings)),
  };
}

export function deserializeSupports(data: SerializedSupports): void {
  if (data.version !== 1) {
    console.warn('[SupportStore] Unknown serialization version:', data.version);
    return;
  }

  withHistoryMuted(() => {
    supports = {
      byId: { ...data.supports.byId },
      allIds: [...data.supports.allIds],
    };
    nextId = data.nextId || 1;
    currentSettings = data.currentSettings;
    rebuildSupportListCache();
    notify();
  });

  // Clear undo/redo stacks on load
  undoStack = [];
  redoStack = [];
  notifyHistory();
}

export function saveSupportsToLocalStorage(key: string = 'supports'): void {
  try {
    const serialized = serializeSupports();
    localStorage.setItem(key, JSON.stringify(serialized));
    console.log('[SupportStore] Saved to localStorage:', key);
  } catch (err) {
    console.error('[SupportStore] Failed to save to localStorage:', err);
  }
}

export function loadSupportsFromLocalStorage(key: string = 'supports'): boolean {
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return false;
    const data = JSON.parse(stored) as SerializedSupports;
    deserializeSupports(data);
    console.log('[SupportStore] Loaded from localStorage:', key);
    return true;
  } catch (err) {
    console.error('[SupportStore] Failed to load from localStorage:', err);
    return false;
  }
}

// Subscription
export function subscribeToStore(listener: StoreListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Export to JSON file
export function exportSupportsToFile(): void {
  try {
    const data = serializeSupports();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `supports-${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    console.log('[SupportStore] Exported to file');
  } catch (err) {
    console.error('[SupportStore] Failed to export:', err);
  }
}

// Import from JSON file
export function importSupportsFromFile(file: File): Promise<boolean> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = e.target?.result as string;
        const data = JSON.parse(json) as SerializedSupports;
        deserializeSupports(data);
        console.log('[SupportStore] Imported from file');
        resolve(true);
      } catch (err) {
        console.error('[SupportStore] Failed to import:', err);
        resolve(false);
      }
    };
    reader.onerror = () => {
      console.error('[SupportStore] Failed to read file');
      resolve(false);
    };
    reader.readAsText(file);
  });
}

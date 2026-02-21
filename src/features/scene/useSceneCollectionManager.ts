import { useState, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loadStlGeometry, processGeometry, type GeometryWithBounds } from '@/hooks/useStlGeometry';
import { clearPaintToBase } from '@/components/analysis/MeshPainter';
import { loadFromLychee } from '@/supports/state';
import { getSettings } from '@/supports/Settings/state';
import type { SelectionHighlightMode } from '@/components/selection';
import { registerDeleteHandler } from '@/features/delete/deleteRegistry';
import { pushHistory, registerHistoryHandler } from '@/history/historyStore';
import type { HistoryAction, HistoryDirection } from '@/history/types';
import type { ModelTransform } from '@/hooks/useModelTransform';
import type { SupportMode } from '@/supports/types';
import { useLycheeImport, type LycheeImportResult } from '@/components/lys-import/useLycheeImport';
import { useLysImport } from '@/components/lys-import/useLysImport';
import { accelerateGeometry } from '@/utils/bvh';
import type { MatcapVariant, MeshShaderType } from '@/features/shaders/mesh';
import {
  DEFAULT_VIEW3D_SETTINGS,
  getSavedView3DSettings,
  normalizeView3DSettings,
  saveView3DSettings,
  type View3DSettings,
} from '@/components/settings/view3dPreferences';
import {
  getActivePrinterProfile,
  getProfileStoreSnapshot,
  getProfileStoreServerSnapshot,
  subscribeToProfileStore,
} from '@/features/profiles/profileStore';

type PersistedMeshAppearance = {
  v: 1;
  shaderType: MeshShaderType;
  matcapVariant: MatcapVariant;
  flatUseVertexColors: boolean;
  toonSteps: number;
  ambientIntensity: number;
  directionalIntensity: number;
  materialRoughness: number;
  wireframeThicknessPx: number;
  xrayOpacity: number;
  meshColor: string;
  hoverTintStrength: number;
  selectedTintStrength: number;
};

const MESH_APPEARANCE_STORAGE_KEY = 'mesh-appearance-settings';

const DEFAULT_MESH_COLOR = '#a3a3a3';
const DEFAULT_AMBIENT_INTENSITY = 0.6;
const DEFAULT_DIRECTIONAL_INTENSITY = 0.8;
const DEFAULT_MATERIAL_ROUGHNESS = 0.65;
const DEFAULT_WIREFRAME_THICKNESS_PX = 1.5;
const DEFAULT_XRAY_OPACITY = 0.25;
const DEFAULT_SHADER_TYPE: MeshShaderType = 'soft_clay';
const DEFAULT_MATCAP_VARIANT: MatcapVariant = 'neutral';
const DEFAULT_FLAT_USE_VERTEX_COLORS = true;
const DEFAULT_TOON_STEPS = 5;
const DEFAULT_HOVER_TINT_STRENGTH = 0.5;
const DEFAULT_SELECTED_TINT_STRENGTH = 0.75;
const RECENT_OPENED_FILES_STORAGE_KEY = 'app-recent-opened-files';
const RECENT_OPENED_FILES_LIMIT = 10;
const RECENT_FILES_DB_NAME = 'dragonfruit-recent-files';
const RECENT_FILES_DB_VERSION = 1;
const RECENT_FILES_STORE_NAME = 'files';
const SCENE_MODELS_SNAPSHOT_APPLY = 'scene_models_snapshot_apply';
const SCENE_HISTORY_MAX_SNAPSHOTS = 200;

type SceneSnapshotPayload = { key: string };

type SceneSnapshot = {
  models: LoadedModel[];
  activeModelId: string | null;
  selectedModelIds: string[];
};

type SceneSnapshotPair = {
  before: SceneSnapshot;
  after: SceneSnapshot;
};

const sceneSnapshotRegistry = new Map<string, SceneSnapshotPair>();
const sceneSnapshotOrder: string[] = [];

function cloneTransform(transform: ModelTransform): ModelTransform {
  return {
    position: transform.position.clone(),
    rotation: transform.rotation.clone(),
    scale: transform.scale.clone(),
  };
}

function cloneLoadedModel(model: LoadedModel): LoadedModel {
  return {
    ...model,
    transform: cloneTransform(model.transform),
  };
}

function captureSceneSnapshot(models: LoadedModel[], activeModelId: string | null, selectedModelIds: string[]): SceneSnapshot {
  return {
    models: models.map(cloneLoadedModel),
    activeModelId,
    selectedModelIds: [...selectedModelIds],
  };
}

function storeSceneSnapshotPair(pair: SceneSnapshotPair): string {
  const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  sceneSnapshotRegistry.set(key, pair);
  sceneSnapshotOrder.push(key);

  while (sceneSnapshotOrder.length > SCENE_HISTORY_MAX_SNAPSHOTS) {
    const removed = sceneSnapshotOrder.shift();
    if (removed) sceneSnapshotRegistry.delete(removed);
  }

  return key;
}

export type RecentOpenedFileKind = 'mesh' | 'scene';

export type RecentOpenedFileEntry = {
  id: string;
  name: string;
  kind: RecentOpenedFileKind;
  sizeBytes?: number;
  openedAt: number;
};

type RecentOpenedFileBlobRecord = {
  id: string;
  name: string;
  kind: RecentOpenedFileKind;
  sizeBytes?: number;
  openedAt: number;
  type: string;
  lastModified: number;
  data: ArrayBuffer;
};

function clampNumber(input: unknown, min: number, max: number, fallback: number): number {
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampHexColor(input: unknown, fallback: string): string {
  if (typeof input !== 'string') return fallback;
  const s = input.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s) || /^#[0-9a-fA-F]{3}$/.test(s)) return s;
  return fallback;
}

function clampMatcapVariant(input: unknown, fallback: MatcapVariant): MatcapVariant {
  return input === 'neutral' || input === 'cool' || input === 'warm' ? input : fallback;
}

function clampPersistedMeshShaderType(input: unknown, fallback: MeshShaderType): MeshShaderType {
  return input === 'soft_clay'
    || input === 'toon'
    || input === 'normal_debug'
    || input === 'wireframe'
    || input === 'xray'
    ? input
    : fallback;
}

function clampBoolean(input: unknown, fallback: boolean): boolean {
  return typeof input === 'boolean' ? input : fallback;
}

function clampInt(input: unknown, min: number, max: number, fallback: number): number {
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function readMeshAppearanceFromLocalStorage(): PersistedMeshAppearance | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(MESH_APPEARANCE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedMeshAppearance>;

    const shaderType = clampPersistedMeshShaderType(parsed.shaderType, DEFAULT_SHADER_TYPE);

    return {
      v: 1,
      shaderType,
      matcapVariant: clampMatcapVariant(parsed.matcapVariant, DEFAULT_MATCAP_VARIANT),
      flatUseVertexColors: clampBoolean(parsed.flatUseVertexColors, DEFAULT_FLAT_USE_VERTEX_COLORS),
      toonSteps: clampInt(parsed.toonSteps, 2, 16, DEFAULT_TOON_STEPS),
      ambientIntensity: clampNumber(parsed.ambientIntensity, 0, 4, DEFAULT_AMBIENT_INTENSITY),
      directionalIntensity: clampNumber(parsed.directionalIntensity, 0, 4, DEFAULT_DIRECTIONAL_INTENSITY),
      materialRoughness: clampNumber(parsed.materialRoughness, 0, 1, DEFAULT_MATERIAL_ROUGHNESS),
      wireframeThicknessPx: clampNumber(parsed.wireframeThicknessPx, 0.5, 6, DEFAULT_WIREFRAME_THICKNESS_PX),
      xrayOpacity: clampNumber(parsed.xrayOpacity, 0.02, 0.85, DEFAULT_XRAY_OPACITY),
      meshColor: clampHexColor(parsed.meshColor, DEFAULT_MESH_COLOR),
      hoverTintStrength: clampNumber(parsed.hoverTintStrength, 0, 1, DEFAULT_HOVER_TINT_STRENGTH),
      selectedTintStrength: clampNumber(parsed.selectedTintStrength, 0, 1, DEFAULT_SELECTED_TINT_STRENGTH),
    };
  } catch {
    return null;
  }
}

function writeMeshAppearanceToLocalStorage(next: PersistedMeshAppearance): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(MESH_APPEARANCE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

function openRecentFilesDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || typeof window.indexedDB === 'undefined') {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      const request = window.indexedDB.open(RECENT_FILES_DB_NAME, RECENT_FILES_DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(RECENT_FILES_STORE_NAME)) {
          db.createObjectStore(RECENT_FILES_STORE_NAME, { keyPath: 'id' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function putRecentOpenedFileBlob(entry: RecentOpenedFileEntry, file: File): Promise<void> {
  const db = await openRecentFilesDb();
  if (!db) return;

  try {
    const data = await file.arrayBuffer();

    const record: RecentOpenedFileBlobRecord = {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      sizeBytes: entry.sizeBytes,
      openedAt: entry.openedAt,
      type: file.type,
      lastModified: file.lastModified,
      data,
    };

    await new Promise<void>((resolve) => {
      const tx = db.transaction(RECENT_FILES_STORE_NAME, 'readwrite');
      const store = tx.objectStore(RECENT_FILES_STORE_NAME);
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // ignore
  } finally {
    db.close();
  }
}

async function deleteRecentOpenedFileBlobs(ids: string[]): Promise<void> {
  if (ids.length === 0) return;

  const db = await openRecentFilesDb();
  if (!db) return;

  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(RECENT_FILES_STORE_NAME, 'readwrite');
      const store = tx.objectStore(RECENT_FILES_STORE_NAME);
      ids.forEach((id) => store.delete(id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } finally {
    db.close();
  }
}

async function readRecentOpenedFileBlob(entry: RecentOpenedFileEntry): Promise<File | null> {
  const db = await openRecentFilesDb();
  if (!db) return null;

  try {
    return await new Promise<File | null>((resolve) => {
      const tx = db.transaction(RECENT_FILES_STORE_NAME, 'readonly');
      const store = tx.objectStore(RECENT_FILES_STORE_NAME);
      const request = store.get(entry.id);

      request.onsuccess = () => {
        const result = request.result as RecentOpenedFileBlobRecord | undefined;
        if (!result || !(result.data instanceof ArrayBuffer)) {
          resolve(null);
          return;
        }

        const blob = new Blob([result.data], { type: result.type || '' });
        resolve(new File([blob], result.name || entry.name, {
          type: result.type || '',
          lastModified: Number.isFinite(result.lastModified) ? result.lastModified : Date.now(),
        }));
      };

      request.onerror = () => resolve(null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    });
  } finally {
    db.close();
  }
}

function readRecentOpenedFilesFromLocalStorage(): RecentOpenedFileEntry[] {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(RECENT_OPENED_FILES_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((item): RecentOpenedFileEntry | null => {
        if (!item || typeof item !== 'object') return null;

        const id = typeof item.id === 'string' ? item.id.trim() : '';
        const name = typeof item.name === 'string' ? item.name : '';
        const kind = item.kind === 'mesh' || item.kind === 'scene' ? item.kind : null;
        const openedAt = Number(item.openedAt);
        const sizeBytes = typeof item.sizeBytes === 'number' && Number.isFinite(item.sizeBytes) && item.sizeBytes >= 0
          ? item.sizeBytes
          : undefined;

        if (!id || !name || !kind || !Number.isFinite(openedAt)) return null;

        return {
          id,
          name,
          kind,
          sizeBytes,
          openedAt,
        };
      })
      .filter((item): item is RecentOpenedFileEntry => item !== null)
      .slice(0, RECENT_OPENED_FILES_LIMIT);
  } catch {
    return [];
  }
}

function writeRecentOpenedFilesToLocalStorage(entries: RecentOpenedFileEntry[]): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(RECENT_OPENED_FILES_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // ignore
  }
}

function generateRecentEntryId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface LoadedModel {
  id: string;
  name: string;
  groupId?: string;
  groupName?: string;
  fileUrl: string;
  fileSizeBytes?: number;
  geometry: GeometryWithBounds;
  transform: ModelTransform;
  visible: boolean;
  color: string;
  polygonCount: number;
  ignoreAutoLift?: boolean;
}

type DebugPrimitiveType =
  | 'pillar'
  | 'merge_y'
  | 'split_y'
  | 'earlobe'
  | 'bridge'
  | 'finger_palm_arm';

type DebugPrimitiveSizePreset = 'small' | 'medium' | 'large';

import { getSnapshot } from '@/supports/state';
import { deleteSupportsForModel } from '@/supports/PlacementLogic/SupportModelLinker';
import { clearSelection } from '@/supports/interaction/SupportSelection';

type ImportProgressState = {
  active: boolean;
  type: 'mesh' | 'scene' | null;
  label: string;
  detail: string;
  progress: number | null;
};

type ModelClipboardEntry = {
  sourceId: string;
  name: string;
  fileSizeBytes?: number;
  geometry: GeometryWithBounds;
  transform: ModelTransform;
  color: string;
  polygonCount: number;
};

export function useSceneCollectionManager() {
  const waitForUiYield = useCallback(
    () => new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    }),
    [],
  );

  const [models, setModels] = useState<LoadedModel[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [modelClipboard, setModelClipboard] = useState<ModelClipboardEntry[]>([]);
  const [recentOpenedFiles, setRecentOpenedFiles] = useState<RecentOpenedFileEntry[]>([]);
  const [importProgress, setImportProgress] = useState<ImportProgressState>({
    active: false,
    type: null,
    label: '',
    detail: '',
    progress: null,
  });

  const isDebugModelName = useCallback((name: string) => name.startsWith('[Debug]'), []);
  const deferredAccelerationQueueRef = useRef<THREE.BufferGeometry[]>([]);
  const deferredAccelerationProcessingRef = useRef(false);
  const deferredAccelerationPausedRef = useRef(false);

  const tryRevokeObjectUrl = useCallback((url: string) => {
    if (!url) return;
    if (!url.startsWith('blob:')) return;
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Ignore invalid URLs
    }
  }, []);

  const getDebugPresetDims = useCallback((preset: DebugPrimitiveSizePreset) => {
    switch (preset) {
      case 'small':
        return { height: 20, radius: 2.5, span: 10 };
      case 'large':
        return { height: 60, radius: 6, span: 25 };
      case 'medium':
      default:
        return { height: 40, radius: 4, span: 16 };
    }
  }, []);

  const buildDebugGeometry = useCallback((type: DebugPrimitiveType, preset: DebugPrimitiveSizePreset): GeometryWithBounds => {
    const { height, radius, span } = getDebugPresetDims(preset);

    const parts: THREE.BufferGeometry[] = [];

    const makeCylinderZ = (r: number, h: number, radialSegments = 24) => {
      const g = new THREE.CylinderGeometry(r, r, h, radialSegments, 1, false);
      // CylinderGeometry is Y-up; rotate so height is Z-up
      g.rotateX(Math.PI / 2);
      return g;
    };

    const makeBox = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);
    const makeSphere = (r: number, segments = 24) => new THREE.SphereGeometry(r, segments, segments);

    const applyTransform = (g: THREE.BufferGeometry, position: THREE.Vector3, rotation: THREE.Euler) => {
      const m = new THREE.Matrix4().makeRotationFromEuler(rotation);
      m.setPosition(position);
      g.applyMatrix4(m);
      return g;
    };

    if (type === 'pillar') {
      parts.push(makeCylinderZ(radius, height));
    }

    if (type === 'merge_y') {
      const branchH = height * 0.7;
      const topH = height * 0.5;
      const tilt = 0.45;
      const xOff = span * 0.35;
      const mergeZ = -height * 0.05;

      parts.push(applyTransform(makeCylinderZ(radius, branchH), new THREE.Vector3(-xOff, 0, -branchH * 0.25), new THREE.Euler(0, +tilt, 0)));
      parts.push(applyTransform(makeCylinderZ(radius, branchH), new THREE.Vector3(+xOff, 0, -branchH * 0.25), new THREE.Euler(0, -tilt, 0)));
      parts.push(applyTransform(makeCylinderZ(radius, topH), new THREE.Vector3(0, 0, mergeZ + topH * 0.35), new THREE.Euler(0, 0, 0)));
    }

    if (type === 'split_y') {
      const trunkH = height * 0.6;
      const branchH = height * 0.55;
      const tilt = 0.45;
      const xOff = span * 0.35;
      const splitZ = height * 0.05;

      parts.push(applyTransform(makeCylinderZ(radius, trunkH), new THREE.Vector3(0, 0, -trunkH * 0.15), new THREE.Euler(0, 0, 0)));
      parts.push(applyTransform(makeCylinderZ(radius, branchH), new THREE.Vector3(-xOff, 0, splitZ + branchH * 0.15), new THREE.Euler(0, -tilt, 0)));
      parts.push(applyTransform(makeCylinderZ(radius, branchH), new THREE.Vector3(+xOff, 0, splitZ + branchH * 0.15), new THREE.Euler(0, +tilt, 0)));
    }

    if (type === 'earlobe') {
      const massR = radius * 2.0;
      const nubR = radius * 0.8;
      parts.push(applyTransform(makeSphere(massR), new THREE.Vector3(0, 0, 0), new THREE.Euler(0, 0, 0)));
      parts.push(applyTransform(makeSphere(nubR), new THREE.Vector3(span * 0.55, 0, -height * 0.1), new THREE.Euler(0, 0, 0)));
      parts.push(applyTransform(makeCylinderZ(radius * 1.2, height * 0.6), new THREE.Vector3(0, 0, -height * 0.55), new THREE.Euler(0, 0, 0)));
    }

    if (type === 'bridge') {
      const block = span * 0.6;
      const blockH = height * 0.5;
      const gap = span * 0.2;
      const bridgeW = gap + radius * 1.2;
      const bridgeT = radius * 0.5;
      parts.push(applyTransform(makeBox(block, block, blockH), new THREE.Vector3(-(block + gap) * 0.5, 0, 0), new THREE.Euler(0, 0, 0)));
      parts.push(applyTransform(makeBox(block, block, blockH), new THREE.Vector3(+(block + gap) * 0.5, 0, 0), new THREE.Euler(0, 0, 0)));
      parts.push(applyTransform(makeBox(bridgeW, bridgeT, bridgeT), new THREE.Vector3(0, 0, 0), new THREE.Euler(0, 0, 0)));
    }

    if (type === 'finger_palm_arm') {
      const fingerR = radius * 0.7;
      const palmW = span * 0.9;
      const palmT = radius * 2;
      const armR = radius * 1.2;

      parts.push(applyTransform(makeCylinderZ(fingerR, height * 0.6), new THREE.Vector3(-span * 0.35, 0, -height * 0.25), new THREE.Euler(0, 0, 0)));
      parts.push(applyTransform(makeCylinderZ(fingerR, height * 0.6), new THREE.Vector3(0, 0, -height * 0.25), new THREE.Euler(0, 0, 0)));
      parts.push(applyTransform(makeCylinderZ(fingerR, height * 0.6), new THREE.Vector3(+span * 0.35, 0, -height * 0.25), new THREE.Euler(0, 0, 0)));
      parts.push(applyTransform(makeBox(palmW, palmW * 0.5, palmT), new THREE.Vector3(0, 0, height * 0.05), new THREE.Euler(0, 0, 0)));
      parts.push(applyTransform(makeCylinderZ(armR, height * 0.9), new THREE.Vector3(0, 0, height * 0.55), new THREE.Euler(0, 0, 0)));
    }

    const merged = mergeGeometries(parts, false);
    if (!merged) {
      throw new Error('Failed to merge debug primitive geometry');
    }

    const geometry = new THREE.BufferGeometry().copy(merged);

    geometry.computeVertexNormals();
    geometry.computeBoundingBox();

    // Match STL normalization approach so all downstream logic behaves the same.
    const preBBox = geometry.boundingBox ? geometry.boundingBox.clone() : new THREE.Box3();
    const preCenter = preBBox.getCenter(new THREE.Vector3());
    geometry.translate(-preCenter.x, -preBBox.min.y, -preCenter.z);
    geometry.computeBoundingBox();

    accelerateGeometry(geometry);

    const bbox = geometry.boundingBox ? geometry.boundingBox.clone() : new THREE.Box3();
    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());

    return { geometry, bbox, center, size };
  }, [getDebugPresetDims]);

  const addDebugPrimitive = useCallback((type: DebugPrimitiveType, preset: DebugPrimitiveSizePreset) => {
    const typeLabelMap: Record<DebugPrimitiveType, string> = {
      pillar: 'Pillar',
      merge_y: 'Merge Y',
      split_y: 'Split Y',
      earlobe: 'Earlobe',
      bridge: 'Bridge',
      finger_palm_arm: 'Finger → Palm → Arm'
    };

    const geom = buildDebugGeometry(type, preset);

    const color = '#a3a3a3';
    clearPaintToBase(geom.geometry, new THREE.Color(color));

    const heightOffset = geom.center.z - geom.bbox.min.z;
    const initialZ = heightOffset;

    const id = generateId();
    const model: LoadedModel = {
      id,
      name: `[Debug] ${typeLabelMap[type]}`,
      fileUrl: '',
      geometry: geom,
      transform: {
        position: new THREE.Vector3(0, 0, initialZ),
        rotation: new THREE.Euler(0, 0, 0),
        scale: new THREE.Vector3(1, 1, 1)
      },
      visible: true,
      color,
      polygonCount: geom.geometry.getAttribute('position').count / 3
    };

    setModels(prev => [...prev, model]);
    setActiveModelId(id);
  }, [buildDebugGeometry]);

  const clearDebugModels = useCallback(() => {
    setModels(prev => {
      for (const m of prev) {
        if (isDebugModelName(m.name)) {
          tryRevokeObjectUrl(m.fileUrl);
        }
      }
      return prev.filter(m => !isDebugModelName(m.name));
    });

    setActiveModelId(prevId => {
      if (!prevId) return prevId;
      const stillExists = models.some(m => m.id === prevId && !isDebugModelName(m.name));
      return stillExists ? prevId : null;
    });
  }, [isDebugModelName, models, tryRevokeObjectUrl]);

  // Lighting controls (Global)
  const [ambientIntensity, setAmbientIntensity] = useState<number>(DEFAULT_AMBIENT_INTENSITY);
  const [directionalIntensity, setDirectionalIntensity] = useState<number>(DEFAULT_DIRECTIONAL_INTENSITY);
  const [materialRoughness, setMaterialRoughness] = useState<number>(DEFAULT_MATERIAL_ROUGHNESS);

  // Shader-specific settings (Global)
  const [wireframeThicknessPx, setWireframeThicknessPx] = useState<number>(DEFAULT_WIREFRAME_THICKNESS_PX);
  const [xrayOpacity, setXrayOpacity] = useState<number>(DEFAULT_XRAY_OPACITY);

  // Mesh shader selection (Global)
  const [shaderType, setShaderType] = useState<MeshShaderType>(DEFAULT_SHADER_TYPE);
  const [matcapVariant, setMatcapVariant] = useState<MatcapVariant>(DEFAULT_MATCAP_VARIANT);
  const [flatUseVertexColors, setFlatUseVertexColors] = useState<boolean>(DEFAULT_FLAT_USE_VERTEX_COLORS);
  const [toonSteps, setToonSteps] = useState<number>(DEFAULT_TOON_STEPS);
  const [preferredMeshColor, setPreferredMeshColor] = useState<string>(DEFAULT_MESH_COLOR);
  const [hoverTintStrength, setHoverTintStrength] = useState<number>(DEFAULT_HOVER_TINT_STRENGTH);
  const [selectedTintStrength, setSelectedTintStrength] = useState<number>(DEFAULT_SELECTED_TINT_STRENGTH);
  const [storedView3dSettings, setView3dSettingsState] = useState<View3DSettings>(() => DEFAULT_VIEW3D_SETTINGS);
  const profileState = useSyncExternalStore(subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreServerSnapshot);
  const activePrinterProfile = useMemo(() => getActivePrinterProfile(profileState), [profileState]);

  const view3dSettings = useMemo(() => {
    if (!activePrinterProfile) {
      // When no printer is selected ("Use without Printer" mode),
      // disable build volume bounds and out-of-bounds warnings by default
      return normalizeView3DSettings({
        ...storedView3dSettings,
        enabled: false,
        showViolationWarning: false,
      });
    }

    return normalizeView3DSettings({
      ...storedView3dSettings,
      widthMm: activePrinterProfile.buildVolumeMm.width,
      depthMm: activePrinterProfile.buildVolumeMm.depth,
      maxZMm: activePrinterProfile.buildVolumeMm.height,
      screenWidthPx: activePrinterProfile.display.resolutionX,
      screenHeightPx: activePrinterProfile.display.resolutionY,
    });
  }, [activePrinterProfile, storedView3dSettings]);

  useEffect(() => {
    const persistedAppearance = readMeshAppearanceFromLocalStorage();
    if (persistedAppearance) {
      setShaderType(persistedAppearance.shaderType);
      setMatcapVariant(persistedAppearance.matcapVariant);
      setFlatUseVertexColors(persistedAppearance.flatUseVertexColors);
      setToonSteps(persistedAppearance.toonSteps);
      setAmbientIntensity(persistedAppearance.ambientIntensity);
      setDirectionalIntensity(persistedAppearance.directionalIntensity);
      setMaterialRoughness(persistedAppearance.materialRoughness);
      setWireframeThicknessPx(persistedAppearance.wireframeThicknessPx);
      setXrayOpacity(persistedAppearance.xrayOpacity);
      setPreferredMeshColor(persistedAppearance.meshColor);
      setHoverTintStrength(persistedAppearance.hoverTintStrength);
      setSelectedTintStrength(persistedAppearance.selectedTintStrength);
    }

    setRecentOpenedFiles(readRecentOpenedFilesFromLocalStorage());
    setView3dSettingsState(getSavedView3DSettings());
  }, []);

  const setView3dSettings = useCallback((next: View3DSettings) => {
    const normalized = normalizeView3DSettings(next);
    setView3dSettingsState(normalized);
    saveView3DSettings(normalized);
  }, []);

  const defaultImportCenterXY = useMemo(() => {
    if (view3dSettings.originMode === 'front_left') {
      return new THREE.Vector2(view3dSettings.widthMm * 0.5, view3dSettings.depthMm * 0.5);
    }
    return new THREE.Vector2(0, 0);
  }, [view3dSettings.depthMm, view3dSettings.originMode, view3dSettings.widthMm]);

  useEffect(() => {
    const prev = readMeshAppearanceFromLocalStorage();

    const persistedShaderType = clampPersistedMeshShaderType(shaderType, prev?.shaderType ?? DEFAULT_SHADER_TYPE);

    writeMeshAppearanceToLocalStorage({
      v: 1,
      shaderType: persistedShaderType,
      matcapVariant,
      flatUseVertexColors,
      toonSteps: clampInt(toonSteps, 2, 16, DEFAULT_TOON_STEPS),
      ambientIntensity: clampNumber(ambientIntensity, 0, 4, DEFAULT_AMBIENT_INTENSITY),
      directionalIntensity: clampNumber(directionalIntensity, 0, 4, DEFAULT_DIRECTIONAL_INTENSITY),
      materialRoughness: clampNumber(materialRoughness, 0, 1, DEFAULT_MATERIAL_ROUGHNESS),
      wireframeThicknessPx: clampNumber(wireframeThicknessPx, 0.5, 6, DEFAULT_WIREFRAME_THICKNESS_PX),
      xrayOpacity: clampNumber(xrayOpacity, 0.02, 0.85, DEFAULT_XRAY_OPACITY),
      meshColor: prev?.meshColor ?? DEFAULT_MESH_COLOR,
      hoverTintStrength: clampNumber(hoverTintStrength, 0, 1, DEFAULT_HOVER_TINT_STRENGTH),
      selectedTintStrength: clampNumber(selectedTintStrength, 0, 1, DEFAULT_SELECTED_TINT_STRENGTH),
    });
  }, [ambientIntensity, directionalIntensity, flatUseVertexColors, hoverTintStrength, materialRoughness, matcapVariant, selectedTintStrength, shaderType, toonSteps, wireframeThicknessPx, xrayOpacity]);

  // Global application mode
  const [mode, setMode] = useState<SupportMode>('prepare');
  const [selectionHighlightMode, setSelectionHighlightMode] = useState<SelectionHighlightMode>('spotlight');

  const applySceneSnapshot = useCallback((snapshot: SceneSnapshot) => {
    setModels(snapshot.models.map(cloneLoadedModel));
    setActiveModelId(snapshot.activeModelId);
    setSelectedModelIds([...snapshot.selectedModelIds]);
  }, []);

  useEffect(() => {
    const unregisterSceneModelsHistory = registerHistoryHandler(
      SCENE_MODELS_SNAPSHOT_APPLY,
      (action: HistoryAction, direction: HistoryDirection) => {
        const payload = action.payload as SceneSnapshotPayload | undefined;
        if (!payload?.key) return false;

        const pair = sceneSnapshotRegistry.get(payload.key);
        if (!pair) return false;

        applySceneSnapshot(direction === 'undo' ? pair.before : pair.after);
        return true;
      },
    );

    return () => {
      unregisterSceneModelsHistory();
    };
  }, [applySceneSnapshot]);

  const pushSceneSnapshotHistory = useCallback((before: SceneSnapshot, after: SceneSnapshot) => {
    const key = storeSceneSnapshotPair({ before, after });
    pushHistory({
      type: SCENE_MODELS_SNAPSHOT_APPLY,
      payload: { key } satisfies SceneSnapshotPayload,
    });
  }, []);

  // Helper to generate IDs
  const generateId = () => crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15);

  const cloneGeometryWithBounds = useCallback((source: GeometryWithBounds, options?: { accelerate?: boolean }): GeometryWithBounds => {
    const clonedGeometry = source.geometry.clone();
    if (options?.accelerate ?? true) {
      accelerateGeometry(clonedGeometry);
    }

    return {
      geometry: clonedGeometry,
      bbox: source.bbox.clone(),
      center: source.center.clone(),
      size: source.size.clone(),
    };
  }, []);

  const processDeferredAccelerationQueue = useCallback(() => {
    if (deferredAccelerationProcessingRef.current) return;
    if (deferredAccelerationPausedRef.current) return;
    if (deferredAccelerationQueueRef.current.length === 0) return;

    deferredAccelerationProcessingRef.current = true;

    const scheduleNext = (cb: () => void) => {
      if (typeof window !== 'undefined' && typeof (window as any).requestIdleCallback === 'function') {
        (window as any).requestIdleCallback(cb, { timeout: 120 });
      } else {
        setTimeout(cb, 16);
      }
    };

    const step = () => {
      if (deferredAccelerationPausedRef.current) {
        deferredAccelerationProcessingRef.current = false;
        return;
      }

      const geometry = deferredAccelerationQueueRef.current.shift();
      if (!geometry) {
        deferredAccelerationProcessingRef.current = false;
        return;
      }

      accelerateGeometry(geometry);

      if (deferredAccelerationQueueRef.current.length === 0) {
        deferredAccelerationProcessingRef.current = false;
        return;
      }

      scheduleNext(step);
    };

    scheduleNext(step);
  }, []);

  const deferAccelerateGeometry = useCallback((entries: GeometryWithBounds[]) => {
    if (entries.length === 0) return;

    deferredAccelerationQueueRef.current.push(...entries.map((entry) => entry.geometry));
    processDeferredAccelerationQueue();
  }, [processDeferredAccelerationQueue]);

  const setBackgroundGeometryWorkPaused = useCallback((paused: boolean) => {
    deferredAccelerationPausedRef.current = paused;
    if (!paused) {
      processDeferredAccelerationQueue();
    }
  }, [processDeferredAccelerationQueue]);

  const trackRecentOpenedFiles = useCallback((files: File[], kind: RecentOpenedFileKind) => {
    if (files.length === 0) return;

    setRecentOpenedFiles((prev) => {
      const next = [...prev];
      const removedBlobIds: string[] = [];
      const now = Date.now();

      files.forEach((file, index) => {
        const name = file.name?.trim();
        if (!name) return;

        const sizeBytes = Number.isFinite(file.size) ? file.size : undefined;

        const matches = next.filter(
          (entry) => entry.kind === kind && entry.name === name && entry.sizeBytes === sizeBytes,
        );

        const existingId = matches.length > 0 ? matches[matches.length - 1].id : generateRecentEntryId();
        const duplicateIds = matches.slice(0, -1).map((entry) => entry.id);

        if (matches.length > 0) {
          for (let i = next.length - 1; i >= 0; i -= 1) {
            const entry = next[i];
            if (entry.kind === kind && entry.name === name && entry.sizeBytes === sizeBytes) {
              next.splice(i, 1);
            }
          }
        }

        if (duplicateIds.length > 0) {
          removedBlobIds.push(...duplicateIds);
        }

        const entry: RecentOpenedFileEntry = {
          id: existingId,
          name,
          kind,
          sizeBytes,
          openedAt: now + index,
        };

        next.push(entry);
        void putRecentOpenedFileBlob(entry, file);
      });

      const overflowCount = Math.max(0, next.length - RECENT_OPENED_FILES_LIMIT);
      const overflow = overflowCount > 0
        ? next.slice(0, overflowCount).map((entry) => entry.id)
        : [];
      const trimmed = overflowCount > 0
        ? next.slice(overflowCount)
        : next;

      writeRecentOpenedFilesToLocalStorage(trimmed);

      if (overflow.length > 0 || removedBlobIds.length > 0) {
        void deleteRecentOpenedFileBlobs([...removedBlobIds, ...overflow]);
      }

      return trimmed;
    });
  }, []);

  // Active model derived state
  const activeModel = useMemo(() =>
    models.find(m => m.id === activeModelId) || null
    , [models, activeModelId]);

  useEffect(() => {
    const modelIdSet = new Set(models.map((m) => m.id));
    setSelectedModelIds((prev) => prev.filter((id) => modelIdSet.has(id)));
    if (activeModelId && !modelIdSet.has(activeModelId)) {
      setActiveModelId(null);
    }
  }, [activeModelId, models]);

  const selectModel = useCallback((id: string, mode: 'single' | 'toggle' | 'add' = 'single') => {
    setActiveModelId(id);

    setSelectedModelIds((prev) => {
      if (mode === 'single') return [id];
      if (mode === 'add') {
        return prev.includes(id) ? prev : [...prev, id];
      }
      return prev.includes(id) ? prev.filter((sid) => sid !== id) : [...prev, id];
    });
  }, []);

  const clearModelSelection = useCallback(() => {
    setSelectedModelIds([]);
    setActiveModelId(null);
  }, []);

  // Clear support selection when switching away from support mode
  useEffect(() => {
    if (mode !== 'support') {
      clearSelection();
    }
  }, [mode]);

  // File handling - support multiple files
  const loadFiles = useCallback(async (filesInput: FileList | File[]) => {
    const files = Array.from(filesInput);

    if (files.length === 0) {
      return;
    }

    trackRecentOpenedFiles(files, 'mesh');

    // Read auto-lift settings from storage (mirroring useTransformManager logic)
    let autoLift = false;
    let liftDistance = 5;
    let preferredMeshColor = DEFAULT_MESH_COLOR;
    if (typeof window !== 'undefined') {
      try {
        const savedLift = window.localStorage.getItem('autoLift');
        if (savedLift) autoLift = JSON.parse(savedLift);
        const savedDist = window.localStorage.getItem('liftDistance');
        if (savedDist) liftDistance = parseFloat(savedDist);

        const savedAppearance = readMeshAppearanceFromLocalStorage();
        if (savedAppearance?.meshColor) preferredMeshColor = savedAppearance.meshColor;
      } catch { }
    }

    const newModels: LoadedModel[] = [];

    setImportProgress({
      active: true,
      type: 'mesh',
      label: files.length > 1 ? 'Loading mesh files…' : 'Loading mesh…',
      detail: files.length > 1 ? `Preparing 0/${files.length}` : 'Preparing geometry…',
      progress: null,
    });

    await waitForUiYield();

    try {
      // Process sequentially to avoid freezing UI too much
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const url = URL.createObjectURL(file);

        setImportProgress({
          active: true,
          type: 'mesh',
          label: files.length > 1 ? 'Loading mesh files…' : 'Loading mesh…',
          detail: files.length > 1
            ? `${i + 1}/${files.length}: ${file.name}`
            : `Loading ${file.name}`,
          progress: null,
        });

        try {
          console.log(`[SceneCollection] Loading ${file.name}...`);
          const geom = await loadStlGeometry(url);

        // Initialize paint
        const color = preferredMeshColor;
        clearPaintToBase(geom.geometry, new THREE.Color(color));

        // Calculate initial transform with auto-lift
        // By default, loaded geometry is centered at 0,0,0 but bottom might be < 0 or > 0 depending on normalization.
        // loadStlGeometry normalizes: center X/Z at 0, set bottom Y (mapped to Z here?) to 0?
        // Wait, loadStlGeometry: geometry.translate(-preCenter.x, -preBBox.min.y, -preCenter.z);
        // This puts the bottom at Y=0.
        // When rendered, we use Y-up or Z-up? SceneCanvas uses Z-up logic in some places, but Three.js is Y-up.
        // StlMesh rotates geometry? No.
        // Let's assume standard orientation: we want bottom at Z=0 (platform) or Z=liftDistance.
        // Since loadStlGeometry normalizes bottom to Y=0, and we usually rotate meshes -90X or similar...
        // Actually, `loadStlGeometry` normalizes it such that "bottom" is at Y=0.
        // In `SceneCanvas` / `StlMesh`, we render it directly.
        // If the model is oriented Z-up (common for 3D printing), `loadStlGeometry` might have put it on its side if it used Y for height.
        // Let's check `loadStlGeometry` normalization: `geometry.translate(-preCenter.x, -preBBox.min.y, -preCenter.z);`
        // This zeroes the Y minimum.

        // The `computeLowestZ` util takes a matrix.
        // Default transform is identity.
        // If we assume the model is upright after load (or we don't rotate it yet), the lowest point is 0.

        // However, `useTransformManager` uses `computeLowestZ` to find the world Z bottom.
        // If we want to lift it, we set Z position.

        // Let's calculate the default Z position.
        // If the geometry is already normalized to sit at 0, then:
        // platformZ = 0.
        // liftZ = liftDistance.

        // But wait, `StlMesh` applies `centerOffset` to the geometry: 
        // `position={new THREE.Vector3(-centerOffset.x, -centerOffset.y, -centerOffset.z)}`
        // `centerOffset` is `bbox.getCenter()`.
        // So the mesh is centered at (0,0,0) inside the group.
        // The group is at `transform.position`.
        // So if we want the bottom of the mesh to be at `targetZ`, we need to know the distance from center to bottom.
        // halfHeight = (max.z - min.z) / 2.
        // targetGroupZ = targetZ + halfHeight.

        // Wait, `useTransformManager` uses `computeLowestZ`.
        // Let's stick to the logic that `useTransformManager` uses, but applied initially.
        // Actually, `useTransformManager` logic:
        // `const heightOffset = center.z - bbox.min.z;`
        // `const finalZ = autoLift ? heightOffset + liftDistance : heightOffset;`

        // So we replicate that logic.
        const bbox = geom.bbox;
        const center = geom.center;
        const heightOffset = center.z - bbox.min.z;
        const initialZ = autoLift ? heightOffset + liftDistance : heightOffset;

        const model: LoadedModel = {
          id: generateId(),
          name: file.name,
          fileUrl: url,
          fileSizeBytes: file.size,
          geometry: geom,
          transform: {
            position: new THREE.Vector3(defaultImportCenterXY.x, defaultImportCenterXY.y, initialZ),
            rotation: new THREE.Euler(0, 0, 0),
            scale: new THREE.Vector3(1, 1, 1)
          },
          visible: true,
          color,
          polygonCount: geom.geometry.getAttribute('position').count / 3
        };

          newModels.push(model);
        } catch (err) {
          console.error(`Failed to load ${file.name}`, err);
          URL.revokeObjectURL(url); // Cleanup if failed
        }

        setImportProgress({
          active: true,
          type: 'mesh',
          label: files.length > 1 ? 'Loading mesh files…' : 'Loading mesh…',
          detail: files.length > 1
            ? `${Math.min(i + 1, files.length)}/${files.length} processed`
            : 'Finalizing model…',
          progress: null,
        });
      }

      if (newModels.length > 0) {
        setModels(prev => [...prev, ...newModels]);
        // If no active model, select the first new one
        if (!activeModelId) {
          setActiveModelId(newModels[0].id);
          setSelectedModelIds([newModels[0].id]);
        }
      }
    } finally {
      setImportProgress({
        active: false,
        type: null,
        label: '',
        detail: '',
        progress: null,
      });
    }
  }, [activeModelId, defaultImportCenterXY.x, defaultImportCenterXY.y, trackRecentOpenedFiles, waitForUiYield]);

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const files = Array.from(e.target.files);
      void loadFiles(files);
      e.target.value = ''; // Reset input
    }
  }, [loadFiles]);

  // Model Management
  const updateModelTransform = useCallback((id: string, transform: ModelTransform) => {
    setModels(prev => prev.map(m =>
      m.id === id ? { ...m, transform } : m
    ));
  }, []);

  const updateModelTransforms = useCallback((updates: Array<{ id: string; transform: ModelTransform }>) => {
    if (updates.length === 0) return;

    const before = captureSceneSnapshot(models, activeModelId, selectedModelIds);

    const updateMap = new Map<string, ModelTransform>();
    updates.forEach((entry) => {
      updateMap.set(entry.id, entry.transform);
    });

    const nextModels = models.map((m) => {
      const nextTransform = updateMap.get(m.id);
      return nextTransform ? { ...m, transform: nextTransform } : m;
    });

    setModels(nextModels);

    const after = captureSceneSnapshot(nextModels, activeModelId, selectedModelIds);
    pushSceneSnapshotHistory(before, after);
  }, [activeModelId, models, pushSceneSnapshotHistory, selectedModelIds]);

  const setModelVisibility = useCallback((id: string, visible: boolean) => {
    setModels(prev => prev.map(m =>
      m.id === id ? { ...m, visible } : m
    ));
  }, []);

  const renameModel = useCallback((id: string, name: string) => {
    setModels(prev => prev.map(m =>
      m.id === id ? { ...m, name } : m
    ));
  }, []);

  const groupModels = useCallback((modelIds: string[], groupName?: string) => {
    const ids = Array.from(new Set(modelIds));
    if (ids.length === 0) return null;

    let resolvedGroupId: string | null = null;
    let resolvedGroupName: string | null = null;

    setModels((prev) => {
      const selected = prev.filter((model) => ids.includes(model.id));
      if (selected.length === 0) return prev;

      const commonGroupId = selected.every((model) => model.groupId && model.groupId === selected[0].groupId)
        ? (selected[0].groupId ?? null)
        : null;

      resolvedGroupId = commonGroupId ?? `group-${generateId()}`;
      const rawName = groupName?.trim();
      resolvedGroupName = rawName && rawName.length > 0
        ? rawName
        : (selected.find((model) => model.groupName?.trim())?.groupName ?? selected[0].name);

      return prev.map((model) => {
        if (!ids.includes(model.id)) return model;
        return {
          ...model,
          groupId: resolvedGroupId ?? undefined,
          groupName: resolvedGroupName ?? undefined,
        };
      });
    });

    if (resolvedGroupId) {
      setSelectedModelIds((prev) => {
        const next = Array.from(new Set([...prev, ...ids]));
        return next;
      });
      setActiveModelId((prev) => prev ?? ids[0] ?? null);
    }

    return resolvedGroupId;
  }, []);

  const ungroupModels = useCallback((modelIds: string[]) => {
    const ids = new Set(modelIds);
    if (ids.size === 0) return;

    setModels((prev) => prev.map((model) => (
      ids.has(model.id)
        ? { ...model, groupId: undefined, groupName: undefined }
        : model
    )));
  }, []);

  const ungroupGroup = useCallback((groupId: string) => {
    setModels((prev) => prev.map((model) => (
      model.groupId === groupId
        ? { ...model, groupId: undefined, groupName: undefined }
        : model
    )));
  }, []);

  const renameGroup = useCallback((groupId: string, nextName: string) => {
    const trimmed = nextName.trim();
    if (!trimmed) return;

    setModels((prev) => prev.map((model) => (
      model.groupId === groupId
        ? { ...model, groupName: trimmed }
        : model
    )));
  }, []);

  const selectGroup = useCallback((groupId: string, mode: 'single' | 'add' = 'single') => {
    const groupIds = models.filter((model) => model.groupId === groupId).map((model) => model.id);
    if (groupIds.length === 0) return;

    setActiveModelId(groupIds[0]);
    setSelectedModelIds((prev) => {
      if (mode === 'add') {
        return Array.from(new Set([...prev, ...groupIds]));
      }
      return groupIds;
    });
  }, [models]);

  const deleteModels = useCallback((idsInput: string[]) => {
    const ids = new Set(idsInput);
    if (ids.size === 0) return;

    const existing = models.filter((m) => ids.has(m.id));
    if (existing.length === 0) return;

    const before = captureSceneSnapshot(models, activeModelId, selectedModelIds);

    existing.forEach((model) => {
      tryRevokeObjectUrl(model.fileUrl);
    });

    const nextModels = models.filter((m) => !ids.has(m.id));
    const nextActiveModelId = activeModelId && ids.has(activeModelId) ? null : activeModelId;
    const nextSelectedModelIds = selectedModelIds.filter((sid) => !ids.has(sid));

    setModels(nextModels);
    setActiveModelId(nextActiveModelId);
    setSelectedModelIds(nextSelectedModelIds);

    const after = captureSceneSnapshot(nextModels, nextActiveModelId, nextSelectedModelIds);
    pushSceneSnapshotHistory(before, after);

    // Clean up associated supports.
    const supportState = getSnapshot();
    let totalRemovedSupports = 0;
    ids.forEach((id) => {
      totalRemovedSupports += deleteSupportsForModel(supportState, id);
    });
    console.log(`[SceneCollection] Deleted ${ids.size} model(s) and ${totalRemovedSupports} associated supports.`);
  }, [activeModelId, models, pushSceneSnapshotHistory, selectedModelIds, tryRevokeObjectUrl]);

  const deleteModel = useCallback((id: string) => {
    deleteModels([id]);
  }, [deleteModels]);

  const copyModel = useCallback((id: string) => {
    const source = models.find((m) => m.id === id);
    if (!source) return false;

    setModelClipboard([
      {
        sourceId: source.id,
        name: source.name,
        fileSizeBytes: source.fileSizeBytes,
        geometry: source.geometry,
        transform: {
          position: source.transform.position.clone(),
          rotation: source.transform.rotation.clone(),
          scale: source.transform.scale.clone(),
        },
        color: source.color,
        polygonCount: source.polygonCount,
      },
    ]);

    return true;
  }, [models]);

  const copySelectedModels = useCallback((ids?: string[]) => {
    const idSet = new Set((ids && ids.length > 0) ? ids : selectedModelIds);
    if (idSet.size === 0) return false;

    const selected = models.filter((m) => idSet.has(m.id));
    if (selected.length === 0) return false;

    setModelClipboard(selected.map((source) => ({
      sourceId: source.id,
      name: source.name,
      fileSizeBytes: source.fileSizeBytes,
      geometry: source.geometry,
      transform: {
        position: source.transform.position.clone(),
        rotation: source.transform.rotation.clone(),
        scale: source.transform.scale.clone(),
      },
      color: source.color,
      polygonCount: source.polygonCount,
    })));

    return true;
  }, [models, selectedModelIds]);

  const cutModel = useCallback((id: string) => {
    const copied = copyModel(id);
    if (!copied) return false;
    deleteModel(id);
    return true;
  }, [copyModel, deleteModel]);

  const pasteModel = useCallback(() => {
    if (modelClipboard.length === 0) return null;

    const before = captureSceneSnapshot(models, activeModelId, selectedModelIds);

    const first = modelClipboard[0];

    const pastedGeometry = cloneGeometryWithBounds(first.geometry, { accelerate: false });

    const id = generateId();
    const pastedModel: LoadedModel = {
      id,
      name: `${first.name} Copy`,
      fileUrl: '',
      fileSizeBytes: first.fileSizeBytes,
      geometry: pastedGeometry,
      transform: {
        position: first.transform.position.clone().add(new THREE.Vector3(6, 6, 0)),
        rotation: first.transform.rotation.clone(),
        scale: first.transform.scale.clone(),
      },
      visible: true,
      color: first.color,
      polygonCount: first.polygonCount,
    };

    const nextModels = [...models, pastedModel];
    setModels(nextModels);
    setActiveModelId(id);
    setSelectedModelIds([id]);

    const after = captureSceneSnapshot(nextModels, id, [id]);
    pushSceneSnapshotHistory(before, after);

    deferAccelerateGeometry([pastedGeometry]);
    return id;
  }, [activeModelId, cloneGeometryWithBounds, deferAccelerateGeometry, generateId, modelClipboard, models, pushSceneSnapshotHistory, selectedModelIds]);

  const pasteCopiedModelsAutoArrange = useCallback((spacingMm = 5) => {
    if (modelClipboard.length === 0) return [] as string[];

    const before = captureSceneSnapshot(models, activeModelId, selectedModelIds);

    const entries = modelClipboard;

    const centerX = defaultImportCenterXY.x;
    const centerY = defaultImportCenterXY.y;
    const minX = view3dSettings.originMode === 'front_left' ? 0 : -view3dSettings.widthMm * 0.5;
    const maxX = minX + view3dSettings.widthMm;
    const minY = view3dSettings.originMode === 'front_left' ? 0 : -view3dSettings.depthMm * 0.5;
    const maxY = minY + view3dSettings.depthMm;

    type Rect2D = { minX: number; maxX: number; minY: number; maxY: number };

    const intersectsRect = (a: Rect2D, b: Rect2D) => {
      return !(a.maxX <= b.minX || a.minX >= b.maxX || a.maxY <= b.minY || a.minY >= b.maxY);
    };

    const isRectInsidePlate = (rect: Rect2D) => (
      rect.minX >= minX
      && rect.maxX <= maxX
      && rect.minY >= minY
      && rect.maxY <= maxY
    );

    const footprintFor = (size: THREE.Vector3, transform: ModelTransform) => {
      const baseW = Math.max(2, Math.abs(size.x * transform.scale.x));
      const baseD = Math.max(2, Math.abs(size.y * transform.scale.y));
      const rz = transform.rotation.z;
      const c = Math.abs(Math.cos(rz));
      const s = Math.abs(Math.sin(rz));
      return {
        width: (baseW * c) + (baseD * s),
        depth: (baseW * s) + (baseD * c),
      };
    };

    const maxWidth = Math.max(...entries.map((entry) => footprintFor(entry.geometry.size, entry.transform).width));
    const maxDepth = Math.max(...entries.map((entry) => footprintFor(entry.geometry.size, entry.transform).depth));
    const stepX = Math.max(4, maxWidth + Math.max(0, spacingMm));
    const stepY = Math.max(4, maxDepth + Math.max(0, spacingMm));

    const blockedRects: Rect2D[] = models
      .filter((model) => model.visible)
      .map((model) => {
        const { width, depth } = footprintFor(model.geometry.size, model.transform);
        return {
          minX: model.transform.position.x - (width * 0.5),
          maxX: model.transform.position.x + (width * 0.5),
          minY: model.transform.position.y - (depth * 0.5),
          maxY: model.transform.position.y + (depth * 0.5),
        };
      });

    const candidateCenters: Array<{ x: number; y: number; distSq: number }> = [];
    const halfSpanX = Math.max(Math.abs(centerX - minX), Math.abs(maxX - centerX));
    const halfSpanY = Math.max(Math.abs(centerY - minY), Math.abs(maxY - centerY));
    const inPlateRingX = Math.ceil(halfSpanX / stepX) + 2;
    const inPlateRingY = Math.ceil(halfSpanY / stepY) + 2;
    const maxInPlateRing = Math.max(inPlateRingX, inPlateRingY);
    const outsideRings = 12;
    const maxRing = maxInPlateRing + outsideRings;

    for (let ring = 0; ring <= maxRing; ring += 1) {
      if (ring === 0) {
        candidateCenters.push({ x: centerX, y: centerY, distSq: 0 });
        continue;
      }

      for (let gx = -ring; gx <= ring; gx += 1) {
        const gyTop = ring;
        const gyBottom = -ring;
        const x = centerX + gx * stepX;

        const yTop = centerY + gyTop * stepY;
        const dxTop = x - centerX;
        const dyTop = yTop - centerY;
        candidateCenters.push({ x, y: yTop, distSq: (dxTop * dxTop) + (dyTop * dyTop) });

        if (gyBottom !== gyTop) {
          const yBottom = centerY + gyBottom * stepY;
          const dxBottom = x - centerX;
          const dyBottom = yBottom - centerY;
          candidateCenters.push({ x, y: yBottom, distSq: (dxBottom * dxBottom) + (dyBottom * dyBottom) });
        }
      }

      for (let gy = -ring + 1; gy <= ring - 1; gy += 1) {
        const gxRight = ring;
        const gxLeft = -ring;
        const y = centerY + gy * stepY;

        const xRight = centerX + gxRight * stepX;
        const dxRight = xRight - centerX;
        const dyRight = y - centerY;
        candidateCenters.push({ x: xRight, y, distSq: (dxRight * dxRight) + (dyRight * dyRight) });

        if (gxLeft !== gxRight) {
          const xLeft = centerX + gxLeft * stepX;
          const dxLeft = xLeft - centerX;
          const dyLeft = y - centerY;
          candidateCenters.push({ x: xLeft, y, distSq: (dxLeft * dxLeft) + (dyLeft * dyLeft) });
        }
      }
    }

    candidateCenters.sort((a, b) => a.distSq - b.distSq);

    const assignedCenters: Array<{ x: number; y: number }> = entries.map((entry) => {
      const { width, depth } = footprintFor(entry.geometry.size, entry.transform);

      const makeRectAt = (x: number, y: number): Rect2D => ({
        minX: x - (width * 0.5),
        maxX: x + (width * 0.5),
        minY: y - (depth * 0.5),
        maxY: y + (depth * 0.5),
      });

      // Pass 1: exhaust all valid in-plate positions first.
      for (const candidate of candidateCenters) {
        const rect = makeRectAt(candidate.x, candidate.y);
        if (!isRectInsidePlate(rect)) continue;

        if (blockedRects.some((blocked) => intersectsRect(rect, blocked))) {
          continue;
        }

        blockedRects.push(rect);
        return { x: candidate.x, y: candidate.y };
      }

      // Pass 2: if in-plate is full, allow outside placements.
      for (const candidate of candidateCenters) {
        const rect = makeRectAt(candidate.x, candidate.y);

        if (blockedRects.some((blocked) => intersectsRect(rect, blocked))) {
          continue;
        }

        blockedRects.push(rect);
        return { x: candidate.x, y: candidate.y };
      }

      // Fallback: if exhaustive candidates are blocked, place further to the right of center.
      const fallbackX = centerX + (maxRing + 2 + blockedRects.length) * stepX;
      const fallbackY = centerY;
      blockedRects.push({
        minX: fallbackX - (width * 0.5),
        maxX: fallbackX + (width * 0.5),
        minY: fallbackY - (depth * 0.5),
        maxY: fallbackY + (depth * 0.5),
      });
      return { x: fallbackX, y: fallbackY };
    });

    const createdIds: string[] = [];
    const pastedGeometries: GeometryWithBounds[] = [];
    const pastedModels: LoadedModel[] = entries.map((entry, index) => {
      const id = generateId();
      createdIds.push(id);

      const geometry = cloneGeometryWithBounds(entry.geometry, { accelerate: false });
      pastedGeometries.push(geometry);

      const center = assignedCenters[index] ?? { x: centerX, y: centerY };

      return {
        id,
        name: `${entry.name} Copy`,
        fileUrl: '',
        fileSizeBytes: entry.fileSizeBytes,
        geometry,
        transform: {
          position: new THREE.Vector3(center.x, center.y, entry.transform.position.z),
          rotation: entry.transform.rotation.clone(),
          scale: entry.transform.scale.clone(),
        },
        visible: true,
        color: entry.color,
        polygonCount: entry.polygonCount,
      };
    });

    const nextModels = [...models, ...pastedModels];
    setModels(nextModels);
    if (createdIds.length > 0) {
      setActiveModelId(createdIds[0]);
      setSelectedModelIds(createdIds);

      const after = captureSceneSnapshot(nextModels, createdIds[0], createdIds);
      pushSceneSnapshotHistory(before, after);
    }

    deferAccelerateGeometry(pastedGeometries);

    return createdIds;
  }, [activeModelId, cloneGeometryWithBounds, defaultImportCenterXY.x, defaultImportCenterXY.y, deferAccelerateGeometry, generateId, modelClipboard, models, pushSceneSnapshotHistory, selectedModelIds, view3dSettings.depthMm, view3dSettings.originMode, view3dSettings.widthMm]);

  const duplicateModelWithTransforms = useCallback((sourceId: string, transforms: ModelTransform[], sourceTransform?: ModelTransform | null) => {
    if (transforms.length === 0) return [] as string[];

    const source = models.find((m) => m.id === sourceId);
    if (!source) return [] as string[];

    const before = captureSceneSnapshot(models, activeModelId, selectedModelIds);

    const resolvedGroupId = source.groupId ?? `group-${generateId()}`;
    const resolvedGroupName = source.groupName ?? source.name;

    const createdIds: string[] = [];
    const duplicatedGeometries: GeometryWithBounds[] = [];

    const newModels: LoadedModel[] = transforms.map((nextTransform, index) => {
      const id = generateId();
      createdIds.push(id);

      const geometry = cloneGeometryWithBounds(source.geometry, { accelerate: false });
      duplicatedGeometries.push(geometry);

      return {
        id,
        name: `${source.name} Copy ${index + 1}`,
        groupId: resolvedGroupId,
        groupName: resolvedGroupName,
        fileUrl: '',
        fileSizeBytes: source.fileSizeBytes,
        geometry,
        transform: {
          position: nextTransform.position.clone(),
          rotation: nextTransform.rotation.clone(),
          scale: nextTransform.scale.clone(),
        },
        visible: source.visible,
        color: source.color,
        polygonCount: source.polygonCount,
      };
    });

    const withSourceGroup = models.map((model) => {
      if (model.id !== sourceId) return model;
      const shouldUpdateGroup = model.groupId !== resolvedGroupId || model.groupName !== resolvedGroupName;
      const shouldUpdateTransform = !!sourceTransform;
      if (!shouldUpdateGroup && !shouldUpdateTransform) return model;
      return {
        ...model,
        groupId: resolvedGroupId,
        groupName: resolvedGroupName,
        transform: sourceTransform
          ? {
              position: sourceTransform.position.clone(),
              rotation: sourceTransform.rotation.clone(),
              scale: sourceTransform.scale.clone(),
            }
          : model.transform,
      };
    });

    const nextModels = [...withSourceGroup, ...newModels];
    setModels(nextModels);

    if (createdIds.length > 0) {
      setActiveModelId(createdIds[0]);
      setSelectedModelIds([sourceId, ...createdIds]);

      const nextSelected = [sourceId, ...createdIds];
      const after = captureSceneSnapshot(nextModels, createdIds[0], nextSelected);
      pushSceneSnapshotHistory(before, after);
    }

    deferAccelerateGeometry(duplicatedGeometries);

    return createdIds;
  }, [activeModelId, cloneGeometryWithBounds, deferAccelerateGeometry, generateId, models, pushSceneSnapshotHistory, selectedModelIds]);

  // NEW: LYS Import (1-step)
  const lysImport = useLysImport();

  const handleImportLysFile = useCallback(async (file: File) => {
    trackRecentOpenedFiles([file], 'scene');

    setImportProgress({
      active: true,
      type: 'scene',
      label: 'Importing scene…',
      detail: file.name,
      progress: null,
    });

    await waitForUiYield();

    try {
      const result = await lysImport.importFile(file, {
        importCenterXY: {
          x: defaultImportCenterXY.x,
          y: defaultImportCenterXY.y,
        },
      });
      if (result && result.geometry) {
        const { geometry: rawGeom, transform: importedTransform, modelId: importedModelId } = result;

        // Process geometry (bounds, center, normals, BVH)
        const processed = await processGeometry(rawGeom, { center: false });

        // Initialize paint
        const color = '#a3a3a3';
        clearPaintToBase(processed.geometry, new THREE.Color(color));

        const finalPosition = new THREE.Vector3(
          importedTransform.position.x,
          importedTransform.position.y,
          importedTransform.position.z
        );

        const model: LoadedModel = {
          id: importedModelId || generateId(),
          name: file.name,
          fileUrl: '', // No URL
          fileSizeBytes: file.size,
          geometry: processed,
          transform: {
            position: finalPosition,
            rotation: importedTransform.rotation, // Keep rotation
            scale: importedTransform.scale        // Keep scale
          },
          visible: true,
          color,
          polygonCount: processed.geometry.getAttribute('position').count / 3,
          ignoreAutoLift: true,
        };

        setModels(prev => [...prev, model]);
        setActiveModelId(model.id);
        setSelectedModelIds([model.id]);
        console.log(`[SceneCollection] LYS Import successful: ${model.name}`);
      } else {
        const errorMessage = lysImport.error || 'LYS import failed before geometry could be produced.';
        console.error('[SceneCollection] LYS import failed:', errorMessage);
        if (typeof window !== 'undefined') {
          window.alert(`Import Scene failed:\n${errorMessage}`);
        }
      }
    } catch (err) {
      console.error("[SceneCollection] Failed to process LYS geometry:", err);
      if (typeof window !== 'undefined') {
        const msg = err instanceof Error ? err.message : String(err);
        window.alert(`Import Scene failed:\n${msg}`);
      }
    } finally {
      setImportProgress({
        active: false,
        type: null,
        label: '',
        detail: '',
        progress: null,
      });
    }
  }, [defaultImportCenterXY.x, defaultImportCenterXY.y, lysImport, generateId, processGeometry, setModels, setActiveModelId, clearPaintToBase, trackRecentOpenedFiles, waitForUiYield]);

  const onImportLysChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleImportLysFile(e.target.files[0]);
      e.target.value = '';
    }
  }, [handleImportLysFile]);

  const reopenRecentOpenedFile = useCallback(async (entryId: string) => {
    const entry = recentOpenedFiles.find((item) => item.id === entryId);
    if (!entry) return false;

    const file = await readRecentOpenedFileBlob(entry);
    if (!file) {
      console.warn('[SceneCollection] Unable to restore recent file from local cache.');
      return false;
    }

    if (entry.kind === 'scene') {
      await handleImportLysFile(file);
      return true;
    }

    await loadFiles([file]);
    return true;
  }, [handleImportLysFile, loadFiles, recentOpenedFiles]);

  // Legacy Lychee loader wrapper
  const handleLoadLychee = async () => {
    try {
      const res = await fetch('/dragonfruit_supports.json');
      const data = await res.json();
      loadFromLychee(data);
      console.log('Loaded Lychee data:', data);
    } catch (e) {
      console.error('Failed to load Lychee data:', e);
    }
  };

  // New Import Handler for Lychee Files (Legacy - single step)
  const importLycheeSupportFile = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const json = JSON.parse(text);

      // Determine if it's raw Lychee (has 'supports') or pre-converted Dragonfruit (has 'trunks')
      // But here we assume raw Lychee as per the goal.
      // LysConverter.convert handles the Raw Lychee structure.
      // Dynamic import to avoid circular deps if any (though usually fine here)
      const { LysConverter } = await import('@/components/lys-import/LysConverter');

      console.log('[SceneCollection] Converting Lychee file...');
      const converted = LysConverter.convert(json, getSettings());

      console.log('[SceneCollection] Loading into Store...');
      loadFromLychee(converted);

    } catch (err) {
      console.error('[SceneCollection] Failed to import Lychee file:', err);
    }
  }, []);

  // Two-Step Lychee Import (JSON -> STL -> Apply Transforms -> Create Supports)
  const lycheeImport = useLycheeImport();

  const handleLycheeModelLoaded = useCallback((result: LycheeImportResult) => {
    // Create model from the import result
    const color = '#a3a3a3';
    clearPaintToBase(result.geometry.geometry, new THREE.Color(color));

    const model: LoadedModel = {
      id: result.modelId,
      name: 'Lychee Import',
      fileUrl: '', // No URL for imported models
      geometry: result.geometry,
      transform: {
        position: result.transform.position,
        rotation: result.transform.rotation,
        scale: result.transform.scale
      },
      visible: true,
      color,
      polygonCount: result.geometry.geometry.getAttribute('position').count / 3
    };

    setModels(prev => [...prev, model]);
    setActiveModelId(result.modelId);
    setSelectedModelIds([result.modelId]);

    console.log('[SceneCollection] Lychee import complete:', {
      modelId: result.modelId,
      supports: result.supportCount
    });
  }, []);

  const handleLycheeStlFile = useCallback((file: File) => {
    lycheeImport.processStlFile(file, handleLycheeModelLoaded);
  }, [lycheeImport.processStlFile, handleLycheeModelLoaded]);

  // Delete Handler Integration
  useEffect(() => {
    const unregister = registerDeleteHandler(
      () => mode === 'prepare' && activeModelId !== null,
      () => {
        if (activeModelId) {
          deleteModel(activeModelId);
        }
      },
      10 // Priority
    );
    return () => { unregister(); };
  }, [activeModelId, deleteModel, mode]);

  // Helper accessors for active model (compatibility)
  const activeMeshColor = activeModel?.color ?? preferredMeshColor;
  const activeMeshVisible = activeModel?.visible ?? true;
  const activeFileName = activeModel?.name ?? null;

  const setMeshColor = useCallback((color: string) => {
    const normalizedColor = clampHexColor(color, DEFAULT_MESH_COLOR);
    setPreferredMeshColor(normalizedColor);

    if (activeModelId) {
      setModels(prev => prev.map(m => {
        if (m.id !== activeModelId) return m;

        try {
          clearPaintToBase(m.geometry.geometry, new THREE.Color(normalizedColor));
        } catch (err) {
          console.error('[SceneCollection] Failed to apply mesh color to geometry:', err);
        }

        return { ...m, color: normalizedColor };
      }));
    }

    const prev = readMeshAppearanceFromLocalStorage();

    const persistedShaderType = clampPersistedMeshShaderType(prev?.shaderType ?? shaderType, DEFAULT_SHADER_TYPE);
    writeMeshAppearanceToLocalStorage({
      v: 1,
      shaderType: persistedShaderType,
      matcapVariant: prev?.matcapVariant ?? matcapVariant,
      flatUseVertexColors: prev?.flatUseVertexColors ?? flatUseVertexColors,
      toonSteps: prev?.toonSteps ?? toonSteps,
      ambientIntensity: prev?.ambientIntensity ?? ambientIntensity,
      directionalIntensity: prev?.directionalIntensity ?? directionalIntensity,
      materialRoughness: prev?.materialRoughness ?? materialRoughness,
      wireframeThicknessPx: prev?.wireframeThicknessPx ?? wireframeThicknessPx,
      xrayOpacity: prev?.xrayOpacity ?? xrayOpacity,
      meshColor: normalizedColor,
      hoverTintStrength: prev?.hoverTintStrength ?? hoverTintStrength,
      selectedTintStrength: prev?.selectedTintStrength ?? selectedTintStrength,
    });
  }, [activeModelId, ambientIntensity, directionalIntensity, flatUseVertexColors, hoverTintStrength, materialRoughness, matcapVariant, selectedTintStrength, shaderType, toonSteps, wireframeThicknessPx, xrayOpacity]);

  const setMeshVisible = useCallback((visible: boolean) => {
    if (activeModelId) {
      setModelVisibility(activeModelId, visible);
    }
  }, [activeModelId, setModelVisibility]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      models.forEach(m => tryRevokeObjectUrl(m.fileUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Calculate global scene bounds for slicing/camera
  const sceneBounds = useMemo(() => {
    if (models.length === 0) return null;

    const unionBox = new THREE.Box3();
    let hasVisible = false;

    for (const model of models) {
      if (!model.visible) continue;

      // Clone bbox to not mutate original
      const modelBox = model.geometry.bbox.clone();
      const center = model.geometry.center; // This is the pre-calculated center of bbox

      // 1. Center the box (matches StlMesh behavior: geometry rendered at -centerOffset)
      modelBox.translate(new THREE.Vector3(-center.x, -center.y, -center.z));

      // 2. Apply model transform
      const t = model.transform;
      const matrix = new THREE.Matrix4().compose(
        t.position,
        new THREE.Quaternion().setFromEuler(t.rotation),
        t.scale
      );

      modelBox.applyMatrix4(matrix);

      // 3. Union
      if (!hasVisible) {
        unionBox.copy(modelBox);
        hasVisible = true;
      } else {
        unionBox.union(modelBox);
      }
    }

    return hasVisible ? unionBox : null;
  }, [models]);

  return {
    models,
    activeModelId,
    setActiveModelId,
    selectedModelIds,
    setSelectedModelIds,
    selectModel,
    clearModelSelection,
    activeModel,

    // Active Model Compatibility helpers
    fileName: activeFileName,
    meshColor: activeMeshColor,
    setMeshColor,
    meshVisible: activeMeshVisible,
    setMeshVisible,
    geom: activeModel?.geometry ?? null,
    polygonCount: activeModel?.polygonCount ?? 0,

    // Scene context
    sceneBounds,
    importProgress,
    recentOpenedFiles,
    reopenRecentOpenedFile,
    view3dSettings,
    setView3dSettings,

    // Actions
    loadFiles,
    onFileChange,
    updateModelTransform,
    updateModelTransforms,
    setModelVisibility,
    renameModel,
    groupModels,
    ungroupModels,
    ungroupGroup,
    renameGroup,
    selectGroup,
    deleteModels,
    deleteModel,
    copyModel,
    copySelectedModels,
    cutModel,
    pasteModel,
    pasteCopiedModelsAutoArrange,
    duplicateModelWithTransforms,
    setBackgroundGeometryWorkPaused,
    canPasteModel: modelClipboard.length > 0,

    // Scene settings
    ambientIntensity,
    setAmbientIntensity,
    directionalIntensity,
    setDirectionalIntensity,
    materialRoughness,
    setMaterialRoughness,
    wireframeThicknessPx,
    setWireframeThicknessPx,
    xrayOpacity,
    setXrayOpacity,
    shaderType,
    setShaderType,
    matcapVariant,
    setMatcapVariant,
    flatUseVertexColors,
    setFlatUseVertexColors,
    toonSteps,
    setToonSteps,
    hoverTintStrength,
    setHoverTintStrength,
    selectedTintStrength,
    setSelectedTintStrength,
    mode,
    setMode,
    selectionHighlightMode,
    setSelectionHighlightMode,

    // Legacy/Other
    handleLoadLychee,
    importLycheeSupportFile,

    // Two-Step Lychee Import
    lycheeImportPhase: lycheeImport.phase,
    lycheeImportError: lycheeImport.error,
    handleLycheeJsonFile: lycheeImport.processJsonFile,
    handleLycheeStlFile,
    cancelLycheeImport: lycheeImport.cancelImport,

    // LYS Import (1-step)
    importLysFile: handleImportLysFile,
    onImportLysChange,
    isLysLoading: lysImport.isLoading,
    lysError: lysImport.error,

    // Debug primitives
    addDebugPrimitive,
    clearDebugModels
  };
}

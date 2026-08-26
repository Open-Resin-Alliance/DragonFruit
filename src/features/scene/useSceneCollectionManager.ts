import { useState, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loadMeshGeometry, load3mfGeometryMergedWithSplitData, processGeometry, type GeometryWithBounds, type ProcessGeometryOptions } from '@/hooks/useStlGeometry';
import type { MeshHealthReport, MeshAnalysisJson } from '@/utils/meshRepair';
import { computeFlatteningPlanes, type FlatteningPlane } from '@/features/placeOnFace/logic/computeFlatteningPlanes';
import { isVoxlBinaryV2, meshChunkStore, parseVoxlBinaryV2, parseVoxlDocument, readSidecarFileBytes, resolveOriginalRefSidecar, type VoxlDocumentV1, type VoxlMeshRef, type PrecompressedChunk } from '@/features/scene/voxl';
import { clearPaintToBase } from '@/components/analysis/MeshPainter';
import { getSnapshot, loadFromImportFormat, mergeFromImportFormat, reassignAllSupportModelIds, setSnapshot as setSupportSnapshot, transformAllSupportsForSingleModel, transformSupportsForModel } from '@/supports/state';
import { registerDeleteHandler } from '@/features/delete/deleteRegistry';
import { createTypedHistory } from '@/history/typedHistory';
import type { ModelTransform } from '@/hooks/useModelTransform';
import type { DragonfruitImportFormat, SupportMode, SupportState } from '@/supports/types';
import { getBuiltinComplexPluginDefinitions } from '@/features/plugins/builtinComplexPlugins';
import { getBuiltinComplexPluginFileTypeHandlers } from '@/features/plugins/builtinComplexPluginFileTypeHandlers';
import type { PluginFileTypeDefinition } from '@/features/plugins/complexPluginContracts';
import type { PluginFileTypeHandler } from '@/features/plugins/pluginFileTypeBridge';
import { accelerateGeometry, disposeGeometryBVH } from '@/utils/bvh';
import { eulerFromGlobalEuler, quaternionFromGlobalEuler } from '@/utils/rotation';
import { v4 as uuidv4 } from 'uuid';
import { registerMeshForAutoBrace, unregisterMeshForAutoBrace } from '@/supports/autoBracing/meshGeometryStore';
import { getKickstandSnapshot, setKickstandSnapshot } from '@/supports/SupportTypes/Kickstand/kickstandStore';
import type { KickstandState } from '@/supports/SupportTypes/Kickstand/types';
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
import type { ModelMeshModifiers } from '@/features/mesh-modifiers/types';
import {
  deleteStoredMeshModifiers,
  getStoredMeshModifiers,
  storeModelMeshModifiers,
} from '@/features/mesh-modifiers/meshModifierStore';
import { splitClassifiedSupportGeometry } from '@/features/scene/splitClassifiedSupports';
import {
  applyModelGrouping,
  applyModelGroupUngrouping,
  applyModelUngrouping,
} from '@/features/scene/modelGroupingHistory';

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
  heatmapMinAngle: number;
  heatmapMaxAngle: number;
  heatmapColors: string[];
  meshColor: string;
  selectionColor: string;
  hoverColor: string;
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
const DEFAULT_HEATMAP_MIN_ANGLE = 0;
const DEFAULT_HEATMAP_MAX_ANGLE = 45;
export const DEFAULT_HEATMAP_COLORS = ['#E55959', '#E5A559', '#D9D959', '#73D973', '#666666'];
const DEFAULT_SHADER_TYPE: MeshShaderType = 'soft_clay';
const DEFAULT_MATCAP_VARIANT: MatcapVariant = 'neutral';
const DEFAULT_FLAT_USE_VERTEX_COLORS = true;
const DEFAULT_TOON_STEPS = 5;
export const DEFAULT_SELECTION_COLOR = '#ec2a77';
export const DEFAULT_HOVER_COLOR = '#ec2a77';
export const DEFAULT_HOVER_TINT_STRENGTH = 0.5;
export const DEFAULT_SELECTED_TINT_STRENGTH = 0.75;
const RECENT_OPENED_FILES_STORAGE_KEY = 'app-recent-opened-files';
const RECENT_OPENED_FILES_LIMIT = 10;
const RECENT_FILES_DB_NAME = 'dragonfruit-recent-files';
const RECENT_FILES_DB_VERSION = 1;
const RECENT_FILES_STORE_NAME = 'files';
const SCENE_MODELS_SNAPSHOT_APPLY = 'scene_models_snapshot_apply' as const;
// A marker pushed after a slice so change-detection can tell whether the scene
// was edited since. It carries no undo behaviour, but it still lands on the undo
// stack, so it must have a (pass-through) handler — otherwise undoing onto it
// would strand the stack. Exported so the push site keys off the same constant.
export const SCENE_SLICED = 'SCENE_SLICED' as const;
const SCENE_HISTORY_MAX_SNAPSHOTS = 200;
// Belt-and-suspenders alongside the count cap above: a handful of
// full-resolution geometry swaps (e.g. repeated hollowing on a large model)
// can retain far more memory per snapshot than typical small edits, so the
// flat count cap alone can leave a lot of stale geometry pinned alive.
const SCENE_HISTORY_MAX_ESTIMATED_GEOMETRY_BYTES = 300 * 1024 * 1024;

type SceneSnapshotPayload = { key: string };

/** Action→payload map for the scene history domain. */
type SceneHistoryPayloadMap = {
  [SCENE_MODELS_SNAPSHOT_APPLY]: SceneSnapshotPayload;
  [SCENE_SLICED]: Record<string, never>;
};
const sceneHistory = createTypedHistory<SceneHistoryPayloadMap>();

/** Push the post-slice marker used to detect edits made after a slice. */
export function pushSceneSlicedMarker(): void {
  sceneHistory.push({ type: SCENE_SLICED, description: 'Scene sliced for printing', payload: {} });
}

type SceneSnapshot = {
  models: LoadedModel[];
  activeModelId: string | null;
  selectedModelIds: string[];
  supportState?: SupportState;
  kickstandState?: KickstandState;
};

type SceneSnapshotCaptureOptions = {
  includeSupportState?: boolean;
  supportStateOverride?: SupportState;
  kickstandStateOverride?: KickstandState;
};

type TransformHistorySupportSnapshotOptions = {
  supportBefore?: SupportState;
  supportAfter?: SupportState;
  kickstandBefore?: KickstandState;
  kickstandAfter?: KickstandState;
  includeSupportState?: boolean;
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

function transformsEqual(a: ModelTransform, b: ModelTransform): boolean {
  const EPSILON = 1e-5;
  return a.position.distanceToSquared(b.position) <= EPSILON
    && Math.abs(a.rotation.x - b.rotation.x) <= EPSILON
    && Math.abs(a.rotation.y - b.rotation.y) <= EPSILON
    && Math.abs(a.rotation.z - b.rotation.z) <= EPSILON
    && a.scale.distanceToSquared(b.scale) <= EPSILON;
}

function cloneLoadedModel(model: LoadedModel): LoadedModel {
  return {
    ...model,
    transform: cloneTransform(model.transform),
    // meshModifiers are stored externally in meshModifierStoreRef — never on the model object.
    meshModifiers: undefined,
  };
}

/**
 * Lightweight shallow clone — avoids JSON round-trip through MB-scale
 * base64 strings (cavityPositionsBase64, holePunchSourcePositionsBase64)
 * that LYS imports carry in meshModifiers.
 *
 * NOTE: Since meshModifiers are now stored externally in
 * meshModifierStoreRef and stripped from model objects, this function is
 * only used during import to sanitize the payload before storing it in
 * the external store.
 */
function cloneMeshModifiersShallow(modifiers: ModelMeshModifiers): ModelMeshModifiers {
  return {
    ...modifiers,
    hollowing: modifiers.hollowing ? { ...modifiers.hollowing } : undefined,
    holePunches: modifiers.holePunches ? modifiers.holePunches.map((p) => ({ ...p })) : undefined,
    holePunchAppliedPlacements: modifiers.holePunchAppliedPlacements
      ? modifiers.holePunchAppliedPlacements.map((p) => ({ ...p }))
      : undefined,
  };
}

// ── External Mesh Modifier Store ─────────────────────────────────────────
//
// Model mesh modifiers (especially the MB-scale cavityPositionsBase64 /
// sourcePositionsBase64 from LYS imports) are kept in a module-level Map in
// features/mesh-modifiers/meshModifierStore.ts instead of on model objects.
// This prevents React's state reconciliation from churning on large payloads
// during selection, copy, paste, and duplicate operations. Save/export/slice
// boundaries must resolve modifiers through that store (see
// resolveModelMeshModifiers) — model objects carry meshModifiers: undefined
// by design.

function schedulePostPaint(callback: () => void): void {
  if (typeof window === 'undefined') {
    setTimeout(callback, 0);
    return;
  }
  window.setTimeout(callback, 0);
}

// ─────────────────────────────────────────────────────────────────────────

function clonePlainObject<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value) as T;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function captureSceneSnapshot(
  models: LoadedModel[],
  activeModelId: string | null,
  selectedModelIds: string[],
  options?: SceneSnapshotCaptureOptions,
): SceneSnapshot {
  const includeSupportState = options?.includeSupportState ?? false;
  const supportStateOverride = options?.supportStateOverride;
  const kickstandStateOverride = options?.kickstandStateOverride;

  return {
    models: models.map(cloneLoadedModel),
    activeModelId,
    selectedModelIds: [...selectedModelIds],
    ...(includeSupportState
      ? {
          supportState: clonePlainObject(supportStateOverride ?? getSnapshot()),
          kickstandState: clonePlainObject(kickstandStateOverride ?? getKickstandSnapshot()),
        }
      : {}),
  };
}

function hasSupportsOrKickstandsForModel(
  modelId: string,
  supportState: SupportState,
  kickstandState: KickstandState,
): boolean {
  const supportIds = getSupportsForModel(supportState, modelId);
  const hasMainSupports = supportIds.roots.length > 0
    || supportIds.trunks.length > 0
    || supportIds.branches.length > 0
    || supportIds.braces.length > 0
    || supportIds.leaves.length > 0
    || supportIds.twigs.length > 0
    || supportIds.sticks.length > 0;
  if (hasMainSupports) return true;

  return Object.values(kickstandState.kickstands).some((kickstand) => kickstand.modelId === modelId);
}

function estimateGeometryBytes(geometry: THREE.BufferGeometry): number {
  let total = 0;
  for (const key in geometry.attributes) {
    const attribute = geometry.attributes[key];
    if (attribute?.array) {
      total += (attribute.array as ArrayBufferView).byteLength;
    }
  }
  if (geometry.index?.array) {
    total += (geometry.index.array as ArrayBufferView).byteLength;
  }
  return total;
}

// Counts each distinct BufferGeometry ONCE, because that is what the process
// actually holds: cloneLoadedModel is a shallow clone, so every snapshot that
// didn't change the mesh shares the same geometry object. A move stores two
// snapshots and allocates no mesh memory at all.
//
// Counting per snapshot instead treated that shared mesh as a fresh allocation
// each time, so the budget was exhausted after a handful of moves and eviction
// threw away undo entries that cost nothing -- their scene snapshots went with
// them, and undoing those actions was silently declined and discarded. Only
// geometry a step genuinely creates (a cut, a hollow) adds to the total now.
function estimateSceneSnapshotRegistryBytes(): number {
  const counted = new Set<THREE.BufferGeometry>();
  let total = 0;
  const add = (model: LoadedModel) => {
    const geometry = model.geometry.geometry;
    if (counted.has(geometry)) return;
    counted.add(geometry);
    total += estimateGeometryBytes(geometry);
  };
  for (const pair of sceneSnapshotRegistry.values()) {
    pair.before.models.forEach(add);
    pair.after.models.forEach(add);
  }
  return total;
}

/**
 * The registry's geometry total, for the history debug panel. Same dedup rule as
 * the eviction budget above, so the panel reports the memory that is actually
 * held rather than a per-snapshot sum that counts one shared mesh many times.
 */
export function getSceneSnapshotRegistryBytes(): number {
  return estimateSceneSnapshotRegistryBytes();
}

function storeSceneSnapshotPair(pair: SceneSnapshotPair): string {
  const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  sceneSnapshotRegistry.set(key, pair);
  sceneSnapshotOrder.push(key);

  while (sceneSnapshotOrder.length > SCENE_HISTORY_MAX_SNAPSHOTS) {
    const removed = sceneSnapshotOrder.shift();
    if (removed) sceneSnapshotRegistry.delete(removed);
  }

  // Always keep at least one snapshot so undo of the most recent action
  // still works, even if it alone exceeds the byte budget.
  while (
    sceneSnapshotOrder.length > 1
    && estimateSceneSnapshotRegistryBytes() > SCENE_HISTORY_MAX_ESTIMATED_GEOMETRY_BYTES
  ) {
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
  sourcePath?: string;
  sizeBytes?: number;
  openedAt: number;
};

type RecentOpenedFileBlobRecord = {
  id: string;
  name: string;
  kind: RecentOpenedFileKind;
  sourcePath?: string;
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
      heatmapMinAngle: clampNumber(parsed.heatmapMinAngle, 0, 90, DEFAULT_HEATMAP_MIN_ANGLE),
      heatmapMaxAngle: clampNumber(parsed.heatmapMaxAngle, 0, 90, DEFAULT_HEATMAP_MAX_ANGLE),
      heatmapColors: Array.isArray(parsed.heatmapColors) && parsed.heatmapColors.length === 5 ? parsed.heatmapColors : DEFAULT_HEATMAP_COLORS,
      meshColor: clampHexColor(parsed.meshColor, DEFAULT_MESH_COLOR),
      selectionColor: clampHexColor(parsed.selectionColor, DEFAULT_SELECTION_COLOR),
      hoverColor: clampHexColor(parsed.hoverColor, DEFAULT_HOVER_COLOR),
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
      sourcePath: entry.sourcePath,
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
        const sourcePath = typeof item.sourcePath === 'string' && item.sourcePath.trim().length > 0
          ? item.sourcePath.trim()
          : undefined;
        const openedAt = Number(item.openedAt);
        const sizeBytes = typeof item.sizeBytes === 'number' && Number.isFinite(item.sizeBytes) && item.sizeBytes >= 0
          ? item.sizeBytes
          : undefined;

        if (!id || !name || !kind || !Number.isFinite(openedAt)) return null;

        return {
          id,
          name,
          kind,
          sourcePath,
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

function decodeBase64ToUint8Array(base64: string): Uint8Array {
  if (typeof atob !== 'function') {
    throw new Error('Base64 decoding is unavailable in this environment.');
  }

  const normalized = base64.replace(/\s+/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeRleU8(encoded: Uint8Array, expectedSize: number): Uint8Array {
  if (!Number.isFinite(expectedSize) || expectedSize <= 0 || !Number.isInteger(expectedSize)) {
    throw new Error('Invalid VOXL RLE expected size.');
  }

  if (encoded.length % 2 !== 0) {
    throw new Error('Invalid VOXL RLE payload: expected count/value byte pairs.');
  }

  const out = new Uint8Array(expectedSize);
  let outIndex = 0;

  for (let i = 0; i < encoded.length; i += 2) {
    const count = encoded[i];
    const value = encoded[i + 1];
    if (count <= 0) {
      throw new Error('Invalid VOXL RLE payload: zero-length run.');
    }

    const next = outIndex + count;
    if (next > expectedSize) {
      throw new Error('Invalid VOXL RLE payload: run length exceeds expected output size.');
    }

    out.fill(value, outIndex, next);
    outIndex = next;
  }

  if (outIndex !== expectedSize) {
    throw new Error('Invalid VOXL RLE payload: decoded size mismatch.');
  }

  return out;
}

function decodeVoxlEmbeddedMeshBytes(meshRef: VoxlMeshRef): Uint8Array {
  if (!meshRef.dataBase64) {
    throw new Error('VOXL embedded mesh is missing dataBase64.');
  }

  const encoded = decodeBase64ToUint8Array(meshRef.dataBase64);
  const dataEncoding = meshRef.dataEncoding ?? 'base64-raw';

  if (dataEncoding === 'base64-raw') {
    return encoded;
  }

  if (dataEncoding === 'base64-rle-u8') {
    return decodeRleU8(encoded, meshRef.uncompressedSizeBytes ?? 0);
  }

  throw new Error(`Unsupported VOXL embedded mesh encoding: ${String(dataEncoding)}`);
}

function sanitizeImportedModelDisplayName(rawName: string): string {
  const trimmed = rawName.trim();
  if (!trimmed) return 'model';

  let base = trimmed;
  while (true) {
    const dotIndex = base.lastIndexOf('.');
    if (dotIndex <= 0) break;
    base = base.slice(0, dotIndex).trim();
    if (!base) return 'model';
  }

  return base;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('SHA-256 hashing is unavailable in this environment.');
  }

  const digestInput = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(digestInput).set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput);
  const digestBytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < digestBytes.length; i += 1) {
    hex += digestBytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function remapModelIdsInPayload<T>(value: T, idMap: Map<string, string>): T {
  const visit = (input: unknown, key?: string): unknown => {
    if (Array.isArray(input)) {
      return input.map((item) => visit(item));
    }

    if (!input || typeof input !== 'object') {
      if (key === 'modelId' && typeof input === 'string') {
        return idMap.get(input) ?? input;
      }
      return input;
    }

    const source = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(source)) {
      out[childKey] = visit(childValue, childKey);
    }
    return out;
  };

  return visit(value) as T;
}

function voxlSupportsContainData(document: VoxlDocumentV1): boolean {
  const supports = document.supports;
  return supports.roots.length > 0
    || supports.trunks.length > 0
    || supports.branches.length > 0
    || supports.leaves.length > 0
    || (supports.twigs?.length ?? 0) > 0
    || (supports.sticks?.length ?? 0) > 0
    || supports.braces.length > 0
    || supports.knots.length > 0
    || (supports.kickstands?.length ?? 0) > 0;
}

function countSupportEntries(payload: DragonfruitImportFormat | null | undefined): number {
  if (!payload) return 0;
  return payload.roots.length
    + payload.trunks.length
    + payload.branches.length
    + payload.leaves.length
    + (payload.twigs?.length ?? 0)
    + (payload.sticks?.length ?? 0)
    + payload.braces.length
    + payload.knots.length
    + (payload.kickstands?.length ?? 0);
}

function applyImportDefaultsToRaftState() {
  const defaults = getSavedImportDefaultsSettings();
  const patch = getImportDefaultsRaftPatch(defaults);
  // Merge with current settings to preserve non-raft-specific settings
  const merged = { ...getRaftSettings(), ...patch };
  // Apply without marking as manually modified, so manual changes in the same session can override
  applyImportDefaultRaftSettings(merged);
}

type PluginSceneImportPayload = {
  geometry: THREE.BufferGeometry;
  transform: {
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  };
  modelId?: string;
  /**
   * Display name from the SOURCE file, where the format carries one (LYS object
   * `name`, Chitubox per-model filename). Preferred over deriving a name from
   * the imported filename, which cannot distinguish models inside one container
   * and falls back to numeric suffixes ("project (2)", "project (3)").
   */
  objName?: string;
  supportData?: DragonfruitImportFormat | null;
  meshModifiers?: ModelMeshModifiers;
};

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toVector3(value: unknown): THREE.Vector3 | null {
  if (value instanceof THREE.Vector3) {
    return value.clone();
  }

  if (!value || typeof value !== 'object') return null;
  const source = value as { x?: unknown; y?: unknown; z?: unknown };
  const x = toFiniteNumber(source.x);
  const y = toFiniteNumber(source.y);
  const z = toFiniteNumber(source.z);
  if (x == null || y == null || z == null) return null;
  return new THREE.Vector3(x, y, z);
}

function toEuler(value: unknown): THREE.Euler | null {
  if (value instanceof THREE.Euler) {
    return value.clone();
  }

  if (!value || typeof value !== 'object') return null;
  const source = value as { x?: unknown; y?: unknown; z?: unknown };
  const x = toFiniteNumber(source.x);
  const y = toFiniteNumber(source.y);
  const z = toFiniteNumber(source.z);
  if (x == null || y == null || z == null) return null;
  return new THREE.Euler(x, y, z);
}

function asDragonfruitImportFormat(value: unknown): DragonfruitImportFormat | null {
  if (!value || typeof value !== 'object') return null;

  const candidate = value as Partial<DragonfruitImportFormat>;
  const requiredArrayKeys: Array<keyof DragonfruitImportFormat> = [
    'roots',
    'trunks',
    'branches',
    'leaves',
    'braces',
    'knots',
  ];

  if (!requiredArrayKeys.every((key) => Array.isArray(candidate[key]))) {
    return null;
  }

  if (candidate.twigs != null && !Array.isArray(candidate.twigs)) return null;
  if (candidate.sticks != null && !Array.isArray(candidate.sticks)) return null;
  if (candidate.kickstands != null && !Array.isArray(candidate.kickstands)) return null;

  return candidate as DragonfruitImportFormat;
}

function normalizePluginSceneImportPayload(payload: unknown): PluginSceneImportPayload | null {
  if (!payload || typeof payload !== 'object') return null;

  const source = payload as {
    geometry?: unknown;
    transform?: unknown;
    modelId?: unknown;
    objName?: unknown;
    supportData?: unknown;
    meshModifiers?: unknown;
  };

  if (!(source.geometry instanceof THREE.BufferGeometry)) return null;
  if (!source.transform || typeof source.transform !== 'object') return null;

  const transformSource = source.transform as {
    position?: unknown;
    rotation?: unknown;
    scale?: unknown;
  };

  const position = toVector3(transformSource.position);
  const rotation = toEuler(transformSource.rotation);
  const scale = toVector3(transformSource.scale);

  if (!position || !rotation || !scale) return null;

  let meshModifiers: ModelMeshModifiers | undefined;
  if (source.meshModifiers && typeof source.meshModifiers === 'object') {
    // Accept the modifiers as-is — they are plain objects that match the interface.
    meshModifiers = source.meshModifiers as ModelMeshModifiers;
  }

  return {
    geometry: source.geometry,
    transform: {
      position,
      rotation,
      scale,
    },
    modelId: typeof source.modelId === 'string' && source.modelId.trim().length > 0
      ? source.modelId
      : undefined,
    objName: typeof source.objName === 'string' && source.objName.trim().length > 0
      ? source.objName.trim()
      : undefined,
    supportData: asDragonfruitImportFormat(source.supportData),
    meshModifiers,
  };
}

export interface LoadedModel {
  id: string;
  name: string;
  groupId?: string;
  groupName?: string;
  fileUrl: string;
  /** Original on-disk mesh retained when `geometry` is a reduced native preview. */
  sourcePath?: string | null;
  /** Original mesh sidecar reference when not embedded in ORIG chunk. */
  originalRef?: VoxlMeshRef;
  fileSizeBytes?: number;
  geometry: GeometryWithBounds;
  transform: ModelTransform;
  visible: boolean;
  color: string;
  polygonCount: number;
  /** Pre-processed individual body geometries for multi-body 3MF imports.
   *  When set, "Split to Bodies" replaces this single model with separate
   *  models for each entry — instant, no reprocessing needed. */
  splitBodies?: GeometryWithBounds[];
  meshModifiers?: ModelMeshModifiers;
  ignoreAutoLift?: boolean;
  manualZMoveOverride?: boolean;
  isSupportGeometry?: boolean;
  linkGroupId?: string;
}

type DebugPrimitiveType =
  | 'pillar'
  | 'merge_y'
  | 'split_y'
  | 'earlobe'
  | 'bridge'
  | 'finger_palm_arm';

type DebugPrimitiveSizePreset = 'small' | 'medium' | 'large';

import { deleteSupportsForModel, getSupportsForModel } from '@/supports/PlacementLogic/SupportModelLinker';
import { beginSupportStateBatch, endSupportStateBatch } from '@/supports/state';
import {
  captureModelSupportsToClipboard,
  estimateSupportBoundsForModel,
  pasteModelSupportsFromClipboard,
  type SupportClipboardPayload,
} from '@/supports/PlacementLogic/supportClipboard';
import { clearSupportSelection } from '@/supports/interaction/shared/selection/selectionController';
import { getRaftSettings, updateRaftSettings, applyImportDefaultRaftSettings, resetRaftSessionModificationFlag } from '@/supports/Rafts/Crenelated/RaftState';
import { computeFootprint } from '@/supports/Rafts/Crenelated/geometry/computeFootprint';
import { computeRaftOuterBoundary } from '@/supports/Rafts/Crenelated/geometry/computeRaftOuterBoundary';
import type { SupportBaseCircle } from '@/supports/Rafts/Crenelated/RaftTypes';
import { beginKickstandStoreBatch, endKickstandStoreBatch } from '@/supports/SupportTypes/Kickstand/kickstandStore';
import { getImportDefaultsRaftPatch, getSavedImportDefaultsSettings } from '@/features/scene/importDefaultsPreferences';
import { readNativeFileSize } from '@/utils/pluginNetworkBridge';

type ImportProgressState = {
  active: boolean;
  type: 'mesh' | 'scene' | null;
  label: string;
  detail: string;
  progress: number | null;
};

export type SceneImportReportTone = 'success' | 'warning' | 'error';

export type SceneImportReport = {
  id: number;
  text: string;
  tone: SceneImportReportTone;
  durationMs?: number;
  clickAction?: 'openMeshRepairReport';
};

export type MeshRepairReportEntry = {
  id: string;
  modelName: string;
  report: MeshHealthReport;
};

type MeshRepairReportPresentation = 'default' | 'optimistic';

function repairReportNeedsAttention(report: MeshHealthReport): boolean {
  if (!report.fully_repaired) return true;

  const pre = report.pre;
  const post = report.post;
  return post.vertex_count < pre.vertex_count
    || post.triangle_count < pre.triangle_count
    || post.non_manifold_edges < pre.non_manifold_edges
    || post.boundary_loops < pre.boundary_loops
    || post.inconsistent_edges < pre.inconsistent_edges;
}

type SceneImportPlacementChoice = 'auto_arrange' | 'load_as_is';

export type SceneImportPlacementPrompt = {
  source: string;
  fileName: string;
  modelCount: number;
  offPlateModelCount: number;
};

export type MeshRepairConfirmPrompt = {
  fileName: string;
  analysis: MeshAnalysisJson;
};

type MeshRepairConfirmChoice = 'repair' | 'load_as_is' | 'cancel_import';

type ModelClipboardEntry = {
  sourceId: string;
  name: string;
  fileSizeBytes?: number;
  geometry: GeometryWithBounds;
  transform: ModelTransform;
  color: string;
  polygonCount: number;
  meshModifiers?: ModelMeshModifiers;
  supportClipboard: SupportClipboardPayload | null;
  isSupportGeometry?: boolean;
  linkGroupId?: string;
};

// ---------------------------------------------------------------------------
// COW chunk-store hooks (Ph0.1 sub-phase C2 / C3)
// ---------------------------------------------------------------------------

/**
 * `ExportManager` is loaded lazily here. It is a heavy module that pulls in the
 * STL exporter, the support stores and the raft geometry generators, and this
 * file is on the app's critical path — a static import would drag all of it into
 * the initial scene bundle for work that is, by construction, deferrable.
 */
async function exportManager() {
  const { ExportManager } = await import('@/features/export/logic/ExportManager');
  return ExportManager;
}

const scheduleIdleTask = (task: () => void, timeout = 500): void => {
  if (typeof window !== 'undefined' && typeof (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
  }).requestIdleCallback === 'function') {
    (window as unknown as {
      requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => void;
    }).requestIdleCallback(task, { timeout });
    return;
  }
  setTimeout(task, 0);
};

/**
 * Bakes one model's mesh chunk after a finalized geometry mutation.
 *
 * Idle-scheduled so React commits the new geometry to the screen first: the bake
 * is an encode + SHA + zlib-6 over the whole mesh, and the user is looking at
 * the result of the operation that produced it.
 *
 * Failures are logged, never thrown. The geometry SIGNATURE is the authority, so
 * a bake that does not land costs the next autosave tick one lazy re-bake — it
 * can never cause a stale write.
 */
function scheduleModelChunkBake(model: LoadedModel | undefined): void {
  if (!model) return;
  scheduleIdleTask(() => {
    void exportManager()
      .then((manager) => manager.bakeModelGeometryChunk(model))
      .catch((error) => {
        console.warn('[SceneCollection] Mesh chunk bake failed; the next autosave will bake lazily.', error);
      });
  });
}

/**
 * Coalesced sweep over the whole scene: bakes anything not yet in the store and
 * releases anything that has left it.
 *
 * This is deliberately a sweep rather than a hook per entry point. Models arrive
 * from import, both split paths, paste, undo/redo and autosave recovery, and a
 * per-path hook set would need every one of those — and every future one — to
 * remember. The sweep is derived from the model list itself, which is the same
 * reasoning that made the geometry signature preferable to a dirty flag.
 */
let chunkStoreSweepPending = false;
function scheduleChunkStoreSweep(getModels: () => LoadedModel[]): void {
  if (chunkStoreSweepPending) return;
  chunkStoreSweepPending = true;
  scheduleIdleTask(() => {
    chunkStoreSweepPending = false;
    const models = getModels();
    void exportManager()
      .then(async (manager) => {
        manager.retainModelChunks(models.map((m) => m.id));
        for (const model of models) {
          await manager.bakeModelGeometryChunk(model);
        }
      })
      .catch((error) => {
        console.warn('[SceneCollection] Mesh chunk sweep failed; the next autosave will bake lazily.', error);
      });
  }, 1_500);
}

export function useSceneCollectionManager() {
  type ScenePluginImportEntry = {
    pluginId: string;
    fileType: PluginFileTypeDefinition;
    handler: PluginFileTypeHandler;
  };

  const getMeshExtension = useCallback((name: string): '.stl' | '.obj' | '.3mf' | null => {
    const normalized = name.trim().toLowerCase();
    if (normalized.endsWith('.stl')) return '.stl';
    if (normalized.endsWith('.obj')) return '.obj';
    if (normalized.endsWith('.3mf')) return '.3mf';
    return null;
  }, []);

  const getSceneExtension = useCallback((name: string): string | null => {
    const normalized = name.trim().toLowerCase();
    if (normalized.endsWith('.voxl')) return '.voxl';
    for (const def of getBuiltinComplexPluginDefinitions()) {
      for (const ft of def.fileTypes ?? []) {
        if (ft.isSceneFile && normalized.endsWith(ft.fileExtension)) {
          return ft.fileExtension;
        }
      }
    }
    return null;
  }, []);

  const scenePluginImportHandlersByExtension = useMemo(() => {
    const handlersByPluginId = new Map(
      getBuiltinComplexPluginFileTypeHandlers().map((entry) => [entry.pluginId, entry.handler]),
    );

    const out = new Map<string, ScenePluginImportEntry>();

    for (const definition of getBuiltinComplexPluginDefinitions()) {
      for (const fileType of definition.fileTypes ?? []) {
        if (!fileType.isSceneFile) continue;

        const extension = fileType.fileExtension.toLowerCase();
        const handler = handlersByPluginId.get(definition.id);
        if (!handler) continue;

        out.set(extension, {
          pluginId: definition.id,
          fileType,
          handler,
        });
      }
    }

    return out;
  }, []);

  const waitForUiYield = useCallback(
    () => new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    }),
    [],
  );

  const [models, setModels] = useState<LoadedModel[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const modelsRef = useRef<LoadedModel[]>([]);
  const activeModelIdRef = useRef<string | null>(null);
  const selectedModelIdsRef = useRef<string[]>([]);
  // Whether the most recently loaded .voxl was the chunked 2.2 layout. Read by
  // the import/export manager right after a load to seed the scene's save-format
  // so autosave preserves an old file's format without ever downgrading a 2.2
  // one. Defaults to true (newest) for non-voxl / fresh scenes.
  const lastLoadedVoxlFormatChunkedRef = useRef<boolean>(true);
  modelsRef.current = models;
  activeModelIdRef.current = activeModelId;
  selectedModelIdsRef.current = selectedModelIds;

  // Keep the COW chunk store in step with the scene (Ph0.1 sub-phase C).
  // Coalesced and idle-scheduled, so a burst of imports or an Auto-Arrange
  // sweeps once. See `scheduleChunkStoreSweep` for why this is a sweep rather
  // than a hook on every model-producing path.
  useEffect(() => {
    if (models.length === 0) return;
    scheduleChunkStoreSweep(() => modelsRef.current);
  }, [models]);
  const [modelClipboard, setModelClipboard] = useState<ModelClipboardEntry[]>([]);
  const [recentOpenedFiles, setRecentOpenedFiles] = useState<RecentOpenedFileEntry[]>([]);
  const [importProgress, setImportProgress] = useState<ImportProgressState>({
    active: false,
    type: null,
    label: '',
    detail: '',
    progress: null,
  });
  const [sceneImportReport, setSceneImportReport] = useState<SceneImportReport | null>(null);
  const [sceneImportPlacementPrompt, setSceneImportPlacementPrompt] = useState<SceneImportPlacementPrompt | null>(null);
  const [meshRepairConfirmPrompt, setMeshRepairConfirmPrompt] = useState<MeshRepairConfirmPrompt | null>(null);
  const [meshRepairReports, setMeshRepairReports] = useState<MeshRepairReportEntry[]>([]);
  const [meshRepairReportPresentation, setMeshRepairReportPresentation] = useState<MeshRepairReportPresentation>('default');
  const [pendingMeshRepairReports, setPendingMeshRepairReports] = useState<MeshRepairReportEntry[]>([]);
  const sceneImportReportTimeoutRef = useRef<number | null>(null);
  const sceneImportPlacementResolveRef = useRef<((choice: SceneImportPlacementChoice) => void) | null>(null);
  const meshRepairConfirmResolveRef = useRef<((choice: MeshRepairConfirmChoice) => void) | null>(null);

  const isDebugModelName = useCallback((name: string) => name.startsWith('[Debug]'), []);
  const deferredAccelerationQueueRef = useRef<THREE.BufferGeometry[]>([]);
  const deferredAccelerationProcessingRef = useRef(false);
  const deferredAccelerationPausedRef = useRef(false);
  const deferredDisposalQueueRef = useRef<THREE.BufferGeometry[]>([]);
  const deferredDisposalProcessingRef = useRef(false);
  // Count of scheduled-but-unfinished flattening-plane computations (idle
  // callbacks after geometry swaps). Part of hasPendingBackgroundGeometryWork.
  const pendingFlatteningPlanesRef = useRef(0);
  const trackedGeometriesRef = useRef<Set<THREE.BufferGeometry>>(new Set());

  const tryRevokeObjectUrl = useCallback((url: string) => {
    if (!url) return;
    if (!url.startsWith('blob:')) return;
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Ignore invalid URLs
    }
  }, []);

  const emitSceneImportReport = useCallback((
    text: string,
    tone: SceneImportReportTone = 'success',
    options?: { durationMs?: number; clickAction?: SceneImportReport['clickAction'] },
  ) => {
    const durationMs = options?.durationMs ?? 4200;
    setSceneImportReport({
      id: Date.now(),
      text,
      tone,
      durationMs,
      clickAction: options?.clickAction,
    });

    if (typeof window !== 'undefined') {
      if (sceneImportReportTimeoutRef.current !== null) {
        window.clearTimeout(sceneImportReportTimeoutRef.current);
      }

      sceneImportReportTimeoutRef.current = window.setTimeout(() => {
        setSceneImportReport(null);
        setPendingMeshRepairReports([]);
        sceneImportReportTimeoutRef.current = null;
      }, durationMs);
    }
  }, []);

  const clearSceneImportReport = useCallback(() => {
    setSceneImportReport(null);

    if (typeof window !== 'undefined' && sceneImportReportTimeoutRef.current !== null) {
      window.clearTimeout(sceneImportReportTimeoutRef.current);
      sceneImportReportTimeoutRef.current = null;
    }
  }, []);

  const dismissMeshRepairReports = useCallback(() => {
    setMeshRepairReports([]);
    setMeshRepairReportPresentation('default');
  }, []);

  const openPendingMeshRepairReports = useCallback(() => {
    if (pendingMeshRepairReports.length === 0) {
      return;
    }
    setMeshRepairReportPresentation('default');
    setMeshRepairReports(pendingMeshRepairReports);
    setPendingMeshRepairReports([]);
    clearSceneImportReport();
  }, [clearSceneImportReport, pendingMeshRepairReports]);

  const resolveSceneImportPlacementPrompt = useCallback((choice: SceneImportPlacementChoice) => {
    const resolve = sceneImportPlacementResolveRef.current;
    sceneImportPlacementResolveRef.current = null;
    setSceneImportPlacementPrompt(null);
    resolve?.(choice);
  }, []);

  const resolveMeshRepairConfirmPrompt = useCallback((choice: MeshRepairConfirmChoice) => {
    const resolve = meshRepairConfirmResolveRef.current;
    meshRepairConfirmResolveRef.current = null;
    setMeshRepairConfirmPrompt(null);
    resolve?.(choice);
  }, []);

  const requestMeshRepairConfirmation = useCallback(async (
    prompt: MeshRepairConfirmPrompt,
  ): Promise<MeshRepairConfirmChoice> => {
    if (typeof window === 'undefined') return 'repair';

    if (meshRepairConfirmResolveRef.current) {
      // Fail-safe: resolve a stale unresolved prompt so imports never deadlock.
      meshRepairConfirmResolveRef.current('repair');
      meshRepairConfirmResolveRef.current = null;
    }

    setMeshRepairConfirmPrompt(prompt);

    return new Promise<MeshRepairConfirmChoice>((resolve) => {
      meshRepairConfirmResolveRef.current = resolve;
    });
  }, []);

  const requestSceneImportPlacementChoice = useCallback(async (
    prompt: SceneImportPlacementPrompt,
  ): Promise<SceneImportPlacementChoice> => {
    if (typeof window === 'undefined') {
      return 'auto_arrange';
    }

    if (sceneImportPlacementResolveRef.current) {
      // Fail-safe: resolve previous unresolved prompt so imports never deadlock.
      sceneImportPlacementResolveRef.current('load_as_is');
      sceneImportPlacementResolveRef.current = null;
    }

    setSceneImportPlacementPrompt(prompt);

    return await new Promise<SceneImportPlacementChoice>((resolve) => {
      sceneImportPlacementResolveRef.current = resolve;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sceneImportPlacementResolveRef.current) {
        const resolve = sceneImportPlacementResolveRef.current;
        sceneImportPlacementResolveRef.current = null;
        resolve('load_as_is');
      }
    };
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
    const flatteningPlanes = computeFlatteningPlanes(geometry);

    return { geometry, bbox, center, size, flatteningPlanes };
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

    const id = uuidv4();
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
  const [shaderType, setShaderType] = useState<MeshShaderType>(DEFAULT_SHADER_TYPE);
  const [matcapVariant, setMatcapVariant] = useState<MatcapVariant>(DEFAULT_MATCAP_VARIANT);
  const [flatUseVertexColors, setFlatUseVertexColors] = useState<boolean>(DEFAULT_FLAT_USE_VERTEX_COLORS);
  const [toonSteps, setToonSteps] = useState<number>(DEFAULT_TOON_STEPS);
  const [wireframeThicknessPx, setWireframeThicknessPx] = useState<number>(DEFAULT_WIREFRAME_THICKNESS_PX);
  const [xrayOpacity, setXrayOpacity] = useState<number>(DEFAULT_XRAY_OPACITY);
  const [heatmapMinAngle, setHeatmapMinAngle] = useState<number>(DEFAULT_HEATMAP_MIN_ANGLE);
  const [heatmapMaxAngle, setHeatmapMaxAngle] = useState<number>(DEFAULT_HEATMAP_MAX_ANGLE);
  const [heatmapColors, setHeatmapColors] = useState<string[]>(DEFAULT_HEATMAP_COLORS);
  const [preferredMeshColor, setPreferredMeshColor] = useState<string>(DEFAULT_MESH_COLOR);
  const [selectionColor, setSelectionColor] = useState<string>(DEFAULT_SELECTION_COLOR);
  const [hoverColor, setHoverColor] = useState<string>(DEFAULT_HOVER_COLOR);
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
      safetyMarginMm: activePrinterProfile.safetyMarginMm,
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
      setHeatmapMinAngle(persistedAppearance.heatmapMinAngle ?? DEFAULT_HEATMAP_MIN_ANGLE);
      setHeatmapMaxAngle(persistedAppearance.heatmapMaxAngle ?? DEFAULT_HEATMAP_MAX_ANGLE);
      setHeatmapColors(persistedAppearance.heatmapColors ?? DEFAULT_HEATMAP_COLORS);
      setPreferredMeshColor(persistedAppearance.meshColor);
      setSelectionColor(persistedAppearance.selectionColor ?? DEFAULT_SELECTION_COLOR);
      setHoverColor(persistedAppearance.hoverColor ?? DEFAULT_HOVER_COLOR);
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

  // Global application mode
  const [mode, setMode] = useState<SupportMode>('prepare');

  const defaultImportCenterXY = useMemo(() => {
    if (view3dSettings.originMode === 'front_left') {
      return new THREE.Vector2(view3dSettings.widthMm * 0.5, view3dSettings.depthMm * 0.5);
    }
    return new THREE.Vector2(0, 0);
  }, [view3dSettings.depthMm, view3dSettings.originMode, view3dSettings.widthMm]);

  type Rect2D = { minX: number; maxX: number; minY: number; maxY: number };

  const intersectsRect = useCallback((a: Rect2D, b: Rect2D) => {
    return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
  }, []);

  const isRectInsidePlate = useCallback((rect: Rect2D) => {
    const minX = view3dSettings.originMode === 'front_left' ? 0 : -view3dSettings.widthMm * 0.5;
    const maxX = minX + view3dSettings.widthMm;
    const minY = view3dSettings.originMode === 'front_left' ? 0 : -view3dSettings.depthMm * 0.5;
    const maxY = minY + view3dSettings.depthMm;

    return (
      rect.minX >= minX
      && rect.maxX <= maxX
      && rect.minY >= minY
      && rect.maxY <= maxY
    );
  }, [view3dSettings.depthMm, view3dSettings.originMode, view3dSettings.widthMm]);

  const footprintForTransform = useCallback((size: THREE.Vector3, transform: ModelTransform) => {
    const baseW = Math.max(2, Math.abs(size.x * transform.scale.x));
    const baseD = Math.max(2, Math.abs(size.y * transform.scale.y));
    const rz = transform.rotation.z;
    const c = Math.abs(Math.cos(rz));
    const s = Math.abs(Math.sin(rz));
    return {
      width: (baseW * c) + (baseD * s),
      depth: (baseW * s) + (baseD * c),
    };
  }, []);

  const buildMeshPlacementOffsets = useCallback((
    center: { x: number; y: number },
    size: THREE.Vector3,
    transform: ModelTransform,
  ) => {
    const footprint = footprintForTransform(size, transform);
    const meshRect: Rect2D = {
      minX: center.x - (footprint.width * 0.5),
      maxX: center.x + (footprint.width * 0.5),
      minY: center.y - (footprint.depth * 0.5),
      maxY: center.y + (footprint.depth * 0.5),
    };

    return {
      minXOffset: meshRect.minX - center.x,
      maxXOffset: meshRect.maxX - center.x,
      minYOffset: meshRect.minY - center.y,
      maxYOffset: meshRect.maxY - center.y,
      width: Math.max(2, meshRect.maxX - meshRect.minX),
      depth: Math.max(2, meshRect.maxY - meshRect.minY),
    };
  }, [footprintForTransform]);

  const isModelFootprintInsidePlate = useCallback((
    model: Pick<LoadedModel, 'geometry' | 'transform'>,
  ) => {
    const placement = buildMeshPlacementOffsets(
      { x: model.transform.position.x, y: model.transform.position.y },
      model.geometry.size,
      model.transform,
    );

    const modelRect: Rect2D = {
      minX: model.transform.position.x + placement.minXOffset,
      maxX: model.transform.position.x + placement.maxXOffset,
      minY: model.transform.position.y + placement.minYOffset,
      maxY: model.transform.position.y + placement.maxYOffset,
    };

    return isRectInsidePlate(modelRect);
  }, [buildMeshPlacementOffsets, isRectInsidePlate]);

  const findFreeSpotCentersForModels = useCallback((
    incomingModels: Array<Pick<LoadedModel, 'geometry' | 'transform'>>,
    spacingMm = 5,
  ): Array<{ x: number; y: number }> => {
    if (incomingModels.length === 0) return [];

    const centerX = defaultImportCenterXY.x;
    const centerY = defaultImportCenterXY.y;
    const minX = view3dSettings.originMode === 'front_left' ? 0 : -view3dSettings.widthMm * 0.5;
    const maxX = minX + view3dSettings.widthMm;
    const minY = view3dSettings.originMode === 'front_left' ? 0 : -view3dSettings.depthMm * 0.5;
    const maxY = minY + view3dSettings.depthMm;

    const placementOffsets = incomingModels.map((model) => buildMeshPlacementOffsets(
      { x: model.transform.position.x, y: model.transform.position.y },
      model.geometry.size,
      model.transform,
    ));

    const maxWidth = Math.max(...placementOffsets.map((entry) => entry.width));
    const maxDepth = Math.max(...placementOffsets.map((entry) => entry.depth));
    const stepX = Math.max(4, maxWidth + Math.max(0, spacingMm));
    const stepY = Math.max(4, maxDepth + Math.max(0, spacingMm));

    const blockedRects: Rect2D[] = modelsRef.current
      .filter((model) => model.visible)
      .map((model) => {
        const meshPlacement = buildMeshPlacementOffsets(
          { x: model.transform.position.x, y: model.transform.position.y },
          model.geometry.size,
          model.transform,
        );

        const meshRect: Rect2D = {
          minX: model.transform.position.x + meshPlacement.minXOffset,
          maxX: model.transform.position.x + meshPlacement.maxXOffset,
          minY: model.transform.position.y + meshPlacement.minYOffset,
          maxY: model.transform.position.y + meshPlacement.maxYOffset,
        };

        const supportBounds = estimateSupportBoundsForModel(model.id);
        if (!supportBounds) {
          return meshRect;
        }

        return {
          minX: Math.min(meshRect.minX, supportBounds.minX),
          maxX: Math.max(meshRect.maxX, supportBounds.maxX),
          minY: Math.min(meshRect.minY, supportBounds.minY),
          maxY: Math.max(meshRect.maxY, supportBounds.maxY),
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

    const assignedCenters: Array<{ x: number; y: number }> = incomingModels.map((_, entryIndex) => {
      const placement = placementOffsets[entryIndex];

      const makeRectAt = (x: number, y: number): Rect2D => ({
        minX: x + placement.minXOffset,
        maxX: x + placement.maxXOffset,
        minY: y + placement.minYOffset,
        maxY: y + placement.maxYOffset,
      });

      for (const candidate of candidateCenters) {
        const rect = makeRectAt(candidate.x, candidate.y);
        if (!isRectInsidePlate(rect)) continue;
        if (blockedRects.some((blocked) => intersectsRect(rect, blocked))) continue;
        blockedRects.push(rect);
        return { x: candidate.x, y: candidate.y };
      }

      for (const candidate of candidateCenters) {
        const rect = makeRectAt(candidate.x, candidate.y);
        if (blockedRects.some((blocked) => intersectsRect(rect, blocked))) continue;
        blockedRects.push(rect);
        return { x: candidate.x, y: candidate.y };
      }

      const fallbackX = centerX + (maxRing + 2 + blockedRects.length) * stepX;
      const fallbackY = centerY;
      blockedRects.push({
        minX: fallbackX + placement.minXOffset,
        maxX: fallbackX + placement.maxXOffset,
        minY: fallbackY + placement.minYOffset,
        maxY: fallbackY + placement.maxYOffset,
      });
      return { x: fallbackX, y: fallbackY };
    });

    return assignedCenters;
  }, [buildMeshPlacementOffsets, defaultImportCenterXY.x, defaultImportCenterXY.y, estimateSupportBoundsForModel, intersectsRect, isRectInsidePlate, view3dSettings.depthMm, view3dSettings.originMode, view3dSettings.widthMm]);

  const applySceneSnapshot = useCallback((snapshot: SceneSnapshot) => {
    setModels(snapshot.models.map(cloneLoadedModel));
    setActiveModelId(snapshot.activeModelId);
    setSelectedModelIds([...snapshot.selectedModelIds]);

    if (snapshot.supportState) {
      setSupportSnapshot(clonePlainObject(snapshot.supportState));
    }

    if (snapshot.kickstandState) {
      setKickstandSnapshot(clonePlainObject(snapshot.kickstandState));
    }
  }, []);

  useEffect(() => {
    const unregisterSceneModelsHistory = sceneHistory.register(
      SCENE_MODELS_SNAPSHOT_APPLY,
      (payload, direction) => {
        if (!payload?.key) return false;

        const pair = sceneSnapshotRegistry.get(payload.key);
        if (!pair) return false;

        applySceneSnapshot(direction === 'undo' ? pair.before : pair.after);
        return true;
      },
    );

    // Pass-through: the slice marker carries no undo behaviour, but registering
    // it keeps undo/redo moving it between stacks instead of stranding an entry
    // with no handler.
    const unregisterSceneSliced = sceneHistory.register(SCENE_SLICED, () => true);

    return () => {
      unregisterSceneModelsHistory();
      unregisterSceneSliced();
    };
  }, [applySceneSnapshot]);

  const pushSceneSnapshotHistory = useCallback((before: SceneSnapshot, after: SceneSnapshot, description?: string) => {
    const key = storeSceneSnapshotPair({ before, after });
    sceneHistory.push({
      type: SCENE_MODELS_SNAPSHOT_APPLY,
      description,
      payload: { key },
    });
  }, []);

  const cloneGeometryWithBounds = useCallback((source: GeometryWithBounds, options?: { accelerate?: boolean; shared?: boolean }): GeometryWithBounds => {
    if (options?.shared) {
      const sharedSourceKey = String(source.geometry.userData?.resinVolumeSourceKey ?? source.geometry.uuid);
      source.geometry.userData = {
        ...source.geometry.userData,
        resinVolumeSourceKey: sharedSourceKey,
      };

      return {
        geometry: source.geometry,
        bbox: source.bbox.clone(),
        center: source.center.clone(),
        size: source.size.clone(),
        flatteningPlanes: source.flatteningPlanes.map((plane) => ({
          ...plane,
          vertices: plane.vertices.map((vertex) => vertex.clone()),
          normal: plane.normal.clone(),
          center: plane.center.clone(),
        })),
        meshDefects: source.meshDefects,
      };
    }

    const sourceVolumeKey = String(source.geometry.userData?.resinVolumeSourceKey ?? source.geometry.uuid);
    source.geometry.userData = {
      ...source.geometry.userData,
      resinVolumeSourceKey: sourceVolumeKey,
    };

    const clonedGeometry = source.geometry.clone();
    clonedGeometry.userData = {
      ...clonedGeometry.userData,
      resinVolumeSourceKey: sourceVolumeKey,
    };

    if (options?.accelerate ?? true) {
      accelerateGeometry(clonedGeometry);
    }

    return {
      geometry: clonedGeometry,
      bbox: source.bbox.clone(),
      center: source.center.clone(),
      size: source.size.clone(),
      flatteningPlanes: source.flatteningPlanes.map((plane) => ({
        ...plane,
        vertices: plane.vertices.map((vertex) => vertex.clone()),
        normal: plane.normal.clone(),
        center: plane.center.clone(),
      })),
      meshDefects: source.meshDefects,
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

  /**
   * True while deferred post-swap geometry work (BVH acceleration builds,
   * deferred geometry disposals, flattening-plane computation) is queued or
   * running. Lets the UI keep a blocking "finalizing" indicator visible
   * until the app is genuinely responsive again after a large geometry swap
   * — the swap itself resolves long before this work drains.
   */
  const hasPendingBackgroundGeometryWork = useCallback(() => (
    deferredAccelerationQueueRef.current.length > 0
    || deferredAccelerationProcessingRef.current
    || deferredDisposalQueueRef.current.length > 0
    || deferredDisposalProcessingRef.current
    || pendingFlatteningPlanesRef.current > 0
  ), []);

  const processDeferredDisposalQueue = useCallback(() => {
    if (deferredDisposalProcessingRef.current) return;
    if (deferredDisposalQueueRef.current.length === 0) return;

    deferredDisposalProcessingRef.current = true;

    const scheduleNext = (cb: () => void) => {
      if (typeof window !== 'undefined' && typeof (window as any).requestIdleCallback === 'function') {
        (window as any).requestIdleCallback(cb, { timeout: 120 });
      } else {
        setTimeout(cb, 16);
      }
    };

    const step = () => {
      const geometry = deferredDisposalQueueRef.current.shift();
      if (!geometry) {
        deferredDisposalProcessingRef.current = false;
        return;
      }

      try {
        disposeGeometryBVH(geometry);
      } catch {
        // ignore disposal failures
      }
      try {
        geometry.dispose();
      } catch {
        // ignore disposal failures
      }

      if (deferredDisposalQueueRef.current.length === 0) {
        deferredDisposalProcessingRef.current = false;
        return;
      }

      scheduleNext(step);
    };

    scheduleNext(step);
  }, []);

  const deferDisposeGeometries = useCallback((geometries: THREE.BufferGeometry[]) => {
    if (geometries.length === 0) return;

    deferredDisposalQueueRef.current.push(...geometries);
    processDeferredDisposalQueue();
  }, [processDeferredDisposalQueue]);

  const trackRecentOpenedFiles = useCallback((
    files: File[],
    kind: RecentOpenedFileKind,
    options?: { sourcePaths?: Array<string | null | undefined>; fileSizes?: Array<number | undefined> },
  ) => {
    if (files.length === 0) return;

    setRecentOpenedFiles((prev) => {
      const next = [...prev];
      const removedBlobIds: string[] = [];
      const now = Date.now();

      files.forEach((file, index) => {
        const name = file.name?.trim();
        if (!name) return;

        const sourcePath = (typeof options?.sourcePaths?.[index] === 'string' && options.sourcePaths[index]!.trim().length > 0
          ? options.sourcePaths[index]!.trim()
          : undefined);

        // Use the resolved on-disk file size (for path-backed files whose
        // File.size is 0) when available, falling back to the File API size.
        const sizeBytes = options?.fileSizes?.[index] ?? (Number.isFinite(file.size) && file.size > 0 ? file.size : undefined);

        // When a concrete sourcePath is known, use it as the primary dedup key,
        // ignoring sizeBytes. This prevents duplicates when Ctrl+S re-saves the
        // file with an updated thumbnail (changing its size), and ensures mesh
        // files backed by a disk path can be re-opened via the Rust sideload.
        const matchBySourcePath = sourcePath != null;

        const isMatchingEntry = (entry: RecentOpenedFileEntry): boolean => {
          if (entry.kind !== kind || entry.name !== name) return false;
          if (matchBySourcePath) {
            return (entry.sourcePath ?? null) === sourcePath;
          }
          return entry.sizeBytes === sizeBytes
            && (kind !== 'scene' || (entry.sourcePath ?? null) === (sourcePath ?? null));
        };

        const matches = next.filter(isMatchingEntry);

        const existingId = matches.length > 0 ? matches[matches.length - 1].id : uuidv4();
        const duplicateIds = matches.slice(0, -1).map((entry) => entry.id);

        if (matches.length > 0) {
          for (let i = next.length - 1; i >= 0; i -= 1) {
            if (isMatchingEntry(next[i])) {
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
          sourcePath,
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

  // Active model derived state — meshModifiers are hydrated from the
  // external store so model objects never carry the heavy base64 payloads.
  const activeModel = useMemo(() => {
    const model = models.find(m => m.id === activeModelId) || null;
    if (!model) return null;
    const storedModifiers = getStoredMeshModifiers(model.id);
    if (!storedModifiers) return model;
    return { ...model, meshModifiers: storedModifiers };
  }, [models, activeModelId]);

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
    setSelectedModelIds((prev) => (prev.length > 0 ? [] : prev));
    setActiveModelId((prev) => (prev !== null ? null : prev));
  }, []);

  // Clear support selection when switching away from support mode
  useEffect(() => {
    if (mode !== 'support') {
      clearSupportSelection();
    }
  }, [mode]);

  // File handling - support multiple files
  const loadFiles = useCallback(async (filesInput: FileList | File[]) => {
    const files = Array.from(filesInput).filter((file) => getMeshExtension(file.name) !== null);

    if (files.length === 0) {
      return;
    }

    setImportProgress({
      active: true,
      type: 'mesh',
      label: files.length > 1 ? 'Loading Mesh Files…' : 'Loading Mesh…',
      detail: files.length > 1 ? `Preparing 0/${files.length}` : 'Preparing Geometry…',
      progress: null,
    });

    await waitForUiYield();

    // Collect on-disk file paths so recent-file entries can re-open via the
    // Rust sideload (which reads directly from disk) instead of restoring from
    // the empty IndexedDB blob created by createPathBackedStlFile. Also resolve
    // the real file size for path-backed files (file.size is 0 for those).
    const meshSourcePaths: Array<string | undefined> = [];
    const meshFileSizes: Array<number | undefined> = [];
    for (const f of files) {
      const fp = (f as File & { filePath?: string }).filePath;
      meshSourcePaths.push(fp);
      if (fp && f.size === 0) {
        // Path-backed STL — read the actual file size from disk.
        const realSize = await readNativeFileSize(fp).catch(() => null);
        meshFileSizes.push(realSize ?? undefined);
      } else {
        meshFileSizes.push(f.size > 0 ? f.size : undefined);
      }
    }
    trackRecentOpenedFiles(files, 'mesh', { sourcePaths: meshSourcePaths, fileSizes: meshFileSizes });

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

    const stagedNewModels: LoadedModel[] = [];
    const repairReports: MeshRepairReportEntry[] = [];
    const hadActiveModelAtStart = Boolean(activeModelIdRef.current);
    let firstLoadedModelId: string | null = null;

    try {
      // Process sequentially to avoid freezing UI too much
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const url = URL.createObjectURL(file);

        setImportProgress({
          active: true,
          type: 'mesh',
          label: files.length > 1 ? 'Loading Mesh Files…' : 'Loading Mesh…',
          detail: files.length > 1
            ? `${i + 1}/${files.length}: ${file.name}`
            : `Loading ${file.name}`,
          progress: null,
        });

        console.log(`[SceneCollection] Loading ${file.name}... (${(file.size / 1_000_000).toFixed(0)} MB)`);

        try {
          console.log(`[SceneCollection] Loading ${file.name}...`);

          // Shared loading options for all mesh types
          const loadOptions = {
            nativeProcessingMode: getSavedImportDefaultsSettings().autoRepair ? 'auto' : 'none',
            filePath: (file as File & { filePath?: string }).filePath,
            onNativeProcessingStage: (stage: string) => {
              if (stage === 'repairing') {
                setImportProgress({
                  active: true,
                  type: 'mesh',
                  label: files.length > 1 ? 'Auto-Repairing Meshes…' : 'Auto-Repairing Mesh…',
                  detail: files.length > 1
                    ? `${i + 1}/${files.length}: ${file.name}`
                    : `Auto-Repairing ${file.name}`,
                  progress: null,
                });
                return;
              }

              if (stage === 'analyzing') {
                setImportProgress({
                  active: true,
                  type: 'mesh',
                  label: files.length > 1 ? 'Inspecting Meshes…' : 'Inspecting Mesh…',
                  detail: files.length > 1
                    ? `${i + 1}/${files.length}: ${file.name}`
                    : `Inspecting ${file.name}`,
                  progress: null,
                });
                return;
              }

              if (stage === 'classifying') {
                setImportProgress({
                  active: true,
                  type: 'mesh',
                  label: files.length > 1 ? 'Classifying Mesh Shells…' : 'Classifying Mesh Shell…',
                  detail: files.length > 1
                    ? `${i + 1}/${files.length}: ${file.name}`
                    : `Classifying ${file.name}`,
                  progress: null,
                });
              }
            },
            onConfirmHeavyRepair: async (analysis: MeshAnalysisJson) => {
              const choice = await requestMeshRepairConfirmation({ fileName: file.name, analysis });
              if (choice === 'cancel_import') {
                throw new Error('MESH_IMPORT_CANCELLED_BY_USER');
              }
              if (choice === 'repair') {
                setImportProgress({
                  active: true,
                  type: 'mesh',
                  label: files.length > 1 ? 'Auto-Repairing Meshes…' : 'Auto-Repairing Mesh…',
                  detail: files.length > 1
                    ? `${i + 1}/${files.length}: ${file.name}`
                    : `Auto-Repairing ${file.name}`,
                  progress: null,
                });
              }
              return choice === 'repair';
            },
          } satisfies ProcessGeometryOptions;

          // Determine if this is a 3MF file for multi-body import
          const is3mf = file.name.toLowerCase().endsWith('.3mf');

          const color = preferredMeshColor;

          if (is3mf) {
            // Use the merged+split loader: returns a single merged geometry
            // (preserving body positions) and pre-processed individual bodies
            // for instant "Split to Bodies".
            const { merged, splitBodies } = await load3mfGeometryMergedWithSplitData(url, loadOptions);

            const bbox = merged.bbox;
            const center = merged.center;
            const heightOffset = center.z - bbox.min.z;
            const initialZ = autoLift ? heightOffset + liftDistance : heightOffset;

            const model: LoadedModel = {
              id: uuidv4(),
              name: file.name,
              fileUrl: url,
              fileSizeBytes: file.size,
              sourcePath: (file as File & { filePath?: string }).filePath,
              geometry: merged,
              splitBodies: splitBodies.length > 1 ? splitBodies : undefined,
              transform: {
                position: new THREE.Vector3(defaultImportCenterXY.x, defaultImportCenterXY.y, initialZ),
                rotation: new THREE.Euler(0, 0, 0),
                scale: new THREE.Vector3(1, 1, 1),
              },
              visible: true,
              color,
              polygonCount: merged.nativePreview?.originalTriangleCount
                ?? merged.geometry.getAttribute('position').count / 3,
            };

            const assignedCenter = findFreeSpotCentersForModels([...stagedNewModels, model], 5).at(-1);
            if (assignedCenter) {
              model.transform.position.set(assignedCenter.x, assignedCenter.y, model.transform.position.z);
            }

            stagedNewModels.push(model);
            if (!firstLoadedModelId) firstLoadedModelId = model.id;
            setModels((prev) => [...prev, model]);

            if (merged.meshDefects?.nativeRepairReport) {
              repairReports.push({
                id: model.id,
                modelName: file.name,
                report: merged.meshDefects.nativeRepairReport,
              });
            }
          } else {
            const geom = await loadMeshGeometry(url, file.name, loadOptions);
            const bbox = geom.bbox;
            const center = geom.center;
            const heightOffset = center.z - bbox.min.z;
            const initialZ = autoLift ? heightOffset + liftDistance : heightOffset;

            const model: LoadedModel = {
              id: uuidv4(),
              name: file.name,
              fileUrl: url,
              fileSizeBytes: file.size,
              sourcePath: (file as File & { filePath?: string }).filePath,
              geometry: geom,
              transform: {
                position: new THREE.Vector3(defaultImportCenterXY.x, defaultImportCenterXY.y, initialZ),
                rotation: new THREE.Euler(0, 0, 0),
                scale: new THREE.Vector3(1, 1, 1),
              },
              visible: true,
              color,
              polygonCount: geom.nativePreview?.originalTriangleCount
                ?? geom.geometry.getAttribute('position').count / 3,
            };

            const assignedCenter = findFreeSpotCentersForModels([...stagedNewModels, model], 5).at(-1);
            if (assignedCenter) {
              model.transform.position.set(assignedCenter.x, assignedCenter.y, model.transform.position.z);
            }

            stagedNewModels.push(model);
            if (!firstLoadedModelId) firstLoadedModelId = model.id;
            setModels((prev) => [...prev, model]);

            if (geom.meshDefects?.nativeRepairReport) {
              repairReports.push({
                id: model.id,
                modelName: file.name,
                report: geom.meshDefects.nativeRepairReport,
              });
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === 'MESH_IMPORT_CANCELLED_BY_USER') {
            console.log(`[SceneCollection] Import cancelled for ${file.name}`);
            URL.revokeObjectURL(url); // Cleanup if cancelled
            continue;
          } else {
            console.error(`Failed to load ${file.name}`, err);
          }
          URL.revokeObjectURL(url); // Cleanup if failed
        }

        setImportProgress({
          active: true,
          type: 'mesh',
          label: files.length > 1 ? 'Loading Mesh Files…' : 'Loading Mesh…',
          detail: files.length > 1
            ? `${Math.min(i + 1, files.length)}/${files.length} processed`
            : 'Finalizing Model…',
          progress: null,
        });
      }

      if (firstLoadedModelId) {
        const importedIds = stagedNewModels.map((model) => model.id);

        if (importedIds.length > 1) {
          // For multi-file mesh imports, select all imported models so tinting and
          // immediate transform actions apply uniformly.
          setActiveModelId(importedIds[0]);
          setSelectedModelIds(importedIds);
        } else if (!hadActiveModelAtStart) {
          // Preserve prior single-file behavior when plate was empty.
          setActiveModelId(firstLoadedModelId);
          setSelectedModelIds([firstLoadedModelId]);
        }

        if (repairReports.length > 0) {
          const attentionReports = repairReports.filter(({ report }) => repairReportNeedsAttention(report));
          if (attentionReports.length > 0) {
            const anyResidual = attentionReports.some(({ report }) => !report.fully_repaired);
            setPendingMeshRepairReports(attentionReports);
            emitSceneImportReport(
              'Auto Repaired - Click for Details',
              anyResidual ? 'warning' : 'success',
              { durationMs: 10_000, clickAction: 'openMeshRepairReport' },
            );
          } else {
            setPendingMeshRepairReports([]);
          }
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
  }, [defaultImportCenterXY.x, defaultImportCenterXY.y, emitSceneImportReport, findFreeSpotCentersForModels, getMeshExtension, requestMeshRepairConfirmation, trackRecentOpenedFiles, waitForUiYield]);

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const files = Array.from(e.target.files);
      void loadFiles(files);
      e.target.value = ''; // Reset input
    }
  }, [loadFiles]);

  // Model Management
  // Updates a model's transform without running the support-transform pipeline
  // or pushing history. Callers that need supports moved must do that themselves
  // (e.g. mirror, which reflects supports about the model bbox center via
  // `transformSupportsForModel` rather than through a delta-matrix).
  const setModelTransformRaw = useCallback((id: string, transform: ModelTransform) => {
    setModels((prev) => prev.map((m) => (m.id === id ? { ...m, transform } : m)));
  }, []);

  const updateModelTransform = useCallback((id: string, transform: ModelTransform, previousTransformOverride?: ModelTransform) => {
    const currentModel = modelsRef.current.find((m) => m.id === id);
    if (!currentModel) {
      return {
        updated: false,
        supportsChanged: false,
        kickstandsChanged: false,
      };
    }

    if (previousTransformOverride && modelsRef.current.length === 1) {
      reassignAllSupportModelIds(id);
    }

    const beforeTransform = previousTransformOverride ?? currentModel.transform;
    if (transformsEqual(beforeTransform, transform)) {
      return {
        updated: false,
        supportsChanged: false,
        kickstandsChanged: false,
      };
    }

    let supportsChanged = false;
    let kickstandsChanged = false;

    let transformCommit = {
      supportsChanged: false,
      kickstandsChanged: false,
    };

    if (previousTransformOverride && modelsRef.current.length === 1) {
      transformCommit = transformAllSupportsForSingleModel(beforeTransform, transform);
    } else {
      transformCommit = transformSupportsForModel(id, beforeTransform, transform);
    }

    supportsChanged = supportsChanged || transformCommit.supportsChanged;
    kickstandsChanged = kickstandsChanged || transformCommit.kickstandsChanged;

    const updateMap = new Map<string, ModelTransform>();
    updateMap.set(id, transform);

    if (currentModel.linkGroupId) {
      const linkGroupId = currentModel.linkGroupId;
      const deltaPos = transform.position.clone().sub(beforeTransform.position);
      const deltaRotX = transform.rotation.x - beforeTransform.rotation.x;
      const deltaRotY = transform.rotation.y - beforeTransform.rotation.y;
      const deltaRotZ = transform.rotation.z - beforeTransform.rotation.z;
      const deltaScale = transform.scale.clone().sub(beforeTransform.scale);

      const peerModels = modelsRef.current.filter((m) => m.linkGroupId === linkGroupId && m.id !== id);
      for (const peer of peerModels) {
        const peerBefore = peer.transform;
        const peerNextPos = peerBefore.position.clone().add(deltaPos);
        const peerNextRot = eulerFromGlobalEuler({
          x: peerBefore.rotation.x + deltaRotX,
          y: peerBefore.rotation.y + deltaRotY,
          z: peerBefore.rotation.z + deltaRotZ,
        });
        const peerNextScale = peerBefore.scale.clone().add(deltaScale);
        const peerNextTransform: ModelTransform = {
          position: peerNextPos,
          rotation: peerNextRot,
          scale: peerNextScale,
        };
        updateMap.set(peer.id, peerNextTransform);

        const peerCommit = transformSupportsForModel(peer.id, peerBefore, peerNextTransform);
        supportsChanged = supportsChanged || peerCommit.supportsChanged;
        kickstandsChanged = kickstandsChanged || peerCommit.kickstandsChanged;
      }
    }

    setModels(prev => prev.map(m => {
      const nextTransform = updateMap.get(m.id);
      return nextTransform ? { ...m, transform: nextTransform } : m;
    }));

    return {
      updated: true,
      supportsChanged,
      kickstandsChanged,
    };
  }, []);

  const commitModelTransformHistory = useCallback((
    id: string,
    beforeTransform: ModelTransform,
    afterTransform: ModelTransform,
    description?: string,
    supportSnapshotOptions?: TransformHistorySupportSnapshotOptions,
  ) => {
    if (transformsEqual(beforeTransform, afterTransform)) return false;

    const currentModels = modelsRef.current;
    const currentActiveModelId = activeModelIdRef.current;
    const currentSelectedModelIds = selectedModelIdsRef.current;

    const targetModel = currentModels.find((m) => m.id === id);
    if (!targetModel) return false;

    const linkGroupId = targetModel.linkGroupId;
    const deltaPos = afterTransform.position.clone().sub(beforeTransform.position);
    const deltaRotX = afterTransform.rotation.x - beforeTransform.rotation.x;
    const deltaRotY = afterTransform.rotation.y - beforeTransform.rotation.y;
    const deltaRotZ = afterTransform.rotation.z - beforeTransform.rotation.z;
    const deltaScale = afterTransform.scale.clone().sub(beforeTransform.scale);

    const beforeModels = currentModels.map((m) => {
      if (m.id === id) {
        return { ...m, transform: cloneTransform(beforeTransform) };
      }
      if (linkGroupId && m.linkGroupId === linkGroupId) {
        const peerBeforePos = m.transform.position.clone().sub(deltaPos);
        const peerBeforeRot = eulerFromGlobalEuler({
          x: m.transform.rotation.x - deltaRotX,
          y: m.transform.rotation.y - deltaRotY,
          z: m.transform.rotation.z - deltaRotZ,
        });
        const peerBeforeScale = m.transform.scale.clone().sub(deltaScale);
        return {
          ...m,
          transform: { position: peerBeforePos, rotation: peerBeforeRot, scale: peerBeforeScale },
        };
      }
      return m;
    });

    const afterModels = currentModels.map((m) => {
      if (m.id === id) {
        return { ...m, transform: cloneTransform(afterTransform) };
      }
      return m;
    });

    const includeSupportByOption = supportSnapshotOptions?.includeSupportState === true
      || !!supportSnapshotOptions?.supportBefore
      || !!supportSnapshotOptions?.supportAfter
      || !!supportSnapshotOptions?.kickstandBefore
      || !!supportSnapshotOptions?.kickstandAfter;

    const includeSupportByState = (() => {
      const supportStateNow = getSnapshot();
      const kickstandStateNow = getKickstandSnapshot();
      return hasSupportsOrKickstandsForModel(id, supportStateNow, kickstandStateNow);
    })();

    const includeSupportHistory = includeSupportByOption || includeSupportByState;

    const before = captureSceneSnapshot(beforeModels, currentActiveModelId, currentSelectedModelIds, {
      includeSupportState: includeSupportHistory,
      supportStateOverride: supportSnapshotOptions?.supportBefore,
      kickstandStateOverride: supportSnapshotOptions?.kickstandBefore,
    });
    const after = captureSceneSnapshot(afterModels, currentActiveModelId, currentSelectedModelIds, {
      includeSupportState: includeSupportHistory,
      supportStateOverride: supportSnapshotOptions?.supportAfter,
      kickstandStateOverride: supportSnapshotOptions?.kickstandAfter,
    });
    const targetModelName = targetModel.name ?? id;
    pushSceneSnapshotHistory(before, after, description ?? `Transform Model ${targetModelName}`);
    return true;
  }, [pushSceneSnapshotHistory]);

  const updateModelTransforms = useCallback((updates: Array<{ id: string; transform: ModelTransform }>) => {
    if (updates.length === 0) {
      return {
        updated: false,
        supportsChanged: false,
        kickstandsChanged: false,
      };
    }

    const currentModels = modelsRef.current;
    const currentActiveModelId = activeModelIdRef.current;
    const currentSelectedModelIds = selectedModelIdsRef.current;

    const updateMap = new Map<string, ModelTransform>();
    updates.forEach((entry) => updateMap.set(entry.id, entry.transform));

    updates.forEach((entry) => {
      const model = currentModels.find((m) => m.id === entry.id);
      if (model?.linkGroupId) {
        const beforeTransform = model.transform;
        const transform = entry.transform;
        const deltaPos = transform.position.clone().sub(beforeTransform.position);
        const deltaRotX = transform.rotation.x - beforeTransform.rotation.x;
        const deltaRotY = transform.rotation.y - beforeTransform.rotation.y;
        const deltaRotZ = transform.rotation.z - beforeTransform.rotation.z;
        const deltaScale = transform.scale.clone().sub(beforeTransform.scale);

        const peers = currentModels.filter((m) => m.linkGroupId === model.linkGroupId && m.id !== entry.id);
        for (const peer of peers) {
          if (!updateMap.has(peer.id)) {
            const peerBefore = peer.transform;
            const peerNextPos = peerBefore.position.clone().add(deltaPos);
            const peerNextRot = eulerFromGlobalEuler({
              x: peerBefore.rotation.x + deltaRotX,
              y: peerBefore.rotation.y + deltaRotY,
              z: peerBefore.rotation.z + deltaRotZ,
            });
            const peerNextScale = peerBefore.scale.clone().add(deltaScale);
            updateMap.set(peer.id, {
              position: peerNextPos,
              rotation: peerNextRot,
              scale: peerNextScale,
            });
          }
        }
      }
    });

    const supportStateBefore = getSnapshot();
    const kickstandStateBefore = getKickstandSnapshot();
    const allUpdatedIds = Array.from(updateMap.keys());
    const includeSupportHistory = allUpdatedIds.some((id) => hasSupportsOrKickstandsForModel(id, supportStateBefore, kickstandStateBefore));

    const before = captureSceneSnapshot(currentModels, currentActiveModelId, currentSelectedModelIds, {
      includeSupportState: includeSupportHistory,
      supportStateOverride: includeSupportHistory ? supportStateBefore : undefined,
      kickstandStateOverride: includeSupportHistory ? kickstandStateBefore : undefined,
    });

    let supportsChanged = false;
    let kickstandsChanged = false;
    let updated = false;
    updateMap.forEach((nextTransform, id) => {
      const currentModel = currentModels.find((model) => model.id === id);
      if (!currentModel) return;
      if (transformsEqual(currentModel.transform, nextTransform)) return;
      const commit = transformSupportsForModel(id, currentModel.transform, nextTransform);
      supportsChanged = supportsChanged || commit.supportsChanged;
      kickstandsChanged = kickstandsChanged || commit.kickstandsChanged;
      updated = true;
    });

    if (!updated) {
      return {
        updated: false,
        supportsChanged,
        kickstandsChanged,
      };
    }

    const nextModels = currentModels.map((m) => {
      const nextTransform = updateMap.get(m.id);
      return nextTransform ? { ...m, transform: nextTransform } : m;
    });

    setModels(nextModels);

    const supportStateAfter = includeSupportHistory ? getSnapshot() : undefined;
    const kickstandStateAfter = includeSupportHistory ? getKickstandSnapshot() : undefined;
    const after = captureSceneSnapshot(nextModels, currentActiveModelId, currentSelectedModelIds, {
      includeSupportState: includeSupportHistory,
      supportStateOverride: supportStateAfter,
      kickstandStateOverride: kickstandStateAfter,
    });
    pushSceneSnapshotHistory(before, after, updates.length === 1 ? 'Update Model Transform' : 'Update Model Transforms');

    return {
      updated,
      supportsChanged,
      kickstandsChanged,
    };
  }, [pushSceneSnapshotHistory]);

  const replaceModelGeometry = useCallback((
    id: string,
    nextBufferGeometry: THREE.BufferGeometry,
    historyDescription: string,
    options?: { includeSupportState?: boolean; deferPostProcessing?: boolean },
  ) => {
    const currentModels = modelsRef.current;
    const currentActiveModelId = activeModelIdRef.current;
    const currentSelectedModelIds = selectedModelIdsRef.current;
    const target = currentModels.find((m) => m.id === id);
    if (!target) return false;

    if (!nextBufferGeometry.boundingBox) nextBufferGeometry.computeBoundingBox();
    const bbox = nextBufferGeometry.boundingBox
      ? nextBufferGeometry.boundingBox.clone()
      : new THREE.Box3();
    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());

    // Recompute edge geometry for the Higher Contrast Model Edges overlay when
    // the geometry has changed (e.g. after hole punch / hollowing).  Compute it
    // only if the old geometry had one (i.e. the user has edge lines enabled),
    // and skip during deferred post-processing to avoid blocking the UI.
    // Skip for very large meshes — EdgesGeometry uses `for...in` over a hash map
    // of unique edges and V8 throws "Too many properties to enumerate" beyond ~2M entries.
    const hadEdgeGeometry = !!target.geometry.edgeGeometry;
    let nextEdgeGeometry: THREE.EdgesGeometry | undefined;
    if (hadEdgeGeometry && !options?.deferPostProcessing) {
      const triCount = (nextBufferGeometry.getIndex()?.count ?? nextBufferGeometry.getAttribute('position')?.count ?? 0) / 3;
      if (triCount < 800_000) {
        try {
          nextEdgeGeometry = new THREE.EdgesGeometry(nextBufferGeometry, 30);
        } catch (edgeError) {
          console.warn(
            '[SceneCollection] Edge geometry recompute failed for large mesh',
            edgeError,
          );
        }
      } else {
        console.warn(
          `[SceneCollection] Skipping edge geometry recompute for large mesh (${Math.round(triCount).toLocaleString()} triangles).`,
        );
      }
    } else {
      nextEdgeGeometry = target.geometry.edgeGeometry;
    }

    const nextGeometry: GeometryWithBounds = {
      geometry: nextBufferGeometry,
      bbox,
      center,
      size,
      flatteningPlanes: target.geometry.flatteningPlanes,
      ...(nextEdgeGeometry ? { edgeGeometry: nextEdgeGeometry } : {}),
    };

    if (!options?.deferPostProcessing) {
      deferAccelerateGeometry([nextGeometry]);

      const scheduleIdle = (cb: () => void) => {
        if (typeof window !== 'undefined' && typeof (window as any).requestIdleCallback === 'function') {
          (window as any).requestIdleCallback(cb, { timeout: 250 });
        } else {
          setTimeout(cb, 16);
        }
      };
      pendingFlatteningPlanesRef.current += 1;
      scheduleIdle(() => {
        try {
          const planes = computeFlatteningPlanes(nextBufferGeometry);
          nextGeometry.flatteningPlanes = planes;
          setModels((prev) => prev.map((m) => (
            m.id === id && m.geometry.geometry === nextBufferGeometry
              ? { ...m, geometry: { ...m.geometry, flatteningPlanes: planes } }
              : m
          )));
        } finally {
          pendingFlatteningPlanesRef.current = Math.max(0, pendingFlatteningPlanesRef.current - 1);
        }
      });
    }

    const polygonCount = (() => {
      const idx = nextBufferGeometry.getIndex();
      if (idx) return Math.floor(idx.count / 3);
      const pos = nextBufferGeometry.getAttribute('position');
      return pos ? Math.floor(pos.count / 3) : target.polygonCount;
    })();

    const includeSupportHistory = options?.includeSupportState
      ?? hasSupportsOrKickstandsForModel(id, getSnapshot(), getKickstandSnapshot());

    const before = captureSceneSnapshot(currentModels, currentActiveModelId, currentSelectedModelIds, {
      includeSupportState: includeSupportHistory,
    });

    const nextModels = currentModels.map((m) => (
      m.id === id
        ? {
            ...m,
            geometry: nextGeometry,
            polygonCount,
            isSupportGeometry: target.isSupportGeometry,
            linkGroupId: target.linkGroupId,
          }
        : m
    ));
    setModels(nextModels);

    const after = captureSceneSnapshot(nextModels, currentActiveModelId, currentSelectedModelIds, {
      includeSupportState: includeSupportHistory,
    });
    // COW chunk-store bake (Ph0.1 sub-phase C3). This is the VERIFIED sole
    // finalization point for hollow, hole-punch, mirror and repair, so baking
    // here moves the encode+SHA+zlib-6 onto the operation the user is already
    // waiting for and off the next autosave tick.
    //
    // Fire-and-forget on purpose: the geometry SIGNATURE is the authority, so if
    // this bake never lands the next tick simply bakes lazily instead. It can
    // cost a slow tick; it can never write stale geometry.
    void scheduleModelChunkBake(nextModels.find((m) => m.id === id));

    return true;
  }, [pushSceneSnapshotHistory, deferAccelerateGeometry]);

  /**
   * Commits a brand-new model built from an arbitrary BufferGeometry, inheriting
   * transform/color/visibility from a base model. Used by the Organic Cut tool
   * to add the second split part (part B) as an independent model. Returns the
   * new model id, or null on failure.
   */
  const addModelFromGeometry = useCallback((
    bufferGeometry: THREE.BufferGeometry,
    baseModelId: string,
    name: string,
    historyDescription: string,
  ): string | null => {
    const currentModels = modelsRef.current;
    const base = currentModels.find((m) => m.id === baseModelId);
    if (!base) return null;

    if (!bufferGeometry.boundingBox) bufferGeometry.computeBoundingBox();
    const bbox = bufferGeometry.boundingBox ? bufferGeometry.boundingBox.clone() : new THREE.Box3();
    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());

    accelerateGeometry(bufferGeometry);

    const geometry: GeometryWithBounds = {
      geometry: bufferGeometry,
      bbox,
      center,
      size,
      flatteningPlanes: [],
    };

    const polygonCount = (() => {
      const idx = bufferGeometry.getIndex();
      if (idx) return Math.floor(idx.count / 3);
      const pos = bufferGeometry.getAttribute('position');
      return pos ? Math.floor(pos.count / 3) : 0;
    })();

    const id = uuidv4();
    const newModel: LoadedModel = {
      id,
      name,
      groupId: base.groupId,
      groupName: base.groupName,
      fileUrl: '',
      fileSizeBytes: base.fileSizeBytes,
      geometry,
      transform: {
        position: base.transform.position.clone(),
        rotation: base.transform.rotation.clone(),
        scale: base.transform.scale.clone(),
      },
      visible: true,
      color: base.color,
      polygonCount,
      meshModifiers: base.meshModifiers ? clonePlainObject(base.meshModifiers) : undefined,
    };

    const before = captureSceneSnapshot(currentModels, activeModelIdRef.current, selectedModelIdsRef.current, { includeSupportState: false });
    const nextModels = [...currentModels, newModel];
    setModels(nextModels);

    // Defer post-processing (flattening planes) like replaceModelGeometry does.
    const scheduleIdle = (cb: () => void) => {
      if (typeof window !== 'undefined' && typeof (window as any).requestIdleCallback === 'function') {
        (window as any).requestIdleCallback(cb, { timeout: 250 });
      } else {
        setTimeout(cb, 16);
      }
    };
    scheduleIdle(() => {
      const planes = computeFlatteningPlanes(bufferGeometry);
      setModels((prev) => prev.map((m) => (
        m.id === id ? { ...m, geometry: { ...m.geometry, flatteningPlanes: planes } } : m
      )));
    });

    const after = captureSceneSnapshot(nextModels, activeModelIdRef.current, selectedModelIdsRef.current, { includeSupportState: false });
    pushSceneSnapshotHistory(before, after, historyDescription);

    return id;
  }, [pushSceneSnapshotHistory]);

  /**
   * Atomically splits one model into two: replaces the source model's geometry
   * with `partAGeometry`, and appends `partBGeometry` as a new sibling model.
   *
   * This MUST be a single state update + single history entry. Doing it as two
   * separate calls (replaceModelGeometry + addModelFromGeometry) races on the
   * stale `modelsRef`/history snapshots and loses one of the pieces. Used by the
   * Organic Cut tool. Returns the new (part B) model id, or null on failure.
   */
  const splitModelIntoParts = useCallback((
    sourceId: string,
    partGeometries: THREE.BufferGeometry[],
    historyDescription: string,
  ): string[] | null => {
    const currentModels = modelsRef.current;
    const source = currentModels.find((m) => m.id === sourceId);
    if (!source || partGeometries.length === 0) return null;

    // KEEP EVERY PART EXACTLY WHERE IT WAS CUT (nothing moves in 3D space).
    //
    // The render layer (StlMesh) draws each model's mesh at `-geometryBboxCenter`
    // inside the model's transform group, so a vertex renders at
    //     world = R · S · (vertex - partCenter) + partPosition
    // (R = rotation, S = scale). For the original model it was
    //     world = R · S · (vertex - sourceCenter) + sourcePosition.
    // Since the cut parts share the SAME vertices as the source (same space), to
    // keep every vertex at its original world spot we must satisfy
    //     R·S·(v - partCenter) + partPosition = R·S·(v - sourceCenter) + sourcePos
    // ⇒ partPosition = sourcePosition + R·S·(partCenter - sourceCenter).
    //
    // So we DON'T move the geometry (translating vertices would shift them by
    // R·S·delta under any rotation — the bug that made parts jump). Instead we
    // leave each part's bbox where it is and COMPENSATE its transform.position by
    // the rotated+scaled center delta. Vertices stay put; the part lands exactly
    // where it was cut, for any source rotation/scale.
    const sourceGeom = source.geometry.geometry;
    if (!sourceGeom.boundingBox) sourceGeom.computeBoundingBox();
    const sourceCenter = sourceGeom.boundingBox
      ? sourceGeom.boundingBox.getCenter(new THREE.Vector3())
      : source.geometry.center.clone();

    const srcQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(source.transform.rotation.x, source.transform.rotation.y, source.transform.rotation.z),
    );
    const srcScale = source.transform.scale;

    // Position that keeps `partCenter` at the same world spot the source frame put
    // it: sourcePosition + R·S·(partCenter - sourceCenter).
    const positionForPart = (partCenter: THREE.Vector3): THREE.Vector3 => {
      const d = partCenter.clone().sub(sourceCenter);
      d.multiply(srcScale); // component-wise scale
      d.applyQuaternion(srcQuat); // then rotate
      return source.transform.position.clone().add(d);
    };

    const buildBounds = (g: THREE.BufferGeometry): GeometryWithBounds => {
      if (!g.boundingBox) g.computeBoundingBox();
      const bbox = g.boundingBox ? g.boundingBox.clone() : new THREE.Box3();
      const center = bbox.getCenter(new THREE.Vector3());
      const size = bbox.getSize(new THREE.Vector3());
      accelerateGeometry(g);
      return { geometry: g, bbox, center, size, flatteningPlanes: [] };
    };

    const polyCount = (g: THREE.BufferGeometry): number => {
      const idx = g.getIndex();
      if (idx) return Math.floor(idx.count / 3);
      const pos = g.getAttribute('position');
      return pos ? Math.floor(pos.count / 3) : 0;
    };

    // The source becomes the FIRST part; every other part is appended as a new
    // model. (A multi-loop cut can free several pieces, so there may be >2 parts.)
    const built = partGeometries.map(buildBounds);
    const extraIds = built.slice(1).map(() => uuidv4());

    const before = captureSceneSnapshot(currentModels, activeModelIdRef.current, selectedModelIdsRef.current, { includeSupportState: false });

    const part0 = built[0];
    const part0Position = positionForPart(part0.center);

    const extraModels: LoadedModel[] = built.slice(1).map((pg, i) => ({
      id: extraIds[i],
      // Number the pieces when there are several ("Cut 2", "Cut 3"); keep the plain
      // "Cut" name for the usual two-part split.
      name: built.length > 2 ? `${source.name} Cut ${i + 2}` : `${source.name} Cut`,
      groupId: source.groupId,
      groupName: source.groupName,
      fileUrl: '',
      fileSizeBytes: source.fileSizeBytes,
      geometry: pg,
      transform: {
        position: positionForPart(pg.center),
        rotation: source.transform.rotation.clone(),
        scale: source.transform.scale.clone(),
      },
      visible: true,
      color: source.color,
      polygonCount: polyCount(pg.geometry),
      meshModifiers: source.meshModifiers ? clonePlainObject(source.meshModifiers) : undefined,
    }));

    // ONE atomic update: source becomes part 0 (geometry swapped + position
    // compensated so it doesn't shift), the rest are appended.
    const nextModels = [
      ...currentModels.map((m) => (
        m.id === sourceId
          ? {
              ...m,
              geometry: part0,
              polygonCount: polyCount(part0.geometry),
              transform: {
                position: part0Position,
                rotation: m.transform.rotation.clone(),
                scale: m.transform.scale.clone(),
              },
            }
          : m
      )),
      ...extraModels,
    ];
    setModels(nextModels);

    // Defer flattening-plane computation for every new geometry.
    const scheduleIdle = (cb: () => void) => {
      if (typeof window !== 'undefined' && typeof (window as any).requestIdleCallback === 'function') {
        (window as any).requestIdleCallback(cb, { timeout: 250 });
      } else {
        setTimeout(cb, 16);
      }
    };
    scheduleIdle(() => {
      const planes = built.map((b) => computeFlatteningPlanes(b.geometry));
      setModels((prev) => prev.map((m) => {
        if (m.id === sourceId) return { ...m, geometry: { ...m.geometry, flatteningPlanes: planes[0] } };
        const ei = extraIds.indexOf(m.id);
        if (ei >= 0) return { ...m, geometry: { ...m.geometry, flatteningPlanes: planes[ei + 1] } };
        return m;
      }));
    });

    const after = captureSceneSnapshot(nextModels, activeModelIdRef.current, selectedModelIdsRef.current, { includeSupportState: false });
    pushSceneSnapshotHistory(before, after, historyDescription);

    return extraIds;
  }, [pushSceneSnapshotHistory]);

  const finalizeModelGeometryPostProcessing = useCallback((id: string) => {
    const target = modelsRef.current.find((m) => m.id === id);
    if (!target) return;
    const geom = target.geometry.geometry;

    deferAccelerateGeometry([target.geometry]);

    const scheduleIdle = (cb: () => void) => {
      if (typeof window !== 'undefined' && typeof (window as any).requestIdleCallback === 'function') {
        (window as any).requestIdleCallback(cb, { timeout: 250 });
      } else {
        setTimeout(cb, 16);
      }
    };
    pendingFlatteningPlanesRef.current += 1;
    scheduleIdle(() => {
      try {
        const planes = computeFlatteningPlanes(geom);
        setModels((prev) => prev.map((m) => (
          m.id === id && m.geometry.geometry === geom
            ? { ...m, geometry: { ...m.geometry, flatteningPlanes: planes } }
            : m
        )));
      } finally {
        pendingFlatteningPlanesRef.current = Math.max(0, pendingFlatteningPlanesRef.current - 1);
      }
    });
  }, [deferAccelerateGeometry]);

  const setModelVisibility = useCallback((id: string, visible: boolean) => {
    setModels(prev => prev.map(m =>
      m.id === id ? { ...m, visible } : m
    ));
  }, []);

  const setModelMeshModifiers = useCallback((id: string, meshModifiers: ModelMeshModifiers | undefined) => {
    // Store externally — model objects never carry meshModifiers directly.
    storeModelMeshModifiers(id, meshModifiers);
    // Still trigger a shallow React update so consumers that derive from
    // the store can re-render.
    setModels(prev => prev.map((model) => (
      model.id === id
        ? { ...model }
        : model
    )));
  }, []);

  const setModelManualZMoveOverride = useCallback((id: string, manualZMoveOverride: boolean) => {
    setModels(prev => prev.map((model) => (
      model.id === id
        ? (
            model.manualZMoveOverride === manualZMoveOverride
              ? model
              : { ...model, manualZMoveOverride }
          )
        : model
    )));
  }, []);

  const renameModel = useCallback((id: string, name: string) => {
    setModels(prev => prev.map(m =>
      m.id === id ? { ...m, name } : m
    ));
  }, []);

  const groupModels = useCallback((modelIds: string[], groupName?: string) => {
    const currentModels = modelsRef.current;
    const currentActiveModelId = activeModelIdRef.current;
    const currentSelectedModelIds = selectedModelIdsRef.current;
    const before = captureSceneSnapshot(currentModels, currentActiveModelId, currentSelectedModelIds);
    const transition = applyModelGrouping({
      models: currentModels,
      modelIds,
      groupId: `group-${uuidv4()}`,
      groupName,
      activeModelId: currentActiveModelId,
      selectedModelIds: currentSelectedModelIds,
    });

    if (!transition.changed) return transition.groupId ?? null;

    setModels(transition.models);
    setActiveModelId(transition.activeModelId);
    setSelectedModelIds(transition.selectedModelIds);

    const after = captureSceneSnapshot(transition.models, transition.activeModelId, transition.selectedModelIds);
    pushSceneSnapshotHistory(before, after, transition.description);
    return transition.groupId ?? null;
  }, [pushSceneSnapshotHistory]);

  const ungroupModels = useCallback((modelIds: string[]) => {
    const currentModels = modelsRef.current;
    const currentActiveModelId = activeModelIdRef.current;
    const currentSelectedModelIds = selectedModelIdsRef.current;
    const before = captureSceneSnapshot(currentModels, currentActiveModelId, currentSelectedModelIds);
    const transition = applyModelUngrouping({
      models: currentModels,
      modelIds,
      activeModelId: currentActiveModelId,
      selectedModelIds: currentSelectedModelIds,
    });

    if (!transition.changed) return;

    setModels(transition.models);
    const after = captureSceneSnapshot(transition.models, transition.activeModelId, transition.selectedModelIds);
    pushSceneSnapshotHistory(before, after, transition.description);
  }, [pushSceneSnapshotHistory]);

  const ungroupGroup = useCallback((groupId: string) => {
    const currentModels = modelsRef.current;
    const currentActiveModelId = activeModelIdRef.current;
    const currentSelectedModelIds = selectedModelIdsRef.current;
    const before = captureSceneSnapshot(currentModels, currentActiveModelId, currentSelectedModelIds);
    const transition = applyModelGroupUngrouping({
      models: currentModels,
      groupId,
      activeModelId: currentActiveModelId,
      selectedModelIds: currentSelectedModelIds,
    });

    if (!transition.changed) return;

    setModels(transition.models);
    const after = captureSceneSnapshot(transition.models, transition.activeModelId, transition.selectedModelIds);
    pushSceneSnapshotHistory(before, after, transition.description);
  }, [pushSceneSnapshotHistory]);

  /** Splits a multi-body 3MF model into independent models using the
   *  pre-processed `splitBodies` geometries. Instant — no reprocessing. */
  const splitImportGroup = useCallback((modelId: string) => {
    const source = modelsRef.current.find((m) => m.id === modelId);
    if (!source?.splitBodies || source.splitBodies.length < 2) return;

    const newModels: LoadedModel[] = source.splitBodies.map((bodyGeom, i) => ({
      id: uuidv4(),
      name: `${source.name.replace(/\.3mf$/i, '')} (${i + 1})`,
      fileUrl: source.fileUrl,
      fileSizeBytes: source.fileSizeBytes,
      sourcePath: source.sourcePath,
      geometry: bodyGeom,
      transform: {
        position: source.transform.position.clone(),
        rotation: source.transform.rotation.clone(),
        scale: source.transform.scale.clone(),
      },
      visible: source.visible,
      color: source.color,
      polygonCount: bodyGeom.nativePreview?.originalTriangleCount
        ?? bodyGeom.geometry.getAttribute('position').count / 3,
    }));

    // Remove the merged source, add individual models
    setModels((prev) => [
      ...prev.filter((m) => m.id !== modelId),
      ...newModels,
    ]);

    // Select all new bodies
    const newIds = newModels.map((m) => m.id);
    setActiveModelId(newIds[0]);
    setSelectedModelIds(newIds);
  }, []);

  /** Splits a model that has a classified model/support triangle split
   *  (from the native repair engine) into two independent models:
   *  one for the model body and one for the support geometry.
   *  Requires `model_triangle_count` in the native repair report. */
  const splitSupports = useCallback(async (modelId: string) => {
    setImportProgress({
      active: true,
      type: 'mesh',
      label: 'Splitting Supports…',
      detail: 'Separating model and support geometry…',
      progress: null,
    });
    await waitForUiYield();

    try {
    const source = modelsRef.current.find((m) => m.id === modelId);
    if (!source) return;

    const split = splitClassifiedSupportGeometry(source, { interactive: true });
    if (!split) return;
    const {
      modelGeometry: modelGeom,
      supportGeometry: supportGeom,
      modelPosition,
      supportPosition,
      modelTriangleCount: modelTriCount,
      supportTriangleCount: supportTriCount,
      totalTriangleCount: totalTris,
    } = split;

    setImportProgress((p) => ({ ...p, detail: 'Finalizing…' }));
    await waitForUiYield();

    // Tag the support geometry so the renderer uses orange hover/select tints
    // (the `likely_support_geometry` flag drives tint color in SceneCanvas).
    supportGeom.meshDefects = {
      hasDefects: false,
      repairedFloats: 0,
      totalVertices: supportTriCount * 3,
      nativeRepairReport: {
        version: 1,
        source_path: null,
        pre: {
          triangle_count: supportTriCount,
          vertex_count: supportTriCount * 3,
          non_manifold_edges: 0,
          non_manifold_vertices: 0,
          boundary_edges: 0,
          boundary_loops: 0,
          inconsistent_edges: 0,
          degenerate_triangles: 0,
          duplicate_triangles: 0,
          component_count: 0,
          self_intersections: 0,
          signed_volume: 0,
          is_watertight: false,
          timings_ms: { topology_ms: 0, self_intersections_ms: 0, components_ms: 0, total_ms: 0 },
        },
        post: {
          triangle_count: supportTriCount,
          vertex_count: supportTriCount * 3,
          non_manifold_edges: 0,
          non_manifold_vertices: 0,
          boundary_edges: 0,
          boundary_loops: 0,
          inconsistent_edges: 0,
          degenerate_triangles: 0,
          duplicate_triangles: 0,
          component_count: 0,
          self_intersections: 0,
          signed_volume: 0,
          is_watertight: false,
          timings_ms: { topology_ms: 0, self_intersections_ms: 0, components_ms: 0, total_ms: 0 },
        },
        steps: [],
        likely_support_geometry: true,
        residual_issues: [],
        fully_repaired: true,
        total_ms: 0,
      },
    };

    const currentActiveModelId = activeModelIdRef.current;
    const currentSelectedModelIds = selectedModelIdsRef.current;

    const before = captureSceneSnapshot(
      modelsRef.current,
      currentActiveModelId,
      currentSelectedModelIds,
      { includeSupportState: true },
    );

    const baseName = source.name.replace(/\.(stl|obj|3mf)$/i, '');
    const modelModel: LoadedModel = {
      id: uuidv4(),
      name: `${baseName} (Model)`,
      fileUrl: source.fileUrl,
      fileSizeBytes: source.fileSizeBytes ? Math.round(source.fileSizeBytes * (modelTriCount / totalTris)) : undefined,
      // The split geometry no longer matches the original file on disk, so
      // clear sourcePath to prevent downstream consumers (e.g. island scanner)
      // from sideloading stale data from the original file.
      sourcePath: null,
      geometry: modelGeom,
      transform: {
        position: modelPosition,
        rotation: source.transform.rotation.clone(),
        scale: source.transform.scale.clone(),
      },
      visible: source.visible,
      color: source.color,
      polygonCount: modelTriCount,
      ignoreAutoLift: source.ignoreAutoLift,
      manualZMoveOverride: source.manualZMoveOverride,
      isSupportGeometry: false,
    };

    const supportModel: LoadedModel = {
      id: uuidv4(),
      name: `${baseName} (Supports)`,
      fileUrl: source.fileUrl,
      fileSizeBytes: source.fileSizeBytes ? Math.round(source.fileSizeBytes * (supportTriCount / totalTris)) : undefined,
      // The split geometry no longer matches the original file on disk.
      sourcePath: null,
      geometry: supportGeom,
      transform: {
        position: supportPosition,
        rotation: source.transform.rotation.clone(),
        scale: source.transform.scale.clone(),
      },
      visible: source.visible,
      color: source.color,
      polygonCount: supportTriCount,
      ignoreAutoLift: source.ignoreAutoLift,
      manualZMoveOverride: source.manualZMoveOverride,
      isSupportGeometry: true,
    };

    const nextModels = [
      ...modelsRef.current.filter((m) => m.id !== modelId),
      modelModel,
      supportModel,
    ];

    setModels(nextModels);
    setActiveModelId(modelModel.id);
    setSelectedModelIds([modelModel.id, supportModel.id]);

    const after = captureSceneSnapshot(
      nextModels,
      modelModel.id,
      [modelModel.id, supportModel.id],
      { includeSupportState: true },
    );
    pushSceneSnapshotHistory(before, after, `Split Supports from ${source.name}`);
    } catch (e) {
      console.error(e);
      emitSceneImportReport('Failed to split supports', 'error');
    } finally {
      setImportProgress({ active: false, type: null, label: '', detail: '', progress: null });
    }
  }, [pushSceneSnapshotHistory, setImportProgress, waitForUiYield, emitSceneImportReport]);

  /** Re-combines split model and support geometries back into a single model,
   *  transforming the supports to align with any model movement/rotation. */
  const mergeSupports = useCallback(async () => {
    setImportProgress({
      active: true,
      type: 'mesh',
      label: 'Merging Supports…',
      detail: 'Recombining model and support geometry…',
      progress: null,
    });
    await waitForUiYield();

    try {
      const selectedIds = selectedModelIdsRef.current;
      if (selectedIds.length !== 2) return;

      const selectedModels = modelsRef.current.filter((m) => selectedIds.includes(m.id));
      if (selectedModels.length !== 2) return;

      const modelModel = selectedModels.find((m) => !m.isSupportGeometry)
        || selectedModels.find((m) => m.id === activeModelIdRef.current)
        || selectedModels[0];
      const supportModel = selectedModels.find((m) => m.id !== modelModel.id)!;

      // Model and Support might have different transformations.
      // Compute matrix to transform support vertices into model local space.
      const modelMatrix = new THREE.Matrix4().compose(
        modelModel.transform.position,
        new THREE.Quaternion().setFromEuler(modelModel.transform.rotation),
        modelModel.transform.scale,
      );
      const supportMatrix = new THREE.Matrix4().compose(
        supportModel.transform.position,
        new THREE.Quaternion().setFromEuler(supportModel.transform.rotation),
        supportModel.transform.scale,
      );
      const supportToModelMatrix = new THREE.Matrix4().copy(modelMatrix).invert().multiply(supportMatrix);

      const modelGeom = modelModel.geometry.geometry;
      const supportGeom = supportModel.geometry.geometry;

      const modelPositions = modelGeom.getAttribute('position').array;
      const supportPositions = supportGeom.getAttribute('position').array;

      const modelCenter = modelModel.geometry.center;
      const supportCenter = supportModel.geometry.center;

      const tempV = new THREE.Vector3();
      const mappedSupportPositions = new Float32Array(supportPositions.length);
      for (let i = 0; i < supportPositions.length; i += 3) {
        tempV.set(
          supportPositions[i] - supportCenter.x,
          supportPositions[i + 1] - supportCenter.y,
          supportPositions[i + 2] - supportCenter.z,
        );
        tempV.applyMatrix4(supportToModelMatrix);
        mappedSupportPositions[i] = tempV.x + modelCenter.x;
        mappedSupportPositions[i + 1] = tempV.y + modelCenter.y;
        mappedSupportPositions[i + 2] = tempV.z + modelCenter.z;
      }

      const combinedPositions = new Float32Array(modelPositions.length + mappedSupportPositions.length);
      combinedPositions.set(modelPositions, 0);
      combinedPositions.set(mappedSupportPositions, modelPositions.length);

      const modelTriangleCount = modelPositions.length / 9;
      const supportTriangleCount = mappedSupportPositions.length / 9;

      const mergedGeometryObj = new THREE.BufferGeometry();
      mergedGeometryObj.setAttribute('position', new THREE.BufferAttribute(combinedPositions, 3));
      mergedGeometryObj.computeVertexNormals();
      mergedGeometryObj.computeBoundingBox();

      const bbox = mergedGeometryObj.boundingBox?.clone() ?? new THREE.Box3();
      const center = bbox.getCenter(new THREE.Vector3());
      const size = bbox.getSize(new THREE.Vector3());

      const mergedGeometry: GeometryWithBounds = {
        geometry: mergedGeometryObj,
        bbox,
        center,
        size,
        flatteningPlanes: modelModel.geometry.flatteningPlanes || [],
        edgeGeometry: modelModel.geometry.edgeGeometry,
      };

      const supportGeo = new THREE.BufferGeometry();
      supportGeo.setAttribute('position', new THREE.BufferAttribute(mappedSupportPositions, 3));
      supportGeo.computeVertexNormals();

      const modelGeo = new THREE.BufferGeometry();
      modelGeo.setAttribute('position', new THREE.BufferAttribute(modelPositions, 3));

      // Set the nativeRepairReport properties to preserve support triangle designation
      mergedGeometry.meshDefects = {
        hasDefects: false,
        repairedFloats: 0,
        totalVertices: combinedPositions.length / 3,
        supportSectionGeometry: supportGeo,
        modelSectionGeometry: modelGeo,
        nativeRepairReport: {
          version: 1,
          source_path: null,
          pre: {
            triangle_count: modelTriangleCount + supportTriangleCount,
            vertex_count: (modelTriangleCount + supportTriangleCount) * 3,
            non_manifold_edges: 0,
            non_manifold_vertices: 0,
            boundary_edges: 0,
            boundary_loops: 0,
            inconsistent_edges: 0,
            degenerate_triangles: 0,
            duplicate_triangles: 0,
            component_count: 0,
            self_intersections: 0,
            signed_volume: 0,
            is_watertight: false,
            timings_ms: { topology_ms: 0, self_intersections_ms: 0, components_ms: 0, total_ms: 0 },
          },
          post: {
            triangle_count: modelTriangleCount + supportTriangleCount,
            vertex_count: (modelTriangleCount + supportTriangleCount) * 3,
            non_manifold_edges: 0,
            non_manifold_vertices: 0,
            boundary_edges: 0,
            boundary_loops: 0,
            inconsistent_edges: 0,
            degenerate_triangles: 0,
            duplicate_triangles: 0,
            component_count: 0,
            self_intersections: 0,
            signed_volume: 0,
            is_watertight: false,
            timings_ms: { topology_ms: 0, self_intersections_ms: 0, components_ms: 0, total_ms: 0 },
          },
          steps: [],
          likely_support_geometry: false,
          model_triangle_count: modelTriangleCount,
          residual_issues: [],
          fully_repaired: true,
          total_ms: 0,
        },
      };

      const before = captureSceneSnapshot(
        modelsRef.current,
        activeModelIdRef.current,
        selectedModelIdsRef.current,
        { includeSupportState: true },
      );

      const baseName = modelModel.name.replace(/ \(Model\)$/i, '');
      const mergedModel: LoadedModel = {
        id: uuidv4(),
        name: baseName,
        fileUrl: modelModel.fileUrl,
        fileSizeBytes: (modelModel.fileSizeBytes || 0) + (supportModel.fileSizeBytes || 0),
        sourcePath: null,
        geometry: mergedGeometry,
        transform: {
          position: (() => {
            const rotation = new THREE.Quaternion().setFromEuler(modelModel.transform.rotation);
            const positionOffset = center.clone().sub(modelCenter);
            positionOffset.multiply(modelModel.transform.scale).applyQuaternion(rotation);
            return modelModel.transform.position.clone().add(positionOffset);
          })(),
          rotation: modelModel.transform.rotation.clone(),
          scale: modelModel.transform.scale.clone(),
        },
        visible: modelModel.visible,
        color: modelModel.color,
        polygonCount: modelTriangleCount + supportTriangleCount,
        ignoreAutoLift: modelModel.ignoreAutoLift,
        manualZMoveOverride: modelModel.manualZMoveOverride,
        isSupportGeometry: undefined,
      };

      const nextModels = [
        ...modelsRef.current.filter((m) => m.id !== modelModel.id && m.id !== supportModel.id),
        mergedModel,
      ];

      setModels(nextModels);
      setActiveModelId(mergedModel.id);
      setSelectedModelIds([mergedModel.id]);

      const after = captureSceneSnapshot(
        nextModels,
        mergedModel.id,
        [mergedModel.id],
        { includeSupportState: true },
      );
      pushSceneSnapshotHistory(before, after, `Merge Supports for ${mergedModel.name}`);
    } catch (e) {
      console.error(e);
      emitSceneImportReport('Failed to merge supports', 'error');
    } finally {
      setImportProgress({ active: false, type: null, label: '', detail: '', progress: null });
    }
  }, [pushSceneSnapshotHistory, setImportProgress, waitForUiYield, emitSceneImportReport]);

  const scanModelForSupportsInPlace = useCallback(async (modelId: string): Promise<boolean> => {
    const model = modelsRef.current.find(m => m.id === modelId);
    if (!model) return false;
    
    setImportProgress({
      active: true,
      type: 'mesh',
      label: 'Scanning for Supports…',
      detail: `Classifying ${model.name}`,
      progress: null,
    });
    await waitForUiYield();

    try {
      const processed = await processGeometry(model.geometry.geometry, {
        center: false,
        nativeProcessingMode: 'classify-only',
        assumeSupportGeometry: undefined,
        _nativeModelTriangleCount: model.geometry.meshDefects?.nativeRepairReport?.model_triangle_count ?? undefined,
      });
      const posAttr = processed.geometry.getAttribute('position') as THREE.BufferAttribute | null;
      const polygonCount = posAttr ? Math.floor(posAttr.count / 3) : model.polygonCount;
      const repairReport = processed.meshDefects?.nativeRepairReport ?? null;

      setModels(prev => prev.map(m =>
        m.id === modelId ? { ...m, geometry: processed, polygonCount, isSupportGeometry: undefined } : m
      ));

      if (repairReport) {
        const reportEntry: MeshRepairReportEntry = {
          id: modelId,
          modelName: model.name,
          report: repairReport,
        };
        setPendingMeshRepairReports([]);
        clearSceneImportReport();
        setMeshRepairReportPresentation('optimistic');
        setMeshRepairReports([reportEntry]);
      } else {
        setPendingMeshRepairReports([]);
        emitSceneImportReport(`Scanned ${model.name}.`, 'success');
      }

      return true;
    } catch (err) {
      console.error('[scanModelForSupportsInPlace] Scan failed:', err);
      setPendingMeshRepairReports([]);
      const message = err instanceof Error ? err.message : String(err);
      emitSceneImportReport(`Scan failed: ${message}`, 'error', { durationMs: 6_000 });
      return false;
    } finally {
      setImportProgress({ active: false, type: null, label: '', detail: '', progress: null });
    }
  }, [clearSceneImportReport, emitSceneImportReport, setImportProgress, waitForUiYield]);

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

  const deleteModels = useCallback(async (idsInput: string[]) => {
    const ids = new Set(idsInput);
    if (ids.size === 0) return;

    const existing = modelsRef.current.filter((m) => ids.has(m.id));
    if (existing.length === 0) return;

    // Release the deleted models' compressed mesh chunks (Ph0.1 sub-phase C2).
    // The encode cache this replaced had exactly one `.get` and one `.set` and
    // no eviction anywhere: a deleted 4M-tri model kept ~191 MiB of raw STL
    // resident for the remainder of the session, and repeated import → delete
    // cycles grew the heap without bound. Refcounted, so instances that still
    // share the blob keep it alive.
    void exportManager()
      .then((manager) => manager.releaseModelChunks(ids))
      .catch((error) => {
        console.warn('[SceneCollection] Failed releasing mesh chunks for deleted models.', error);
      });

    const supportStateBeforeDelete = getSnapshot();
    const kickstandSnapshotBefore = getKickstandSnapshot();

    const kickstandCountByModel = new Map<string, number>();
    for (const kickstand of Object.values(kickstandSnapshotBefore.kickstands)) {
      const current = kickstandCountByModel.get(kickstand.modelId) ?? 0;
      kickstandCountByModel.set(kickstand.modelId, current + 1);
    }

    const supportsByModel = new Map<string, ReturnType<typeof getSupportsForModel>>();
    const supportPrimitiveCountByModel = new Map<string, number>();

    for (const model of existing) {
      const supportIds = getSupportsForModel(supportStateBeforeDelete, model.id);
      supportsByModel.set(model.id, supportIds);

      const kickstandCount = kickstandCountByModel.get(model.id) ?? 0;
      const supportPrimitiveCount = supportIds.roots.length
        + supportIds.trunks.length
        + supportIds.branches.length
        + supportIds.braces.length
        + supportIds.leaves.length
        + supportIds.twigs.length
        + supportIds.sticks.length
        + kickstandCount;

      supportPrimitiveCountByModel.set(model.id, supportPrimitiveCount);
    }

    const shouldShowDeleteOverlayImmediately = existing.some((model) => {
      const supportPrimitiveCount = supportPrimitiveCountByModel.get(model.id) ?? 0;
      return supportPrimitiveCount > 100 || model.polygonCount > 600000;
    });

    await waitForUiYield();

    const modelHasSupports = (modelId: string) => {
      const supportIds = supportsByModel.get(modelId) ?? getSupportsForModel(getSnapshot(), modelId);
      if (!supportsByModel.has(modelId)) {
        supportsByModel.set(modelId, supportIds);
      }

      const hasMainSupports = supportIds.roots.length > 0
        || supportIds.trunks.length > 0
        || supportIds.branches.length > 0
        || supportIds.braces.length > 0
        || supportIds.leaves.length > 0
        || supportIds.twigs.length > 0
        || supportIds.sticks.length > 0;

      if (hasMainSupports) return true;

      return (kickstandCountByModel.get(modelId) ?? 0) > 0;
    };

    const includeSupportHistory = existing.some((model) => modelHasSupports(model.id));
    const currentModels = modelsRef.current;
    const currentActiveModelId = activeModelIdRef.current;
    const currentSelectedModelIds = selectedModelIdsRef.current;

    const before = captureSceneSnapshot(currentModels, currentActiveModelId, currentSelectedModelIds, { includeSupportState: includeSupportHistory });

    existing.forEach((model) => {
      tryRevokeObjectUrl(model.fileUrl);
    });

    const nextModelsWithoutDeleted = currentModels.filter((m) => !ids.has(m.id));

    // Dissolve link groups if remaining peer count < 2
    const deletedLinkGroupIds = new Set(existing.map((m) => m.linkGroupId).filter(Boolean) as string[]);
    let nextModels = nextModelsWithoutDeleted;
    if (deletedLinkGroupIds.size > 0) {
      deletedLinkGroupIds.forEach((gId) => {
        const remaining = nextModels.filter((m) => m.linkGroupId === gId);
        if (remaining.length < 2) {
          nextModels = nextModels.map((m) => {
            if (m.linkGroupId === gId) {
              return { ...m, linkGroupId: undefined };
            }
            return m;
          });
        }
      });
    }

    const nextActiveModelId = currentActiveModelId && ids.has(currentActiveModelId) ? null : currentActiveModelId;
    const nextSelectedModelIds = currentSelectedModelIds.filter((sid) => !ids.has(sid));

    setModels(nextModels);
    setActiveModelId(nextActiveModelId);
    setSelectedModelIds(nextSelectedModelIds);

    // Clean up external mesh modifier store
    ids.forEach((id) => deleteStoredMeshModifiers(id));

    // Clean up associated supports before capturing the "after" snapshot so undo/redo remains atomic.
    const supportState = getSnapshot();
    let totalRemovedSupports = 0;
    if (includeSupportHistory) {
      ids.forEach((id) => {
        totalRemovedSupports += deleteSupportsForModel(supportState, id);
      });

      // Defensive pass: guarantee no orphaned supports survive model deletion.
      for (const modelId of ids) {
        const remaining = getSupportsForModel(getSnapshot(), modelId);
        const hasRemainingMainSupports = remaining.roots.length > 0
          || remaining.trunks.length > 0
          || remaining.branches.length > 0
          || remaining.braces.length > 0
          || remaining.leaves.length > 0
          || remaining.twigs.length > 0
          || remaining.sticks.length > 0;

        const hasRemainingKickstands = Object.values(getKickstandSnapshot().kickstands)
          .some((kickstand) => kickstand.modelId === modelId);

        if (hasRemainingMainSupports || hasRemainingKickstands) {
          totalRemovedSupports += deleteSupportsForModel(getSnapshot(), modelId);
        }
      }
    }

    const after = captureSceneSnapshot(nextModels, nextActiveModelId, nextSelectedModelIds, { includeSupportState: includeSupportHistory });
    const deletedLabel = existing.length === 1
      ? `Delete Model ${existing[0].name}`
      : `Delete ${existing.length} Models`;
    pushSceneSnapshotHistory(before, after, deletedLabel);

    console.log(`[SceneCollection] Deleted ${ids.size} model(s) and ${totalRemovedSupports} associated supports.`);
  }, [pushSceneSnapshotHistory, tryRevokeObjectUrl, waitForUiYield]);

  const deleteModel = useCallback((id: string) => {
    void deleteModels([id]);
  }, [deleteModels]);

  const deleteSupportsForModels = useCallback((idsInput: string[], description?: string) => {
    const ids = new Set(idsInput);
    if (ids.size === 0) return 0;

    const currentModels = modelsRef.current;
    const existingModelIds = currentModels
      .filter((model) => ids.has(model.id))
      .map((model) => model.id);
    if (existingModelIds.length === 0) return 0;

    const supportStateBefore = getSnapshot();
    const kickstandStateBefore = getKickstandSnapshot();

    const hasSupportsForModel = (modelId: string) => {
      const supportIds = getSupportsForModel(supportStateBefore, modelId);
      const hasMainSupports = supportIds.roots.length > 0
        || supportIds.trunks.length > 0
        || supportIds.branches.length > 0
        || supportIds.braces.length > 0
        || supportIds.leaves.length > 0
        || supportIds.twigs.length > 0
        || supportIds.sticks.length > 0;

      if (hasMainSupports) return true;

      return Object.values(kickstandStateBefore.kickstands)
        .some((kickstand) => kickstand.modelId === modelId);
    };

    const targetIds = existingModelIds.filter((modelId) => hasSupportsForModel(modelId));
    if (targetIds.length === 0) return 0;

    const currentActiveModelId = activeModelIdRef.current;
    const currentSelectedModelIds = selectedModelIdsRef.current;
    const before = captureSceneSnapshot(currentModels, currentActiveModelId, currentSelectedModelIds, { includeSupportState: true });

    let totalRemovedSupports = 0;
    const supportState = getSnapshot();
    targetIds.forEach((modelId) => {
      totalRemovedSupports += deleteSupportsForModel(supportState, modelId);
    });

    const after = captureSceneSnapshot(currentModels, currentActiveModelId, currentSelectedModelIds, { includeSupportState: true });
    const defaultDescription = targetIds.length === 1
      ? `Delete Supports for Model ${currentModels.find((m) => m.id === targetIds[0])?.name ?? targetIds[0]}`
      : `Delete Supports for ${targetIds.length} Models`;

    pushSceneSnapshotHistory(before, after, description ?? defaultDescription);
    return totalRemovedSupports;
  }, [pushSceneSnapshotHistory]);

  const copyModel = useCallback((id: string) => {
    const source = models.find((m) => m.id === id);
    if (!source) return false;

    const supportClipboard = captureModelSupportsToClipboard(source.id);

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
        meshModifiers: undefined,
        supportClipboard,
        isSupportGeometry: source.isSupportGeometry,
        linkGroupId: source.linkGroupId,
      },
    ]);

    return true;
  }, [models]);

  const copySelectedModels = useCallback((ids?: string[]) => {
    const idSet = new Set((ids && ids.length > 0) ? ids : selectedModelIds);
    if (idSet.size === 0) return false;

    const selected = models.filter((m) => idSet.has(m.id));
    if (selected.length === 0) return false;

    setModelClipboard(selected.map((source) => {
      const supportClipboard = captureModelSupportsToClipboard(source.id);
      return {
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
        meshModifiers: undefined,
        supportClipboard,
        isSupportGeometry: source.isSupportGeometry,
        linkGroupId: source.linkGroupId,
      };
    }));

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

    const beforeModels = models;
    const beforeActiveModelId = activeModelId;
    const beforeSelectedModelIds = selectedModelIds;
    const supportStateBefore = getSnapshot();
    const kickstandStateBefore = getKickstandSnapshot();

    const first = modelClipboard[0];

    const pastedGeometry = cloneGeometryWithBounds(first.geometry, { shared: true });

    const id = uuidv4();
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
      meshModifiers: undefined,
      isSupportGeometry: first.isSupportGeometry,
      linkGroupId: first.linkGroupId,
    };

    const nextModels = [...models, pastedModel];
    setModels(nextModels);
    setActiveModelId(id);
    setSelectedModelIds([id]);

    schedulePostPaint(() => {
      beginSupportStateBatch();
      beginKickstandStoreBatch();
      try {
        pasteModelSupportsFromClipboard(
          first.supportClipboard,
          id,
          first.transform,
          pastedModel.transform,
          { recordHistory: false },
        );
      } finally {
        endKickstandStoreBatch();
        endSupportStateBatch();
      }

      const before = captureSceneSnapshot(beforeModels, beforeActiveModelId, beforeSelectedModelIds, {
        includeSupportState: true,
        supportStateOverride: supportStateBefore,
        kickstandStateOverride: kickstandStateBefore,
      });
      const after = captureSceneSnapshot(nextModels, id, [id], { includeSupportState: true });
      pushSceneSnapshotHistory(before, after, `Paste Model ${first.name}`);
    });

    return id;
  }, [activeModelId, cloneGeometryWithBounds, modelClipboard, models, pushSceneSnapshotHistory, selectedModelIds]);

  const pasteCopiedModelsAutoArrange = useCallback((spacingMm = 5) => {
    if (modelClipboard.length === 0) return [] as string[];

    const beforeModels = models;
    const beforeActiveModelId = activeModelId;
    const beforeSelectedModelIds = selectedModelIds;
    const supportStateBefore = getSnapshot();
    const kickstandStateBefore = getKickstandSnapshot();

    const entries = modelClipboard;

    const centerX = defaultImportCenterXY.x;
    const centerY = defaultImportCenterXY.y;
    const minX = view3dSettings.originMode === 'front_left' ? 0 : -view3dSettings.widthMm * 0.5;
    const maxX = minX + view3dSettings.widthMm;
    const minY = view3dSettings.originMode === 'front_left' ? 0 : -view3dSettings.depthMm * 0.5;
    const maxY = minY + view3dSettings.depthMm;

    type Rect2D = { minX: number; maxX: number; minY: number; maxY: number };

    const intersectsRect = (a: Rect2D, b: Rect2D) => {
      return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
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

    const supportRectForPayload = (payload: SupportClipboardPayload | null | undefined): Rect2D | null => {
      if (!payload) return null;

      const raftSettings = getRaftSettings();

      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      let hasAny = false;

      const expand = (pos?: { x: number; y: number; z: number } | null, radius = 0) => {
        if (!pos) return;
        const r = Math.max(0, radius);
        minX = Math.min(minX, pos.x - r);
        maxX = Math.max(maxX, pos.x + r);
        minY = Math.min(minY, pos.y - r);
        maxY = Math.max(maxY, pos.y + r);
        hasAny = true;
      };

      payload.roots.forEach((root) => {
        const rr = Math.max(0.001, root.diameter / 2);
        expand(root.transform.pos, rr);
        expand({
          x: root.transform.pos.x,
          y: root.transform.pos.y,
          z: root.transform.pos.z + Math.max(0, root.diskHeight) + Math.max(0, root.coneHeight),
        }, rr);
      });

      if (raftSettings.bottomMode !== 'off' && payload.roots.length > 0) {
        const circles: SupportBaseCircle[] = payload.roots.map((root) => ({
          x: root.transform.pos.x,
          y: root.transform.pos.y,
          r: root.diameter / 2,
        }));

        const thickness = raftSettings.bottomMode === 'line' ? raftSettings.lineHeightMm : raftSettings.thickness;
        const chamferInset = Math.max(0, thickness) * Math.tan((Math.PI / 180) * (90 - Math.min(90, Math.max(45, raftSettings.chamferAngle))));
        const wallInset = raftSettings.wallEnabled ? Math.max(0, raftSettings.wallThickness) : 0;
        const dynamicMargin = 0.2 + Math.max(chamferInset, wallInset);

        const baseProfile = computeFootprint(circles, {
          marginMm: dynamicMargin,
          samplesPerCircle: 24,
        });

        if (baseProfile && baseProfile.length >= 3) {
          const outerProfile = raftSettings.wallEnabled
            ? computeRaftOuterBoundary(baseProfile, raftSettings)
            : baseProfile;

          outerProfile.forEach((point) => expand({ x: point.x, y: point.y, z: 0 }, 0));
        }
      }

      payload.knots.forEach((knot) => expand(knot.pos, Math.max(0.001, (knot.diameter ?? 1.2) / 2)));
      payload.kickstandKnots.forEach((knot) => expand(knot.pos, Math.max(0.001, (knot.diameter ?? 1.2) / 2)));

      const expandSegments = (segments: Array<any>) => {
        segments.forEach((segment) => {
          expand(segment.topJoint?.pos, Math.max(0.001, (segment.topJoint?.diameter ?? segment.diameter) / 2));
          expand(segment.bottomJoint?.pos, Math.max(0.001, (segment.bottomJoint?.diameter ?? segment.diameter) / 2));
        });
      };

      payload.trunks.forEach((trunk) => {
        expandSegments(trunk.segments as any[]);
        if (trunk.contactCone) {
          expand(trunk.contactCone.pos, Math.max(0.001, trunk.contactCone.profile.contactDiameterMm / 2));
        }
      });

      payload.branches.forEach((branch) => {
        expandSegments(branch.segments as any[]);
        if (branch.contactCone) {
          expand(branch.contactCone.pos, Math.max(0.001, branch.contactCone.profile.contactDiameterMm / 2));
        }
      });

      payload.leaves.forEach((leaf) => {
        if (!leaf.contactCone) return;
        expand(leaf.contactCone.pos, Math.max(0.001, leaf.contactCone.profile.contactDiameterMm / 2));
      });

      payload.twigs.forEach((twig) => {
        expandSegments(twig.segments as any[]);
        expand(twig.contactDiskA.pos, Math.max(0.001, twig.contactDiskA.contactDiameterMm / 2));
        expand(twig.contactDiskB.pos, Math.max(0.001, twig.contactDiskB.contactDiameterMm / 2));
      });

      payload.sticks.forEach((stick) => {
        expandSegments(stick.segments as any[]);
        expand(stick.contactConeA.pos, Math.max(0.001, stick.contactConeA.profile.contactDiameterMm / 2));
        expand(stick.contactConeB.pos, Math.max(0.001, stick.contactConeB.profile.contactDiameterMm / 2));
      });

      payload.kickstands.forEach((kickstand) => {
        expandSegments(kickstand.segments as any[]);
      });

      return hasAny ? { minX, maxX, minY, maxY } : null;
    };

    type PlacementOffsets = {
      minXOffset: number;
      maxXOffset: number;
      minYOffset: number;
      maxYOffset: number;
      width: number;
      depth: number;
    };

    const buildPlacementOffsets = (
      center: { x: number; y: number },
      meshSize: THREE.Vector3,
      transform: ModelTransform,
      supportPayload: SupportClipboardPayload | null | undefined,
    ): PlacementOffsets => {
      const meshFootprint = footprintFor(meshSize, transform);
      const meshRect: Rect2D = {
        minX: center.x - (meshFootprint.width * 0.5),
        maxX: center.x + (meshFootprint.width * 0.5),
        minY: center.y - (meshFootprint.depth * 0.5),
        maxY: center.y + (meshFootprint.depth * 0.5),
      };

      const supportRect = supportRectForPayload(supportPayload);
      const combinedRect = supportRect
        ? {
            minX: Math.min(meshRect.minX, supportRect.minX),
            maxX: Math.max(meshRect.maxX, supportRect.maxX),
            minY: Math.min(meshRect.minY, supportRect.minY),
            maxY: Math.max(meshRect.maxY, supportRect.maxY),
          }
        : meshRect;

      return {
        minXOffset: combinedRect.minX - center.x,
        maxXOffset: combinedRect.maxX - center.x,
        minYOffset: combinedRect.minY - center.y,
        maxYOffset: combinedRect.maxY - center.y,
        width: Math.max(2, combinedRect.maxX - combinedRect.minX),
        depth: Math.max(2, combinedRect.maxY - combinedRect.minY),
      };
    };

    const entryPlacementOffsets = entries.map((entry) => buildPlacementOffsets(
      { x: entry.transform.position.x, y: entry.transform.position.y },
      entry.geometry.size,
      entry.transform,
      entry.supportClipboard,
    ));

    const maxWidth = Math.max(...entryPlacementOffsets.map((entry) => entry.width));
    const maxDepth = Math.max(...entryPlacementOffsets.map((entry) => entry.depth));
    const stepX = Math.max(4, maxWidth + Math.max(0, spacingMm));
    const stepY = Math.max(4, maxDepth + Math.max(0, spacingMm));

    const blockedRects: Rect2D[] = models
      .filter((model) => model.visible)
      .map((model) => {
        const meshPlacement = buildPlacementOffsets(
          { x: model.transform.position.x, y: model.transform.position.y },
          model.geometry.size,
          model.transform,
          null,
        );

        const meshRect: Rect2D = {
          minX: model.transform.position.x + meshPlacement.minXOffset,
          maxX: model.transform.position.x + meshPlacement.maxXOffset,
          minY: model.transform.position.y + meshPlacement.minYOffset,
          maxY: model.transform.position.y + meshPlacement.maxYOffset,
        };

        const supportBounds = estimateSupportBoundsForModel(model.id);
        if (!supportBounds) {
          return meshRect;
        }

        return {
          minX: Math.min(meshRect.minX, supportBounds.minX),
          maxX: Math.max(meshRect.maxX, supportBounds.maxX),
          minY: Math.min(meshRect.minY, supportBounds.minY),
          maxY: Math.max(meshRect.maxY, supportBounds.maxY),
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

    const assignedCenters: Array<{ x: number; y: number }> = entries.map((entry, entryIndex) => {
      const placement = entryPlacementOffsets[entryIndex];

      const makeRectAt = (x: number, y: number): Rect2D => ({
        minX: x + placement.minXOffset,
        maxX: x + placement.maxXOffset,
        minY: y + placement.minYOffset,
        maxY: y + placement.maxYOffset,
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
        minX: fallbackX + placement.minXOffset,
        maxX: fallbackX + placement.maxXOffset,
        minY: fallbackY + placement.minYOffset,
        maxY: fallbackY + placement.maxYOffset,
      });
      return { x: fallbackX, y: fallbackY };
    });

    const createdIds: string[] = [];
    const pastedModels: LoadedModel[] = entries.map((entry, index) => {
      const id = uuidv4();
      createdIds.push(id);

      const geometry = cloneGeometryWithBounds(entry.geometry, { shared: true });

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
        meshModifiers: undefined,
        isSupportGeometry: entry.isSupportGeometry,
        linkGroupId: entry.linkGroupId,
      };
    });

    const nextModels = [...models, ...pastedModels];
    setModels(nextModels);

    if (createdIds.length > 0) {
      setActiveModelId(createdIds[0]);
      setSelectedModelIds(createdIds);

      schedulePostPaint(() => {
        beginSupportStateBatch();
        beginKickstandStoreBatch();
        try {
          pastedModels.forEach((pastedModel, index) => {
            const sourceEntry = entries[index];
            if (!sourceEntry) return;
            pasteModelSupportsFromClipboard(
              sourceEntry.supportClipboard,
              pastedModel.id,
              sourceEntry.transform,
              pastedModel.transform,
              { recordHistory: false },
            );
          });
        } finally {
          endKickstandStoreBatch();
          endSupportStateBatch();
        }

        const before = captureSceneSnapshot(beforeModels, beforeActiveModelId, beforeSelectedModelIds, {
          includeSupportState: true,
          supportStateOverride: supportStateBefore,
          kickstandStateOverride: kickstandStateBefore,
        });
        const after = captureSceneSnapshot(nextModels, createdIds[0], createdIds, { includeSupportState: true });
        pushSceneSnapshotHistory(before, after, createdIds.length === 1 ? 'Paste Model' : `Paste ${createdIds.length} Models`);
      });
    }

    return createdIds;
  }, [activeModelId, cloneGeometryWithBounds, defaultImportCenterXY.x, defaultImportCenterXY.y, modelClipboard, models, pushSceneSnapshotHistory, selectedModelIds, view3dSettings.depthMm, view3dSettings.originMode, view3dSettings.widthMm]);

  const duplicateModelWithTransforms = useCallback((sourceId: string, transforms: ModelTransform[], sourceTransform?: ModelTransform | null) => {
    if (transforms.length === 0) return [] as string[];

    const source = models.find((m) => m.id === sourceId);
    if (!source) return [] as string[];
    const supportClipboard = captureModelSupportsToClipboard(sourceId);

    const before = captureSceneSnapshot(models, activeModelId, selectedModelIds, { includeSupportState: true });

    const resolvedGroupId = source.groupId ?? `group-${uuidv4()}`;
    const resolvedGroupName = source.groupName ?? source.name;

    const createdIds: string[] = [];
    const newModels: LoadedModel[] = transforms.map((nextTransform, index) => {
      const id = uuidv4();
      createdIds.push(id);

      const geometry = cloneGeometryWithBounds(source.geometry, { shared: true });

      return {
        id,
        name: `${source.name} Copy ${index + 1}`,
        groupId: resolvedGroupId,
        groupName: resolvedGroupName,
        fileUrl: source.fileUrl,
        sourcePath: source.sourcePath,
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
        meshModifiers: undefined,
        isSupportGeometry: source.isSupportGeometry,
        linkGroupId: source.linkGroupId,
      };
    });

    const originalSourceTransform = {
      position: source.transform.position.clone(),
      rotation: source.transform.rotation.clone(),
      scale: source.transform.scale.clone(),
    };

    // Apply source-support transform before model commit so support state can
    // never visually lag behind the moved source model during duplicate apply.
    beginSupportStateBatch();
    beginKickstandStoreBatch();
    try {
      if (sourceTransform && !transformsEqual(source.transform, sourceTransform)) {
        transformSupportsForModel(sourceId, source.transform, sourceTransform);
      }

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

      newModels.forEach((model) => {
        pasteModelSupportsFromClipboard(
          supportClipboard,
          model.id,
          originalSourceTransform,
          model.transform,
          { recordHistory: false },
        );
      });

      if (createdIds.length > 0) {
        setActiveModelId(createdIds[0]);
        setSelectedModelIds([sourceId, ...createdIds]);

        const nextSelected = [sourceId, ...createdIds];
        const after = captureSceneSnapshot(nextModels, createdIds[0], nextSelected, { includeSupportState: true });
        pushSceneSnapshotHistory(before, after, createdIds.length === 1 ? `Duplicate Model ${source.name}` : `Duplicate ${createdIds.length} Models`);
      }
    } finally {
      endKickstandStoreBatch();
      endSupportStateBatch();
    }

    return createdIds;
  }, [activeModelId, cloneGeometryWithBounds, models, pushSceneSnapshotHistory, selectedModelIds]);

  // LYS Import (1-step) — dispatched via plugin registry

  type SceneImportRunOptions = {
    suppressProgress?: boolean;
    suppressReport?: boolean;
    suppressRecentTracking?: boolean;
    suppressPlacementPrompt?: boolean;
    suppressRepair?: boolean;
    sourcePath?: string | null;
    sourcePaths?: Array<string | null | undefined>;
  };

  const shouldAutoRepairSceneImports = useCallback((options?: SceneImportRunOptions): boolean => {
    if (options?.suppressRepair) return false;
    return getSavedImportDefaultsSettings().autoRepairScenes;
  }, []);

  const handleImportPluginSceneFile = useCallback(async (file: File, options?: SceneImportRunOptions): Promise<boolean> => {
    const extension = getSceneExtension(file.name);
    if (!extension || extension === '.voxl') {
      const unsupportedMessage = `Unsupported scene file: ${file.name}`;
      console.warn(`[SceneCollection] ${unsupportedMessage}`);
      if (!options?.suppressReport) {
        emitSceneImportReport(unsupportedMessage, 'error');
      }
      return false;
    }

    const pluginImport = scenePluginImportHandlersByExtension.get(extension.toLowerCase());
    if (!pluginImport) {
      const missingHandlerMessage = `No registered scene import handler for ${extension}.`;
      console.warn(`[SceneCollection] ${missingHandlerMessage}`);
      if (!options?.suppressReport) {
        emitSceneImportReport(missingHandlerMessage, 'error');
      }
      return false;
    }

    if (!options?.suppressRecentTracking) {
      trackRecentOpenedFiles([file], 'scene', { sourcePaths: [options?.sourcePath] });
    }

    if (!options?.suppressProgress) {
      setImportProgress({
        active: true,
        type: 'scene',
        label: `Importing ${pluginImport.fileType.displayName}…`,
        detail: file.name,
        progress: null,
      });
    }

    await waitForUiYield();

    try {
      const autoRepairScenes = shouldAutoRepairSceneImports(options);
      const importResult = await pluginImport.handler(file, pluginImport.fileType);

      if (!importResult.success) {
        throw new Error(importResult.error || `${pluginImport.fileType.displayName} import failed.`);
      }

      // Support both single-payload and array-payload plugins (e.g. multi-model LYS import).
      const rawPayloads = Array.isArray(importResult.payload)
        ? (importResult.payload as unknown[])
        : [importResult.payload];

      const normalizedPayloads = rawPayloads
        .map((p) => normalizePluginSceneImportPayload(p))
        .filter((p): p is PluginSceneImportPayload => p !== null);

      if (normalizedPayloads.length === 0) {
        throw new Error(`Plugin "${pluginImport.pluginId}" returned an unsupported scene payload.`);
      }

      // Process all geometries sequentially
      const processedItems: Array<{
        normalized: PluginSceneImportPayload;
        processed: GeometryWithBounds;
      }> = [];
      for (const normalized of normalizedPayloads) {
        const processed = await processGeometry(normalized.geometry, {
          center: false,
          nativeProcessingMode: autoRepairScenes ? 'auto' : 'none',
          onNativeProcessingStage: (stage) => {
            if (options?.suppressProgress) return;

            if (stage === 'repairing') {
              setImportProgress({
                active: true,
                type: 'scene',
                label: `Importing ${pluginImport.fileType.displayName}…`,
                detail: normalizedPayloads.length > 1
                  ? `Auto-Repairing Mesh ${processedItems.length + 1}/${normalizedPayloads.length}`
                  : `Auto-Repairing ${file.name}`,
                progress: null,
              });
              return;
            }

            if (stage === 'analyzing') {
              setImportProgress({
                active: true,
                type: 'scene',
                label: `Importing ${pluginImport.fileType.displayName}…`,
                detail: normalizedPayloads.length > 1
                  ? `Inspecting Mesh ${processedItems.length + 1}/${normalizedPayloads.length}`
                  : `Inspecting ${file.name}`,
                progress: null,
              });
              return;
            }

            if (stage === 'classifying') {
              setImportProgress({
                active: true,
                type: 'scene',
                label: `Importing ${pluginImport.fileType.displayName}…`,
                detail: normalizedPayloads.length > 1
                  ? `Classifying Mesh ${processedItems.length + 1}/${normalizedPayloads.length}`
                  : `Classifying ${file.name}`,
                progress: null,
              });
            }
          },
        });
        processedItems.push({ normalized, processed });
      }

      // Determine if any model is off-plate (check all)
      const sourceCandidates = processedItems.map(({ normalized, processed }) => ({
        geometry: processed,
        transform: {
          position: normalized.transform.position.clone(),
          rotation: normalized.transform.rotation.clone(),
          scale: normalized.transform.scale.clone(),
        },
      }));
      const offPlateCount = sourceCandidates.filter(
        (c) => !isModelFootprintInsidePlate({ geometry: c.geometry, transform: c.transform }),
      ).length;

      // Preserve authored placement by default. Only auto-arrange if models are off-plate
      // and the user explicitly chooses auto-arrange in the prompt.
      let shouldAutoArrangeOnImport = false;
      if (offPlateCount > 0 && !options?.suppressPlacementPrompt) {
        const choice = await requestSceneImportPlacementChoice({
          source: extension.slice(1).toUpperCase(),
          fileName: file.name,
          modelCount: normalizedPayloads.length,
          offPlateModelCount: offPlateCount,
        });
        shouldAutoArrangeOnImport = choice === 'auto_arrange';
      }

      // Auto-arrange all models together so they don't overlap
      const assignedCenters = shouldAutoArrangeOnImport
        ? findFreeSpotCentersForModels(sourceCandidates, 5)
        : [];

      const newModels: LoadedModel[] = [];
      const supportEntries: Array<{
        model: LoadedModel;
        sourceTransform: ModelTransform;
        supportData: PluginSceneImportPayload['supportData'];
      }> = [];

      for (let i = 0; i < processedItems.length; i++) {
        const { normalized, processed } = processedItems[i];
        const { transform: importedTransform, modelId: importedModelId, supportData, meshModifiers } = normalized;

        const originalPosition = importedTransform.position.clone();
        const sourceTransform: ModelTransform = {
          position: originalPosition.clone(),
          rotation: importedTransform.rotation.clone(),
          scale: importedTransform.scale.clone(),
        };

        const assignedCenter = assignedCenters[i] ?? null;
        const finalPosition = new THREE.Vector3(
          shouldAutoArrangeOnImport ? (assignedCenter?.x ?? originalPosition.x) : originalPosition.x,
          shouldAutoArrangeOnImport ? (assignedCenter?.y ?? originalPosition.y) : originalPosition.y,
          originalPosition.z,
        );

        // Prefer the source file's own object name; fall back to the imported
        // filename (with an index when the container held several models).
        const modelName = normalized.objName
          ? sanitizeImportedModelDisplayName(normalized.objName)
          : processedItems.length === 1
            ? sanitizeImportedModelDisplayName(file.name)
            : `${sanitizeImportedModelDisplayName(file.name)} (${i + 1})`;

        const model: LoadedModel = {
          id: importedModelId || uuidv4(),
          name: modelName,
          fileUrl: '',
          fileSizeBytes: file.size,
          geometry: processed,
          transform: {
            position: finalPosition,
            rotation: importedTransform.rotation,
            scale: importedTransform.scale,
          },
          visible: true,
          color: '#a3a3a3',
          polygonCount: processed.geometry.getAttribute('position').count / 3,
          ignoreAutoLift: true,
          meshModifiers: undefined,
          manualZMoveOverride: true,
        };

        // Store meshModifiers externally so model objects stay lightweight
        if (meshModifiers) {
          storeModelMeshModifiers(model.id, cloneMeshModifiersShallow(meshModifiers));
        }

        newModels.push(model);
        supportEntries.push({ model, sourceTransform, supportData });
      }

      if (newModels.length === 0) {
        throw new Error(`Plugin "${pluginImport.pluginId}" returned no importable models.`);
      }

      setModels((prev) => [...prev, ...newModels]);
      setActiveModelId(newModels[newModels.length - 1].id);
      setSelectedModelIds(newModels.map((m) => m.id));

      // Load supports for all models in a single animation frame batch
      const pendingSupports = supportEntries.filter((e) => !!e.supportData);
      if (pendingSupports.length > 0) {
        const applySupports = () => {
          for (const { model, sourceTransform, supportData } of pendingSupports) {
            applyImportDefaultsToRaftState();
            // Bind these supports to THIS model. The plugin already stamps a
            // modelId, but nothing verified it matched the id the host assigned
            // the model -- so pass the host id and let the store reconcile.
            mergeFromImportFormat(supportData!, model.id);
            if (!transformsEqual(sourceTransform, model.transform)) {
              transformSupportsForModel(model.id, sourceTransform, model.transform);
            }
          }
        };
        if (typeof window !== 'undefined') {
          requestAnimationFrame(applySupports);
        } else {
          applySupports();
        }
      }

      const totalSupportCount = supportEntries.reduce(
        (sum, e) => sum + countSupportEntries(e.supportData ?? null),
        0,
      );
      if (!options?.suppressReport) {
        const sourceLabel = extension.slice(1).toUpperCase();
        const modelLabel = newModels.length === 1 ? '1 model' : `${newModels.length} models`;
        emitSceneImportReport(
          totalSupportCount > 0
            ? `Imported ${sourceLabel} scene: ${modelLabel}, ${totalSupportCount} supports.`
            : `Imported ${sourceLabel} scene: ${modelLabel}.`,
          'success',
        );
      }

      console.log(`[SceneCollection] ${extension} import successful: ${newModels.map((m) => m.name).join(', ')}`);
      return true;
    } catch (err) {
      console.error('[SceneCollection] Failed to process plugin scene geometry:', err);
      const msg = err instanceof Error ? err.message : String(err);
      if (!options?.suppressReport) {
        emitSceneImportReport(`Scene import failed: ${msg}`, 'error');
      }
      if (!options?.suppressReport && typeof window !== 'undefined') {
        window.alert(`Import Scene failed:\n${msg}`);
      }
      return false;
    } finally {
      if (!options?.suppressProgress) {
        setImportProgress({
          active: false,
          type: null,
          label: '',
          detail: '',
          progress: null,
        });
      }
    }
  }, [emitSceneImportReport, findFreeSpotCentersForModels, getSceneExtension, isModelFootprintInsidePlate, processGeometry, requestSceneImportPlacementChoice, scenePluginImportHandlersByExtension, setActiveModelId, setModels, setSelectedModelIds, shouldAutoRepairSceneImports, trackRecentOpenedFiles, waitForUiYield]);

  const handleImportVoxlFile = useCallback(async (file: File, options?: SceneImportRunOptions): Promise<boolean> => {
    if (!options?.suppressRecentTracking) {
      trackRecentOpenedFiles([file], 'scene', { sourcePaths: [options?.sourcePath] });
    }

    if (!options?.suppressProgress) {
      setImportProgress({
        active: true,
        type: 'scene',
        label: 'Importing VOXL Scene…',
        detail: file.name,
        progress: null,
      });
    }

    await waitForUiYield();

    try {
      const autoRepairScenes = shouldAutoRepairSceneImports(options);
      // Peek at the first 6 bytes to detect format.
      // V2 binary starts with "VOXL" magic (0x56 0x4F 0x58 0x4C) + uint16 version >= 2.
      // V1 JSON starts with '{' (0x7B).
      // For V1, we use file.text() rather than TextDecoder.decode(arrayBuffer) because
      // some WebView environments (e.g. Tauri/WebView2) truncate TextDecoder output at ~4 MB
      // for large single-buffer decodes, while the native file.text() path is unaffected.
      const headerBytes = new Uint8Array(await file.slice(0, 6).arrayBuffer());
      const isV2 = isVoxlBinaryV2(headerBytes);

      let document: VoxlDocumentV1;
      let resolvedMeshBytes: Map<string, Uint8Array>;
      let resolvedOriginalMeshBytes: Map<string, Uint8Array> | undefined;
      let originalMeshChunks: Map<string, PrecompressedChunk> | undefined;

      if (isV2) {
        const r = parseVoxlBinaryV2(new Uint8Array(await file.arrayBuffer()));
        document = r.document;
        resolvedMeshBytes = r.meshBytes;
        resolvedOriginalMeshBytes = r.originalMeshBytes;
        originalMeshChunks = r.originalMeshChunks;
        // sourceVersion is 2.2 only when the file actually carries modifier
        // chunks; anything lower is treated as inline for format preservation.
        lastLoadedVoxlFormatChunkedRef.current = r.sourceVersion >= 2.2;
      } else {
        document = parseVoxlDocument(await file.text());
        resolvedMeshBytes = new Map();
      }

      const existingIds = new Set(modelsRef.current.map((model) => model.id));
      const idMap = new Map<string, string>();
      const importedModels: LoadedModel[] = [];
      let skippedModels = 0;

      // Identical-geometry dedup: a scene with N copies of one mesh (e.g. a
      // Fill-Plate bed) stores N identical payloads, and decode + SHA-256 +
      // native repair per copy dominates load time. Build each UNIQUE mesh
      // once (keyed by its content SHA) and share the result for duplicates
      // via the existing cloneGeometryWithBounds({ shared: true }) — the same
      // path duplicate/paste already use.
      const builtGeometryByHash = new Map<string, GeometryWithBounds>();
      let dedupHits = 0;

      for (let i = 0; i < document.models.length; i += 1) {
        const model = document.models[i];
        const meshRef = model.mesh;

        if (!meshRef) {
          console.warn(`[SceneCollection] Skipping VOXL model "${model.name}": missing mesh descriptor.`);
          skippedModels += 1;
          continue;
        }

        setImportProgress({
          active: true,
          type: 'scene',
          label: 'Importing VOXL Scene…',
          detail: `Model ${i + 1}/${document.models.length}: ${model.name}`,
          progress: null,
        });

        if (meshRef.mode !== 'embedded-file' && meshRef.mode !== 'embedded-chunk') {
          console.warn(`[SceneCollection] Skipping VOXL model "${model.name}": mesh mode \"${meshRef.mode}\" is not importable without embedded mesh data.`);
          skippedModels += 1;
          continue;
        }

        // V2: mesh bytes pre-decoded; V1: fall back to base64 decode from meshRef.dataBase64
        let meshDataBytes: Uint8Array | undefined = resolvedMeshBytes.get(model.id);

        if (!meshDataBytes) {
          if (!meshRef.dataBase64) {
            console.warn(`[SceneCollection] Skipping VOXL model "${model.name}": missing embedded mesh payload.`);
            skippedModels += 1;
            continue;
          }
          meshDataBytes = decodeVoxlEmbeddedMeshBytes(meshRef);
        }

        try {
          const bytes = meshDataBytes;

          // Dedup key: the file's own SHA when present, else the content hash
          // (also the integrity value). Compute once; reused as the cache key.
          const declaredSha =
            typeof meshRef.sha256 === 'string' && meshRef.sha256.trim().length > 0
              ? meshRef.sha256.trim().toLowerCase()
              : undefined;
          const contentHash = declaredSha ?? (await sha256Hex(bytes));

          const cached = builtGeometryByHash.get(contentHash);
          let geometry: GeometryWithBounds;
          if (cached) {
            // Identical mesh already built — clone, skipping decode + native
            // repair entirely (the expensive part). Integrity was verified on
            // the first occurrence.
            dedupHits += 1;
            console.log(
              `[SceneCollection] Geometry with hash ${contentHash} already processed — cloning it.`,
            );
            geometry = cloneGeometryWithBounds(cached, { shared: true });
          } else {
            if (declaredSha) {
              const actual = await sha256Hex(bytes);
              if (actual !== declaredSha) {
                throw new Error('VOXL integrity check failed (SHA-256 mismatch).');
              }
            }

            const embeddedName = meshRef.fileName?.trim() || `${model.name || 'model'}.stl`;

            geometry = await loadMeshGeometry(bytes, embeddedName, {
              nativeProcessingMode: autoRepairScenes ? 'auto' : 'none',
              assumeSupportGeometry: model.isSupportGeometry,
              skipClassification: model.isSupportGeometry,
            onNativeProcessingStage: (stage) => {
              if (stage === 'repairing') {
                setImportProgress({
                  active: true,
                  type: 'scene',
                  label: 'Importing VOXL Scene…',
                  detail: `Auto-Repairing Mesh ${i + 1}/${document.models.length}: ${model.name}`,
                  progress: null,
                });
                return;
              }

              if (stage === 'analyzing') {
                setImportProgress({
                  active: true,
                  type: 'scene',
                  label: 'Importing VOXL Scene…',
                  detail: `Inspecting Mesh ${i + 1}/${document.models.length}: ${model.name}`,
                  progress: null,
                });
                return;
              }

              if (stage === 'classifying') {
                setImportProgress({
                  active: true,
                  type: 'scene',
                  label: 'Importing VOXL Scene…',
                  detail: `Classifying Mesh ${i + 1}/${document.models.length}: ${model.name}`,
                  progress: null,
                });
              }
            },
            });
            // Cache the freshly-built mesh so identical copies clone it.
            builtGeometryByHash.set(contentHash, geometry);
          }

          let resolvedId = model.id;
          if (!resolvedId || existingIds.has(resolvedId)) {
            resolvedId = uuidv4();
          }
          existingIds.add(resolvedId);
          idMap.set(model.id, resolvedId);

          const origMeshBytes = resolvedOriginalMeshBytes?.get(model.id);
          const origMeshChunk = originalMeshChunks?.get(model.id);

          if (origMeshChunk) {
            void meshChunkStore.bake({
              modelId: resolvedId,
              slot: 'original',
              signature: `original:${resolvedId}`,
              precompressed: origMeshChunk,
              encode: () => origMeshBytes || new Uint8Array(0),
            });
          } else if (origMeshBytes) {
            void meshChunkStore.bake({
              modelId: resolvedId,
              slot: 'original',
              signature: `original:${resolvedId}`,
              encode: () => origMeshBytes,
            });
          } else {
            const voxlFilePath = (file as File & { path?: string; filePath?: string }).path
              || (file as File & { filePath?: string }).filePath
              || options?.sourcePath;
            const origRefToResolve = model.originalRef ?? (
              typeof model.sourcePath === 'string' && model.sourcePath.trim().length > 0
                ? { mode: 'external-file' as const, fileName: model.sourcePath }
                : undefined
            );
            const sidecarPath = resolveOriginalRefSidecar(origRefToResolve, voxlFilePath || undefined);

            if (sidecarPath) {
              try {
                const sidecarBytes = await readSidecarFileBytes(sidecarPath);
                if (sidecarBytes) {
                  void meshChunkStore.bake({
                    modelId: resolvedId,
                    slot: 'original',
                    signature: `original:${resolvedId}`,
                    encode: () => sidecarBytes,
                  });
                }
              } catch (err) {
                console.warn(`[SceneCollection] Unreadable sidecar file at "${sidecarPath}", falling back to preview:`, err);
              }
            }
          }

          const polygonCount = geometry.geometry.getAttribute('position').count / 3;
          const color = clampHexColor(model.color, DEFAULT_MESH_COLOR);

          importedModels.push({
            id: resolvedId,
            name: sanitizeImportedModelDisplayName(model.name),
            fileUrl: '',
            sourcePath: model.sourcePath ?? undefined,
            originalRef: model.originalRef,
            fileSizeBytes: model.fileSizeBytes,
            geometry,
            transform: {
              position: new THREE.Vector3(model.transform.position.x, model.transform.position.y, model.transform.position.z),
              rotation: eulerFromGlobalEuler(model.transform.rotation),
              scale: new THREE.Vector3(model.transform.scale.x, model.transform.scale.y, model.transform.scale.z),
            },
            visible: model.visible,
            color,
            polygonCount,
            meshModifiers: undefined,
            ignoreAutoLift: true,
            manualZMoveOverride: true,
            isSupportGeometry: model.isSupportGeometry,
            linkGroupId: model.linkGroupId,
          });

          // Store meshModifiers externally so model objects stay lightweight
          if (model.meshModifiers) {
            storeModelMeshModifiers(resolvedId, cloneMeshModifiersShallow(model.meshModifiers));
          }
        } catch (error) {
          console.error(`[SceneCollection] Failed importing embedded VOXL mesh for model "${model.name}"`, error);
          skippedModels += 1;
        }
      }

      if (dedupHits > 0) {
        console.log(
          `[SceneCollection] VOXL load: ${builtGeometryByHash.size} unique mesh(es) built, ` +
          `${dedupHits} duplicate(s) reused (skipped decode + native repair).`,
        );
      }

      const sourceTransformsByModelId = new Map<string, ModelTransform>();
      for (const imported of importedModels) {
        sourceTransformsByModelId.set(imported.id, cloneTransform(imported.transform));
      }

      const offPlateImportedModels = importedModels.filter((model) => !isModelFootprintInsidePlate(model));
      const shouldPromptForPlacement = offPlateImportedModels.length > 0 && !options?.suppressPlacementPrompt;

      // Preserve authored placement by default. Only auto-arrange if models are off-plate
      // and the user explicitly chooses auto-arrange in the prompt.
      let shouldAutoArrangeOnImport = false;
      if (shouldPromptForPlacement) {
        const choice = await requestSceneImportPlacementChoice({
          source: 'VOXL',
          fileName: file.name,
          modelCount: importedModels.length,
          offPlateModelCount: offPlateImportedModels.length,
        });
        shouldAutoArrangeOnImport = choice === 'auto_arrange';
      }

      if (importedModels.length > 0) {
        if (shouldAutoArrangeOnImport) {
          const assignedCenters = findFreeSpotCentersForModels(importedModels, 5);
          importedModels.forEach((model, index) => {
            const center = assignedCenters[index];
            if (!center) return;
            model.transform.position.set(center.x, center.y, model.transform.position.z);
          });
        }

        setModels((prev) => [...prev, ...importedModels]);

        const mappedActiveId = (document.scene.activeModelId && idMap.get(document.scene.activeModelId))
          || importedModels[0]?.id
          || null;

        const mappedSelectedIds = document.scene.selectedModelIds
          .map((id) => idMap.get(id))
          .filter((id): id is string => typeof id === 'string' && id.length > 0);

        const finalSelected = mappedSelectedIds.length > 0
          ? mappedSelectedIds
          : (mappedActiveId ? [mappedActiveId] : []);

        setActiveModelId(mappedActiveId);
        setSelectedModelIds(finalSelected);
      }

      if (voxlSupportsContainData(document)) {
        const remappedSupports = remapModelIdsInPayload(document.supports, idMap);
        applyImportDefaultsToRaftState();
        mergeFromImportFormat(remappedSupports);

        for (const imported of importedModels) {
          const sourceTransform = sourceTransformsByModelId.get(imported.id);
          if (!sourceTransform) continue;
          if (transformsEqual(sourceTransform, imported.transform)) continue;
          transformSupportsForModel(imported.id, sourceTransform, imported.transform);
        }
      }

      const importedSupportCount = countSupportEntries(document.supports);
      const importedModelCount = importedModels.length;
      const modelNoun = importedModelCount === 1 ? 'model' : 'models';
      const skippedNoun = skippedModels === 1 ? 'model' : 'models';
      const supportsClause = importedSupportCount > 0 ? `, ${importedSupportCount} supports` : '';
      const skippedClause = skippedModels > 0 ? `, skipped ${skippedModels} ${skippedNoun}` : '';

      if (importedModelCount > 0) {
        if (!options?.suppressReport) {
          emitSceneImportReport(
            `Imported VOXL scene: ${importedModelCount} ${modelNoun}${supportsClause}${skippedClause}.`,
            skippedModels > 0 ? 'warning' : 'success',
          );
        }
      }

      if (importedModels.length === 0) {
        console.warn('[SceneCollection] VOXL import completed without importable meshes (expected embedded-file meshes).');
        if (!options?.suppressReport) {
          emitSceneImportReport('VOXL import finished with no importable meshes.', 'warning');
        }
        return false;
      }
      return true;
    } catch (error) {
      console.error('[SceneCollection] VOXL import failed:', error);
      const message = error instanceof Error ? error.message : String(error);
      if (!options?.suppressReport) {
        emitSceneImportReport(`VOXL import failed: ${message}`, 'error');
      }
      if (!options?.suppressReport && typeof window !== 'undefined') {
        window.alert(`Import VOXL failed:\n${message}`);
      }
      return false;
    } finally {
      if (!options?.suppressProgress) {
        setImportProgress({
          active: false,
          type: null,
          label: '',
          detail: '',
          progress: null,
        });
      }
    }
  }, [cloneGeometryWithBounds, emitSceneImportReport, findFreeSpotCentersForModels, isModelFootprintInsidePlate, requestSceneImportPlacementChoice, shouldAutoRepairSceneImports, trackRecentOpenedFiles, waitForUiYield]);

  const importSceneFile = useCallback(async (file: File, options?: SceneImportRunOptions): Promise<boolean> => {
    const extension = getSceneExtension(file.name);
    if (extension === '.voxl') {
      return await handleImportVoxlFile(file, options);
    }
    if (extension) {
      return await handleImportPluginSceneFile(file, options);
    }

    console.warn(`[SceneCollection] Unsupported scene file: ${file.name}`);
    return false;
  }, [getSceneExtension, handleImportPluginSceneFile, handleImportVoxlFile]);

  const importSceneFiles = useCallback(async (
    filesInput: FileList | File[],
    options?: SceneImportRunOptions,
  ): Promise<boolean> => {
    const files = Array.from(filesInput).filter((file) => getSceneExtension(file.name) !== null);
    if (files.length === 0) return false;

    if (files.length === 1) {
      return await importSceneFile(files[0], {
        ...options,
        sourcePath: options?.sourcePaths?.[0] ?? options?.sourcePath,
      });
    }

    trackRecentOpenedFiles(files, 'scene', { sourcePaths: options?.sourcePaths });

    setImportProgress({
      active: true,
      type: 'scene',
      label: 'Importing Scenes…',
      detail: `Preparing 0/${files.length}`,
      progress: null,
    });

    await waitForUiYield();

    let successCount = 0;
    let failureCount = 0;
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      setImportProgress({
        active: true,
        type: 'scene',
        label: 'Importing Scenes…',
        detail: `${i + 1}/${files.length}: ${file.name}`,
        progress: null,
      });

      const ok = await importSceneFile(file, {
        suppressProgress: true,
        suppressReport: true,
        suppressRecentTracking: true,
        sourcePath: options?.sourcePaths?.[i] ?? null,
      });

      if (ok) successCount += 1;
      else failureCount += 1;
    }

    setImportProgress({
      active: false,
      type: null,
      label: '',
      detail: '',
      progress: null,
    });

    if (failureCount === 0) {
      emitSceneImportReport(`Imported ${successCount} scene files.`, 'success');
    } else if (successCount > 0) {
      emitSceneImportReport(`Imported ${successCount}/${files.length} scene files (${failureCount} failed).`, 'warning');
    } else {
      emitSceneImportReport(`Scene import failed for all ${files.length} files.`, 'error');
    }
    return successCount > 0;
  }, [emitSceneImportReport, getSceneExtension, importSceneFile, trackRecentOpenedFiles, waitForUiYield]);

  const onImportSceneChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      void importSceneFiles(e.target.files);
      e.target.value = '';
    }
  }, [importSceneFiles]);

  const reopenRecentOpenedFile = useCallback(async (entryId: string) => {
    const entry = recentOpenedFiles.find((item) => item.id === entryId);
    if (!entry) return false;

    // If this is a mesh with a known on-disk path, skip IndexedDB entirely and
    // create a path-backed file so the Rust sideload reads from disk directly.
    // IndexedDB blobs for these files were stored empty (0 bytes) because
    // createPathBackedStlFile builds the File object with an empty blob.
    if (entry.kind === 'mesh' && entry.sourcePath) {
      const pathFile = new File([], entry.name, {
        type: 'application/octet-stream',
        lastModified: Date.now(),
      });
      (pathFile as File & { filePath?: string }).filePath = entry.sourcePath;
      await loadFiles([pathFile]);
      return true;
    }

    const file = await readRecentOpenedFileBlob(entry);
    if (!file) {
      console.warn('[SceneCollection] Unable to restore recent file from local cache.');
      return false;
    }

    // Recovered file is empty and there is no disk path to fall back to — the
    // entry is broken (e.g. created before sourcePath was tracked for meshes).
    if (entry.kind === 'mesh' && file.size === 0) {
      console.warn(
        '[SceneCollection] Recent mesh file blob is empty and no on-disk path is available. ' +
        'The file may need to be re-imported from the original location.',
      );
      return false;
    }

    if (entry.kind === 'scene') {
      await importSceneFile(file);
      return true;
    }

    await loadFiles([file]);
    return true;
  }, [importSceneFile, loadFiles, recentOpenedFiles]);

  // Clears the recent-files list: localStorage entries + cached blobs in IndexedDB.
  const clearRecentOpenedFiles = useCallback(() => {
    const ids = recentOpenedFiles.map((entry) => entry.id);
    setRecentOpenedFiles([]);
    writeRecentOpenedFilesToLocalStorage([]);
    if (ids.length > 0) {
      void deleteRecentOpenedFileBlobs(ids);
    }
  }, [recentOpenedFiles]);

  // Legacy support JSON loader wrapper
  const handleLoadSupportJson = async () => {
    try {
      const res = await fetch('/dragonfruit_supports.json');
      const data = await res.json();
      applyImportDefaultsToRaftState();
      loadFromImportFormat(data);
      console.log('Loaded support JSON:', data);
    } catch (e) {
      console.error('Failed to load support JSON:', e);
    }
  };

  // Support JSON import handler (Legacy - single step)
  const importSupportDataFile = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const json = JSON.parse(text) as unknown;
      const parsed = asDragonfruitImportFormat(json);
      if (!parsed) {
        emitSceneImportReport('Support import failed: unsupported support JSON format.', 'error');
        return;
      }

      applyImportDefaultsToRaftState();
      loadFromImportFormat(parsed);
      emitSceneImportReport('Imported support data.', 'success');

    } catch (err) {
      console.error('[SceneCollection] Failed to import support JSON:', err);
      emitSceneImportReport('Support import failed.', 'error');
    }
  }, [emitSceneImportReport]);

  const pluginImportPhase: 'idle' | 'awaiting_stl' | 'processing' = 'idle';
  const pluginImportError: string | null = null;
  const handlePluginJsonFile: ((file: File) => void) | undefined = undefined;
  const handlePluginStlFile: ((file: File) => void) | undefined = undefined;
  const cancelPluginImport: (() => void) | undefined = undefined;

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

        const hasColorAttribute = !!m.geometry.geometry.getAttribute('color');
        if (hasColorAttribute) {
          try {
            clearPaintToBase(m.geometry.geometry, new THREE.Color(normalizedColor));
          } catch (err) {
            console.error('[SceneCollection] Failed to apply mesh color to geometry:', err);
          }
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
      heatmapMinAngle: prev?.heatmapMinAngle ?? heatmapMinAngle,
      heatmapMaxAngle: prev?.heatmapMaxAngle ?? heatmapMaxAngle,
      heatmapColors: prev?.heatmapColors ?? heatmapColors,
      meshColor: normalizedColor,
      selectionColor: prev?.selectionColor ?? selectionColor,
      hoverColor: prev?.hoverColor ?? hoverColor,
      hoverTintStrength: prev?.hoverTintStrength ?? hoverTintStrength,
      selectedTintStrength: prev?.selectedTintStrength ?? selectedTintStrength,
    });
  }, [activeModelId, ambientIntensity, directionalIntensity, flatUseVertexColors, heatmapMinAngle, heatmapColors, heatmapMaxAngle, hoverColor, hoverTintStrength, materialRoughness, matcapVariant, selectedTintStrength, selectionColor, shaderType, toonSteps, wireframeThicknessPx, xrayOpacity]);

  const setMeshVisible = useCallback((visible: boolean) => {
    if (activeModelId) {
      setModelVisibility(activeModelId, visible);
    }
  }, [activeModelId, setModelVisibility]);

  const toggleSupportDesignation = useCallback((modelIds: string[], isSupport: boolean) => {
    if (modelIds.length === 0) return;
    const targetIds = new Set(modelIds);
    const affectedModels = models.filter((m) => targetIds.has(m.id));
    if (affectedModels.length === 0) return;
    const needsChange = affectedModels.some((m) => Boolean(m.isSupportGeometry) !== isSupport);
    if (!needsChange) return;

    const before = captureSceneSnapshot(models, activeModelId, selectedModelIds);
    const nextModels = models.map((m) => {
      if (targetIds.has(m.id)) {
        return { ...m, isSupportGeometry: isSupport };
      }
      return m;
    });

    setModels(nextModels);
    const after = captureSceneSnapshot(nextModels, activeModelId, selectedModelIds);
    pushSceneSnapshotHistory(
      before,
      after,
      isSupport ? 'Mark as Support Geometry' : 'Mark as Model Geometry',
    );
  }, [activeModelId, models, pushSceneSnapshotHistory, selectedModelIds]);

  const linkModels = useCallback((idsInput: string[]) => {
    const ids = new Set(idsInput);
    if (ids.size < 2) return;

    const currentModels = modelsRef.current;
    const targetModels = currentModels.filter((m) => ids.has(m.id));
    if (targetModels.length < 2) return;

    const currentActiveModelId = activeModelIdRef.current;
    const currentSelectedModelIds = selectedModelIdsRef.current;

    const before = captureSceneSnapshot(currentModels, currentActiveModelId, currentSelectedModelIds);
    const linkGroupId = `link-${uuidv4()}`;

    const nextModels = currentModels.map((m) => {
      if (ids.has(m.id)) {
        return { ...m, linkGroupId };
      }
      return m;
    });

    setModels(nextModels);
    const after = captureSceneSnapshot(nextModels, currentActiveModelId, currentSelectedModelIds);
    pushSceneSnapshotHistory(before, after, `Link ${targetModels.length} Models`);
  }, [pushSceneSnapshotHistory]);

  const unlinkModels = useCallback((idsInput: string[]) => {
    const ids = new Set(idsInput);
    if (ids.size === 0) return;

    const currentModels = modelsRef.current;
    const targetModels = currentModels.filter((m) => ids.has(m.id) && m.linkGroupId);
    if (targetModels.length === 0) return;

    const currentActiveModelId = activeModelIdRef.current;
    const currentSelectedModelIds = selectedModelIdsRef.current;

    const before = captureSceneSnapshot(currentModels, currentActiveModelId, currentSelectedModelIds);
    const affectedGroupIds = new Set(targetModels.map((m) => m.linkGroupId!));

    let nextModels = currentModels.map((m) => {
      if (ids.has(m.id)) {
        return { ...m, linkGroupId: undefined };
      }
      return m;
    });

    affectedGroupIds.forEach((gId) => {
      const remaining = nextModels.filter((m) => m.linkGroupId === gId);
      if (remaining.length < 2) {
        nextModels = nextModels.map((m) => {
          if (m.linkGroupId === gId) {
            return { ...m, linkGroupId: undefined };
          }
          return m;
        });
      }
    });

    setModels(nextModels);
    const after = captureSceneSnapshot(nextModels, currentActiveModelId, currentSelectedModelIds);
    pushSceneSnapshotHistory(before, after, `Unlink ${targetModels.length} Models`);
  }, [pushSceneSnapshotHistory]);

  /**
   * Re-runs the full native repair pipeline on an already-loaded model's
   * geometry and swaps the result back in-place.  Intended for the manual
   * "Repair Mesh" context-menu action.
   */
  const repairModelInPlace = useCallback(async (modelId: string): Promise<boolean> => {
    const model = modelsRef.current.find(m => m.id === modelId);
    if (!model) return false;
    try {
      const processed = await processGeometry(model.geometry.geometry, {
        center: false,
        nativeProcessingMode: 'repair',
        assumeSupportGeometry: model.isSupportGeometry,
      });
      const posAttr = processed.geometry.getAttribute('position') as THREE.BufferAttribute | null;
      const polygonCount = posAttr ? Math.floor(posAttr.count / 3) : model.polygonCount;
      const repairReport = processed.meshDefects?.nativeRepairReport ?? null;

      setModels(prev => prev.map(m =>
        m.id === modelId ? { ...m, geometry: processed, polygonCount } : m
      ));

      if (repairReport) {
        const reportEntry: MeshRepairReportEntry = {
          id: modelId,
          modelName: model.name,
          report: repairReport,
        };
        setPendingMeshRepairReports([]);
        clearSceneImportReport();
        setMeshRepairReportPresentation('optimistic');
        setMeshRepairReports([reportEntry]);
      } else {
        setPendingMeshRepairReports([]);
        emitSceneImportReport(`Repaired ${model.name}.`, 'success');
      }

      return true;
    } catch (err) {
      console.error('[repairModelInPlace] Repair failed:', err);
      setPendingMeshRepairReports([]);
      const message = err instanceof Error ? err.message : String(err);
      emitSceneImportReport(`Repair failed: ${message}`, 'error', { durationMs: 6_000 });
      return false;
    }
  }, [clearSceneImportReport, emitSceneImportReport]);

  // Cleanup on unmount
  useEffect(() => {
    const previous = trackedGeometriesRef.current;
    const next = new Set<THREE.BufferGeometry>(models.map((model) => model.geometry.geometry));

    for (const clipboardEntry of modelClipboard) {
      next.add(clipboardEntry.geometry.geometry);
    }

    for (const snapshot of sceneSnapshotRegistry.values()) {
      for (const model of snapshot.before.models) {
        next.add(model.geometry.geometry);
      }
      for (const model of snapshot.after.models) {
        next.add(model.geometry.geometry);
      }
    }

    const removed: THREE.BufferGeometry[] = [];
    for (const geometry of previous) {
      if (next.has(geometry)) continue;
      removed.push(geometry);
    }
    deferDisposeGeometries(removed);

    trackedGeometriesRef.current = next;
  }, [deferDisposeGeometries, modelClipboard, models]);

  // Sync model geometries into the auto-brace mesh store so clearance checks can access them.
  useEffect(() => {
    const currentIds = new Set(models.map((m) => m.id));
    for (const model of models) {
      const matrix = new THREE.Matrix4().compose(
        model.transform.position,
        quaternionFromGlobalEuler(model.transform.rotation),
        model.transform.scale,
      );
      registerMeshForAutoBrace(model.id, model.geometry.geometry, matrix);
    }
    return () => {
      for (const id of currentIds) {
        unregisterMeshForAutoBrace(id);
      }
    };
  }, [models]);

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && sceneImportReportTimeoutRef.current !== null) {
        window.clearTimeout(sceneImportReportTimeoutRef.current);
        sceneImportReportTimeoutRef.current = null;
      }

      models.forEach(m => tryRevokeObjectUrl(m.fileUrl));

      const tracked = trackedGeometriesRef.current;
      for (const geometry of tracked) {
        try {
          disposeGeometryBVH(geometry);
        } catch {
          // ignore disposal failures
        }
        try {
          geometry.dispose();
        } catch {
          // ignore disposal failures
        }
      }
      tracked.clear();
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
        quaternionFromGlobalEuler(t.rotation),
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
    lastLoadedVoxlFormatChunkedRef,
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
    sceneImportReport,
    clearSceneImportReport,
    meshRepairReports,
    meshRepairReportPresentation,
    openPendingMeshRepairReports,
    dismissMeshRepairReports,
    sceneImportPlacementPrompt,
    resolveSceneImportPlacementPrompt,
    meshRepairConfirmPrompt,
    resolveMeshRepairConfirmPrompt,
    repairModelInPlace,
    recentOpenedFiles,
    reopenRecentOpenedFile,
    clearRecentOpenedFiles,
    view3dSettings,
    setView3dSettings,

    // Actions
    loadFiles,
    onFileChange,
    updateModelTransform,
    commitModelTransformHistory,
    updateModelTransforms,
    setModelTransformRaw,
    replaceModelGeometry,
    addModelFromGeometry,
    splitModelIntoParts,
    finalizeModelGeometryPostProcessing,
    setModelManualZMoveOverride,
    setModelVisibility,
    toggleSupportDesignation,
    linkModels,
    unlinkModels,
    setModelMeshModifiers,
    getModelMeshModifiers: useCallback((id: string) => getStoredMeshModifiers(id), []),
    renameModel,
    groupModels,
    ungroupModels,
    ungroupGroup,
    splitImportGroup,
    splitSupports,
    mergeSupports,
    renameGroup,
    selectGroup,
    deleteModels,
    deleteModel,
    deleteSupportsForModels,
    copyModel,
    copySelectedModels,
    cutModel,
    pasteModel,
    pasteCopiedModelsAutoArrange,
    duplicateModelWithTransforms,
    setBackgroundGeometryWorkPaused,
    hasPendingBackgroundGeometryWork,
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
    heatmapMinAngle,
    setHeatmapMinAngle,
    heatmapMaxAngle,
    setHeatmapMaxAngle,
    shaderType,
    setShaderType,
    matcapVariant,
    setMatcapVariant,
    flatUseVertexColors,
    setFlatUseVertexColors,
    toonSteps,
    setToonSteps,
    selectionColor,
    setSelectionColor,
    hoverColor,
    setHoverColor,
    hoverTintStrength,
    setHoverTintStrength,
    selectedTintStrength,
    setSelectedTintStrength,
    mode,
    setMode,
    heatmapColors,
    setHeatmapColors,
    scanModelForSupportsInPlace,
    onHeatmapColorChange: useCallback((index: number, color: string) => {
      setHeatmapColors(prev => {
        const next = [...prev];
        next[index] = color;
        return next;
      });
    }, []),

    // Legacy/Other
    handleLoadSupportJson,
    importSupportDataFile,

    // Two-Step Plugin Scene Import
    pluginImportPhase: pluginImportPhase as 'idle' | 'awaiting_stl' | 'processing',
    pluginImportError,
    handlePluginJsonFile,
    handlePluginStlFile,
    cancelPluginImport,

    // Plugin Scene Import (1-step)
    importPluginSceneFile: handleImportPluginSceneFile,
    importSceneFile,
    importSceneFiles,
    onImportSceneChange,

    // Debug primitives
    addDebugPrimitive,
    clearDebugModels
  };
}

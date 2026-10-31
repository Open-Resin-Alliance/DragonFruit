import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import * as THREE from 'three';
import { loadTauriCore, refineCoarseFaces, shouldRefineCoarseFaces } from '@/utils/tauriMeshBridge';
import { solidRemeshFromGeometry, tetSurfaceFromGeometry, type SolidRemeshProgressSink, type SolidRemeshOptions, type TetSurfaceProgressSink, type TetWrapOptions } from '@/utils/meshShrinkwrap';
import { useLocaleFormat } from '@/hooks/useLocaleFormat';
import { loadMeshGeometry, loadMeshGeometryFromRange, load3mfGeometryMergedWithSplitData, processGeometry, skipsNativePassForModelOnly, type GeometryWithBounds, type ProcessGeometryOptions } from '@/hooks/useStlGeometry';
import type { MeshHealthReport, MeshAnalysisJson, MeshRepairProgressSink } from '@/utils/meshRepair';
import { loadMeshFromPath } from '@/utils/meshRepair';
import { computeFlatteningPlanes } from '@/features/placeOnFace/logic/computeFlatteningPlanes';
import {
  DYNAMIC_PLATE_ORDERING,
  VOXL_PLATE_ORDERING_EXTENSION,
  plateCascadeOffsetMm,
  readPlateOrdering,
  type PlateOrdering,
} from '@/features/scene/plates/plateCascade';
import {
  computePlateFrames,
  modelsOnPlate,
  plateLocalRect,
  resolveModelPlateId as plateIdForModel,
  withPlateMembership,
  type PlateFrame,
} from '@/features/scene/plates/plateLayout';
import { detectObsoleteVoxlVersion, isVoxlBinaryV2, meshChunkStore, parseVoxlBinaryV2, readScenePlates, readSidecarFileBytes, resolveOriginalRefSidecar, VoxlObsoleteVersionError, type VoxlDocumentV1, type VoxlMeshRef, type VoxlMeshRange } from '@/features/scene/voxl';
import { clearPaintToBase } from '@/components/analysis/MeshPainter';
import { countSupportEntities, getSnapshot, loadFromImportFormat, mergeFromImportFormat, reassignAllSupportModelIds, resetStore, setSnapshot as setSupportSnapshot, transformAllSupportsForSingleModel, transformSupportsForModel } from '@/supports/state';
import { registerDeleteHandler } from '@/features/delete/deleteRegistry';
import { peekUndo } from '@/history/historyStore';
import { createTypedHistory } from '@/history/typedHistory';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { forgetCenteredPositions } from '@/utils/modelBounds';
import { releasePrepareMergedSupportsFor } from '@/supports/prepare/mergedSupportCache';
import { releaseGeometryStorage as releaseGeometryStorageBase } from '@/utils/releaseGeometry';
import { disposeSpilledSceneSnapshot, hasSpilledSceneSnapshot, pruneSpilledSceneSnapshots, rehydrateSceneSnapshotPair, spillSceneSnapshotPair, spilledSceneSnapshotBytes } from './sceneSnapshotSpill';
import type { DragonfruitImportFormat, SupportMode, SupportState } from '@/supports/types';
import { getBuiltinComplexPluginDefinitions } from '@/features/plugins/builtinComplexPlugins';
import { getBuiltinComplexPluginFileTypeHandlers } from '@/features/plugins/builtinComplexPluginFileTypeHandlers';
import type { PluginFileTypeDefinition } from '@/features/plugins/complexPluginContracts';
import type { PluginFileTypeHandler } from '@/features/plugins/pluginFileTypeBridge';
import { accelerateGeometry, disposeGeometryBVH } from '@/utils/bvh';
import { runWithConcurrency } from '@/utils/runWithConcurrency';
import { logToNativeFile } from '@/utils/nativeLog';
import { BAKED_OCCLUSION_ATTRIBUTE, DEFAULT_BAKED_OCCLUSION_INTENSITY, bakeOcclusionForGeometry, bumpBakedOcclusionVersion, canBakeOcclusion, setBakedOcclusionIntensity } from '@/features/scene/bakedOcclusion';
import { computeProjectedFootprintSize } from '@/utils/modelFootprint';
import { shelfPack, type ShelfItem } from '@/features/scene/arrange/shelfPack';
import { eulerFromGlobalEuler, quaternionFromGlobalEuler } from '@/utils/rotation';
import { v4 as uuidv4 } from 'uuid';
import {
  importDetailAutoRepairingFile,
  importDetailAutoRepairingMesh,
  importDetailClassifyingFile,
  importDetailClassifyingMesh,
  importDetailFinalizing,
  importDetailFinalizingModel,
  importDetailIndexedFile,
  importDetailInspectingFile,
  importDetailInspectingMesh,
  importDetailLoadingFile,
  importDetailPreparing,
  importDetailPreparingGeometry,
  importDetailProcessedCount,
  importDetailRecombiningGeometry,
  importDetailSeparatingGeometry,
  importDetailVoxlModel,
  importLabelAutoRepairing,
  importLabelClassifying,
  importLabelFileType,
  importLabelInspecting,
  importLabelLoadingMesh,
  importLabelMergingSupports,
  importLabelScanningSupports,
  importLabelScenes,
  importLabelSplittingSupports,
  importLabelVoxlScene,
  alertSceneImportFailed,
  reportAutoRepaired,
  reportImportedScene,
  reportMergeSupportsFailed,
  reportNoSceneImportHandler,
  reportRestoredModel,
  reportScanFailed,
  reportScanned,
  reportSceneFilesAllFailed,
  reportSceneFilesImported,
  reportSceneFilesPartlyImported,
  reportSceneImportFailed,
  reportSplitSupportsFailed,
  reportSupportJsonFailed,
  reportSupportJsonImported,
  reportSupportJsonUnsupported,
  reportUnsupportedSceneFile,
  reportVoxlImportFailed,
  reportVoxlNoMeshes,
  reportVoxlUnsupportedVersion,
} from '@/features/scene/sceneImportMessages';
import { duplicatedModelName, pastedModelName } from '@/features/scene/modelCopyNames';
import {
  repairCancelledMessage,
  repairedModelsMessage,
  remeshedMessage,
  repairFailedForModelMessage,
  repairFailedMessage,
  repairStoppedMessage,
  tetSurfacedMessage,
  shrinkWrappedMessage,
} from '@/features/scene/meshRepairMessages';
import {
  addPlateLabel,
  colorModelLabel,
  DELETE_MODELS_AND_PLATES_LABEL,
  deleteModelLabel,
  deleteModelsLabel,
  deletePlateLabel,
  deleteSupportsForModelLabel,
  deleteSupportsForModelsLabel,
  duplicateModelLabel,
  duplicateModelsLabel,
  hideModelLabel,
  linkModelsLabel,
  MARK_AS_MODEL_LABEL,
  MARK_AS_SUPPORT_LABEL,
  mergeSupportsLabel,
  pasteModelLabel,
  pasteModelsLabel,
  renameLabel,
  repairModelLabel,
  repairModelsLabel,
  SCENE_CHANGE_LABEL,
  showModelLabel,
  shrinkWrapModelLabel,
  splitModelLabel,
  splitSupportsLabel,
  SWITCH_PRINTER_LABEL,
  switchPrinterLabel,
  tetSurfaceModelLabel,
  solidRemeshModelLabel,
  transformModelLabel,
  transformModelsLabel,
  unlinkModelsLabel,
} from '@/features/scene/sceneHistoryLabels';
import { registerMeshForAutoBrace, unregisterMeshForAutoBrace } from '@/supports/autoBracing/meshGeometryStore';
import { MODEL_EDGE_OVERLAY_ENABLED, buildModelEdgeGeometry } from '@/hooks/useStlGeometry';
import { MESH_SHADER_TYPES, type MatcapVariant, type MeshShaderType } from '@/features/shaders/mesh';
import {
  getSavedWorkspaceCameraSettings,
  getWorkspaceCameraSettingsServerSnapshot,
  getWorkspaceCameraSettingsSnapshot,
  subscribeToWorkspaceCameraSettings,
} from '@/components/settings/workspaceCameraPreferences';
import {
  DEFAULT_VIEW3D_SETTINGS,
  getSavedView3DSettings,
  normalizeView3DSettings,
  saveView3DSettings,
  type View3DSettings,
} from '@/components/settings/view3dPreferences';
import { followedPlateIdForMove, rectStandsOnAnyBed } from '@/features/scene/plates/plateInteractivity';
import {
  getMultiPlateSettingsServerSnapshot,
  getMultiPlateSettingsSnapshot,
  plateOrderingFor,
  subscribeToMultiPlateSettings,
} from '@/components/settings/multiPlatePreferences';
import {
  getActivePrinterProfile,
  getMaterialProfilesForPrinter,
  getProfileStoreSnapshot,
  getProfileStoreServerSnapshot,
  importPrinterBundle,
  setActivePrinterProfile,
  subscribeToProfileStore,
} from '@/features/profiles/profileStore';
import {
  buildVolumeIsSmaller,
  findPrinterProfileForBundle,
  toVoxlPrinterBundle,
} from '@/features/profiles/voxlPrinterBundle';
import type { VoxlPrinterBundle } from '@/features/scene/voxl/types';
import { base64ToBytes } from '@/utils/base64';
import { snapshotGeometryPositions } from '@/utils/geometrySnapshot';
import type { ModelMeshModifiers, ModelMeshModifiersHistoryOptions } from '@/features/mesh-modifiers/types';
import { countTriangles } from '@/utils/geometry';
import {
  deleteStoredMeshModifiers,
  getStoredMeshModifiers,
  storeModelMeshModifiers,
} from '@/features/mesh-modifiers/meshModifierStore';
import { clearPreparedGeometryCacheForModel } from '@/features/mesh-modifiers/prepareModelGeometry';
import { splitClassifiedSupportGeometry } from '@/features/scene/splitClassifiedSupports';
import {
  applyModelGrouping,
  applyModelGroupUngrouping,
  applyModelUngrouping,
} from '@/features/scene/modelGroupingHistory';
import { performModelCut, selectModelsForClipboard } from '@/features/scene/modelCut';

type PersistedMeshAppearance = {
  v: 1;
  /** The view mode the camera dropdown shows, which is also the shader the viewport renders. */
  shaderType: MeshShaderType;
  /** The type the Mesh settings tab is configuring. Independent of what the viewport renders. */
  configuredShaderType: MeshShaderType;
  matcapVariant: MatcapVariant;
  flatUseVertexColors: boolean;
  ambientIntensity: number;
  directionalIntensity: number;
  materialRoughness: number;
  /** Multiplier on the baked occlusion's strength; 0 disables the bake. */
  bakedAoIntensity: number;
  wireframeThicknessPx: number;
  xrayOpacity: number;
  heatmapMinAngle: number;
  heatmapMaxAngle: number;
  heatmapColors: string[];
  meshColor: string;
  hoverTintStrength: number;
  selectedTintStrength: number;
};

/**
 * Ambient-occlusion bakes in flight at once (see the scheduling comment in the
 * bake effect). Each command is internally parallel across vertices, so this is
 * about hiding the serial phases — weld, tree build, IPC — of one model behind
 * another model's ray pass, not about using more cores per model.
 */
const AO_BAKE_CONCURRENCY = 2;

/**
 * VOXL meshes built at once.
 *
 * Was two, on the reasoning that each build is a native round trip whose serial
 * phases want overlapping. Measured on the 13-model scene, two left both workers
 * stalled: the native load is only 0.17-0.25 s (`[load_mesh_bytes] parsed, refined
 * and encoded in …`) while the round trip a build waits on is 1.4-2.3 s, because
 * the wire (65-81 MB a model at ~125 MB/s) and the *single main thread* that
 * decodes, accelerates and computes planes for each model are shared resources. A
 * build's own work is ~1.2 s of that, so the rest is one worker waiting for the
 * other's turn. Four in flight keeps the wire busy and gives the main thread a
 * queue to work through instead of handing it one model at a time. The cost is
 * memory: each in-flight build holds its payload (52-81 MB here) and its geometry.
 */
const VOXL_BUILD_CONCURRENCY = 4;

/**
 * How many beds a paste will add for the copies that do not fit the plate being worked
 * on. A run adds a bed only when the previous one could not take anything, so this is a
 * guard against a copy larger than a bed rather than a real limit.
 */
const MAX_PASTE_PLATES = 32;

/** The same guard for an import: a bed per spill, never an unbounded run of them. */
const MAX_IMPORT_PLATES = 32;

/** Gap between imported models, wider than arrange's own so a rough plate is
 *  easier to pick apart by hand. */
const IMPORT_ARRANGE_SPACING_MM = 10;

const MESH_APPEARANCE_STORAGE_KEY = 'mesh-appearance-settings';

const DEFAULT_MESH_COLOR = '#a3a3a3';
// Split so the Mesh tab's derived sliders read Lightness 1.40, Contrast 0.80
// (contrast = directional / (ambient + directional)).
const DEFAULT_AMBIENT_INTENSITY = 0.28;
const DEFAULT_DIRECTIONAL_INTENSITY = 1.12;
const DEFAULT_MATERIAL_ROUGHNESS = 0.55;
const DEFAULT_WIREFRAME_THICKNESS_PX = 1.5;
const DEFAULT_XRAY_OPACITY = 0.25;
const DEFAULT_HEATMAP_MIN_ANGLE = 0;
const DEFAULT_HEATMAP_MAX_ANGLE = 45;
export const DEFAULT_HEATMAP_COLORS = ['#E55959', '#E5A559', '#D9D959', '#73D973', '#666666'];
const DEFAULT_SHADER_TYPE: MeshShaderType = 'soft_clay';
const DEFAULT_MATCAP_VARIANT: MatcapVariant = 'neutral';
const DEFAULT_FLAT_USE_VERTEX_COLORS = true;
export const DEFAULT_HOVER_TINT_STRENGTH = 0.5;
export const DEFAULT_SELECTED_TINT_STRENGTH = 0.70;
const RECENT_OPENED_FILES_STORAGE_KEY = 'app-recent-opened-files';
const RECENT_OPENED_FILES_LIMIT = 10;
const RECENT_FILES_DB_NAME = 'dragonfruit-recent-files';
const RECENT_FILES_DB_VERSION = 1;
const RECENT_FILES_STORE_NAME = 'files';
export const SCENE_MODELS_SNAPSHOT_APPLY = 'scene_models_snapshot_apply' as const;
const SCENE_HISTORY_MAX_SNAPSHOTS = 200;
// Belt-and-suspenders alongside the count cap above: a handful of
// full-resolution geometry swaps (e.g. repeated hollowing on a large model)
// can retain far more memory per snapshot than typical small edits, so the
// flat count cap alone can leave a lot of stale geometry pinned alive.
const SCENE_HISTORY_MAX_ESTIMATED_GEOMETRY_BYTES = 300 * 1024 * 1024;
// A clear spills the scene's whole geometry — hundreds of MB to a few GB — so
// the scratch store needs its own ceiling: the RAM budget above never sees a
// spilled snapshot's bytes, and a long session would otherwise fill the disk.
const SCENE_HISTORY_MAX_SPILLED_BYTES = 4 * 1024 * 1024 * 1024;
// Modifier edits of the same kind on the same model this close together are one
// step: the panels' number fields report every keystroke and every wheel notch.
const MODIFIER_HISTORY_MERGE_WINDOW_MS = 1000;

type SceneSnapshotPayload = { key: string; modelId?: string };

/** Action→payload map for the scene history domain. */
type SceneHistoryPayloadMap = {
  [SCENE_MODELS_SNAPSHOT_APPLY]: SceneSnapshotPayload;
};
const sceneHistory = createTypedHistory<SceneHistoryPayloadMap>({
  [SCENE_MODELS_SNAPSHOT_APPLY]: SCENE_CHANGE_LABEL,
});

export type SceneSnapshot = {
  models: LoadedModel[];
  activeModelId: string | null;
  selectedModelIds: string[];
  supportState?: SupportState;
  modifierRecord?: { modelId: string; modifiers: ModelMeshModifiers | undefined };
  /**
   * The beds, on the entries that add or remove one. Optional: a snapshot without
   * them leaves the plate list exactly as it is, which is what every entry that
   * only touches models wants.
   */
  plates?: ScenePlate[];
  activePlateId?: string;
  /**
   * The printer the scene was made under. On every snapshot, not only the ones that switch
   * it: the beds are spaced by the build volume, so an entry taken under one printer and
   * undone under another lands its models against frames that never applied to them.
   * `null` is no printer — "use without Printer" — and `undefined` is a snapshot taken
   * before this was recorded, which leaves the profile alone.
   */
  printerProfileId?: string | null;
};

type SceneSnapshotCaptureOptions = {
  includeSupportState?: boolean;
  supportStateOverride?: SupportState;
  /** The override is already an owned snapshot and must not be cloned again. */
  supportStateOwned?: boolean;
  /** Record the plate list on this snapshot, for the entries that change it. */
  plates?: ScenePlate[];
  activePlateId?: string;
  /**
   * The printer this snapshot belongs to. Defaults to the active one, which is right for
   * every entry but the "before" of a printer switch: by the time that entry is pushed the
   * store already holds the new profile.
   */
  printerProfileId?: string | null;
};

type TransformHistorySupportSnapshotOptions = {
  supportBefore?: SupportState;
  supportAfter?: SupportState;
  includeSupportState?: boolean;
};

/**
 * One model whose supports were moved with it, recorded instead of a copy of the
 * whole support store. A transform rewrites positions by a delta, so undo is the
 * same call with the ends swapped; cloning ~20k entities twice per drag bell was
 * the single biggest cost of committing a move.
 */
export type SupportTransformMove = {
  modelId: string;
  from: ModelTransform;
  to: ModelTransform;
};

export type SceneSnapshotPair = {
  before: SceneSnapshot;
  after: SceneSnapshot;
  /**
   * Present on a pure transform step: the pair carries no support state, and the
   * history handler replays these transforms instead (inverse on undo).
   */
  supportMoves?: SupportTransformMove[];
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

function cloneMeshModifiersForHistory(modifiers: ModelMeshModifiers | null | undefined): ModelMeshModifiers | undefined {
  if (!modifiers) return undefined;
  const hollowing = modifiers.hollowing;
  const clonePlacements = (placements: typeof modifiers.holePunches) => placements?.map((placement) => ({
    ...placement,
    centerNorm: placement.centerNorm.slice() as typeof placement.centerNorm,
    direction: placement.direction.slice() as typeof placement.direction,
  }));
  return {
    ...modifiers,
    hollowing: hollowing ? {
      ...hollowing,
      blockedVoxelIndices: hollowing.blockedVoxelIndices?.slice(),
      blockedVoxelRotationQuat: hollowing.blockedVoxelRotationQuat?.slice() as typeof hollowing.blockedVoxelRotationQuat,
    } : hollowing,
    holePunches: clonePlacements(modifiers.holePunches),
    holePunchAppliedPlacements: clonePlacements(modifiers.holePunchAppliedPlacements),
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

function captureSceneSnapshot(
  models: LoadedModel[],
  activeModelId: string | null,
  selectedModelIds: string[],
  options?: SceneSnapshotCaptureOptions,
): SceneSnapshot {
  const includeSupportState = options?.includeSupportState ?? false;
  const supportStateOverride = options?.supportStateOverride;
  const printerProfileId = options?.printerProfileId !== undefined
    ? options.printerProfileId
    : (getActivePrinterProfile()?.id ?? null);

  return {
    models: models.map(cloneLoadedModel),
    activeModelId,
    selectedModelIds: [...selectedModelIds],
    printerProfileId,
    ...(includeSupportState
      ? {
          supportState: options?.supportStateOwned && supportStateOverride
            ? supportStateOverride
            : clonePlainData(supportStateOverride ?? getSnapshot()),
        }
      : {}),
    ...(options?.plates
      ? {
          plates: options.plates.map((plate) => ({ ...plate })),
          activePlateId: options.activePlateId,
        }
      : {}),
  };
}

/** Repaints a model's vertex colours, when it has any, to a flat `color`. */
function paintModelBaseColor(model: LoadedModel, color: string): void {
  if (!model.geometry.geometry.getAttribute('color')) return;
  try {
    clearPaintToBase(model.geometry.geometry, new THREE.Color(color));
  } catch (err) {
    console.error('[SceneCollection] Failed to apply mesh color to geometry:', err);
  }
}

/** Whether any support entity of any type belongs to this model. */
function hasSupportsForModel(modelId: string, supportState: SupportState): boolean {
  const supportIds = getSupportsForModel(supportState, modelId);
  return Object.values(supportIds).some((ids) => ids.length > 0);
}

/**
 * Supports are kept in world space, apart from their model, so a relayout of the beds that
 * slides a model has to slide its supports by the same move, or they stay standing where the
 * bed used to be. A model the relayout left alone keeps its transform object, and is skipped.
 */
function shiftSupportsWithModels(before: readonly LoadedModel[], after: readonly LoadedModel[]): void {
  if (before === after) return;
  const previous = new Map(before.map((model) => [model.id, model.transform]));
  for (const model of after) {
    const was = previous.get(model.id);
    if (was && was !== model.transform) transformSupportsForModel(model.id, was, model.transform);
  }
}

/** The support store, for a snapshot of `models`, when any of them has supports to restore. */
function supportStateFor(models: readonly LoadedModel[]): SupportState | undefined {
  const supportState = getSnapshot();
  return models.some((model) => hasSupportsForModel(model.id, supportState)) ? supportState : undefined;
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

let liveModelsProvider: (() => LoadedModel[]) | null = null;
let extraRetainedGeometriesProvider: (() => Iterable<THREE.BufferGeometry>) | null = null;

function installLiveModelsProvider(provider: (() => LoadedModel[]) | null): void {
  liveModelsProvider = provider;
}

function installExtraRetainedGeometries(provider: (() => Iterable<THREE.BufferGeometry>) | null): void {
  extraRetainedGeometriesProvider = provider;
}

function modelGeometries(model: Pick<LoadedModel, 'geometry'>): THREE.BufferGeometry[] {
  const geometries: THREE.BufferGeometry[] = [model.geometry.geometry];
  if (model.geometry.edgeGeometry) geometries.push(model.geometry.edgeGeometry);
  const defects = model.geometry.meshDefects;
  if (defects?.supportSectionGeometry) geometries.push(defects.supportSectionGeometry);
  if (defects?.modelSectionGeometry) geometries.push(defects.modelSectionGeometry);
  return geometries;
}

/**
 * Releases everything a geometry owns, not just its GPU buffers. `dispose()`
 * alone leaves the typed arrays reachable while any stale fiber, render list or
 * module cache still points at the geometry — which is what kept a cleared scene
 * resident. Attributes are dropped too, so those references become cheap.
 */
function releaseGeometryStorage(geometry: THREE.BufferGeometry): void {
  forgetCenteredPositions(geometry);
  releaseGeometryStorageBase(geometry);
}

/**
 * Disposes the geometry a history pair owned once no snapshot, live model or
 * clipboard still references it. Deleting a registry entry alone leaves the
 * renderer's attribute buffers and the mesh arrays resident for the rest of the
 * session, which is why an emptied scene used to keep its whole RAM footprint.
 *
 * The release runs on an idle callback and re-checks the retained set there:
 * the frame that stopped drawing these geometries must finish first, and an
 * undo that lands in between puts one of them back in the scene.
 */
function disposeEvictedSnapshot(pair: SceneSnapshotPair): void {
  const candidates = new Set<THREE.BufferGeometry>();
  for (const model of pair.before.models) modelGeometries(model).forEach((geometry) => candidates.add(geometry));
  for (const model of pair.after.models) modelGeometries(model).forEach((geometry) => candidates.add(geometry));
  if (candidates.size === 0) return;

  const release = () => {
    const retained = retainedSnapshotGeometries('');
    for (const geometry of candidates) {
      if (retained.has(geometry)) continue;
      releaseGeometryStorage(geometry);
    }
  };
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(release, { timeout: 500 });
  } else {
    setTimeout(release, 50);
  }
}

/** Geometry another snapshot, a live model or the clipboard still needs. */
function retainedSnapshotGeometries(
  excludeKey: string,
  liveModels?: readonly LoadedModel[],
  includeSceneProvider = true,
): Set<THREE.BufferGeometry> {
  const retained = new Set<THREE.BufferGeometry>();
  for (const [key, pair] of sceneSnapshotRegistry) {
    if (key === excludeKey) continue;
    pair.before.models.forEach((model) => modelGeometries(model).forEach((geometry) => retained.add(geometry)));
    pair.after.models.forEach((model) => modelGeometries(model).forEach((geometry) => retained.add(geometry)));
  }
  // The caller's list is the scene the action is about to commit; the provider
  // is whatever is drawn RIGHT NOW. A spill awaits disk writes, so an undo can
  // land in between — both sets have to be treated as live.
  for (const model of liveModels ?? []) {
    modelGeometries(model).forEach((geometry) => retained.add(geometry));
  }
  if (includeSceneProvider) {
    for (const model of liveModelsProvider?.() ?? []) {
      modelGeometries(model).forEach((geometry) => retained.add(geometry));
    }
  }
  for (const geometry of extraRetainedGeometriesProvider?.() ?? []) retained.add(geometry);
  return retained;
}

/**
 * Moves a snapshot's geometry to the scratch store. `liveModels` is the set that
 * will be standing after the action that pushed the pair; pass it explicitly when
 * the ref has not committed yet (a delete), or the deleted meshes still look live
 * and nothing is released.
 *
 * Selection uses that list ALONE: React has not committed the delete when the
 * pair is pushed, so the scene provider still reports the deleted models as
 * live. The release predicate is a different question — by the time the arrays
 * are dropped the commit has landed, and an undo may have restored them — so it
 * asks the live scene again.
 */
async function spillSceneSnapshotKey(key: string, liveModels?: readonly LoadedModel[]): Promise<boolean> {
  const pair = sceneSnapshotRegistry.get(key);
  if (!pair || hasSpilledSceneSnapshot(key)) return false;
  const retainedAtSpill = retainedSnapshotGeometries(key, liveModels, liveModels === undefined);
  const spilled = await spillSceneSnapshotPair(
    key,
    pair,
    (geometry) => !retainedAtSpill.has(geometry),
    (geometry) => !retainedSnapshotGeometries(key).has(geometry),
  );
  if (spilled && !sceneSnapshotRegistry.has(key)) disposeSpilledSceneSnapshot(key);
  if (spilled) trimSpilledSnapshots();
  return spilled;
}

let spillingSnapshots = false;

/**
 * Evicts the oldest spilled snapshot while the scratch store is over its
 * ceiling. Its file goes with it; the history entry that pointed at it becomes
 * unrecoverable, exactly like a RAM eviction.
 */
function trimSpilledSnapshots(): void {
  while (sceneSnapshotOrder.length > 1 && spilledSceneSnapshotBytes() > SCENE_HISTORY_MAX_SPILLED_BYTES) {
    const key = sceneSnapshotOrder.find((candidate) => hasSpilledSceneSnapshot(candidate));
    if (!key) return;
    const index = sceneSnapshotOrder.indexOf(key);
    if (index >= 0) sceneSnapshotOrder.splice(index, 1);
    sceneSnapshotRegistry.delete(key);
    disposeSpilledSceneSnapshot(key);
  }
}

/**
 * Keeps the in-RAM history inside its budget by moving the oldest snapshots to
 * the scratch store. Undo remains available; the geometry is re-read on demand.
 */
async function spillSnapshotsOverBudget(): Promise<void> {
  if (spillingSnapshots) return;
  spillingSnapshots = true;
  try {
    while (
      sceneSnapshotOrder.length > 1
      && estimateSceneSnapshotRegistryBytes() > SCENE_HISTORY_MAX_ESTIMATED_GEOMETRY_BYTES
    ) {
      const key = sceneSnapshotOrder.find((candidate) => (
        sceneSnapshotRegistry.has(candidate) && !hasSpilledSceneSnapshot(candidate)
      ));
      if (!key) break;
      const spilled = await spillSceneSnapshotKey(key);
      if (!spilled) break;
    }
  } finally {
    spillingSnapshots = false;
  }
  trimSpilledSnapshots();
}

/**
 * Rough bytes of a snapshot's support state.
 *
 * The pair owns a deep copy (`clonePlainData`), and a supported plate is tens of
 * thousands of entities — measured at ~14 MB for the 20-model VFX scene. Without
 * this the ~300 MB budget never sees them: 200 entries of a supported plate are
 * retained with nothing accounting for their cost. Spilling a pair clears its
 * support states too, so the budget drives them out rather than destroying undo.
 */
const SUPPORT_ENTITY_BYTES = 700;
function estimateSnapshotSupportBytes(snapshot: SceneSnapshot): number {
  const state = snapshot.supportState;
  if (!state) return 0;
  return countSupportEntities(state) * SUPPORT_ENTITY_BYTES;
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
//
// Support states are the exception: each pair owns its own copy, so they count
// once per half.
function estimateSceneSnapshotRegistryBytes(): number {
  const counted = new Set<THREE.BufferGeometry>();
  const live = new Set<THREE.BufferGeometry>();
  for (const model of liveModelsProvider?.() ?? []) {
    for (const geometry of modelGeometries(model)) live.add(geometry);
  }
  let total = 0;
  const add = (model: LoadedModel) => {
    for (const geometry of modelGeometries(model)) {
      // A mesh the scene is drawing right now is not history cost: the budget is
      // there to bound what only the undo stack holds. Counting the live plate
      // kept the estimate permanently over budget, so every commit tried to spill
      // and none of it could ever be released.
      if (counted.has(geometry) || live.has(geometry)) continue;
      counted.add(geometry);
      total += estimateGeometryBytes(geometry);
    }
  };
  for (const pair of sceneSnapshotRegistry.values()) {
    pair.before.models.forEach(add);
    pair.after.models.forEach(add);
    total += estimateSnapshotSupportBytes(pair.before) + estimateSnapshotSupportBytes(pair.after);
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
    if (removed) {
      const evicted = sceneSnapshotRegistry.get(removed);
      sceneSnapshotRegistry.delete(removed);
      disposeSpilledSceneSnapshot(removed);
      if (evicted) disposeEvictedSnapshot(evicted);
    }
  }

  // Always keep at least one snapshot so undo of the most recent action
  // still works, even if it alone exceeds the byte budget.
  while (
    sceneSnapshotOrder.length > 1
    && estimateSceneSnapshotRegistryBytes() > SCENE_HISTORY_MAX_ESTIMATED_GEOMETRY_BYTES
  ) {
    const removed = sceneSnapshotOrder.shift();
    if (removed) {
      const evicted = sceneSnapshotRegistry.get(removed);
      sceneSnapshotRegistry.delete(removed);
      disposeSpilledSceneSnapshot(removed);
      if (evicted) disposeEvictedSnapshot(evicted);
    }
  }

  void spillSnapshotsOverBudget();
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
  return typeof input === 'string' && (MESH_SHADER_TYPES as readonly string[]).includes(input)
    ? (input as MeshShaderType)
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
      configuredShaderType: clampPersistedMeshShaderType(parsed.configuredShaderType ?? parsed.shaderType, DEFAULT_SHADER_TYPE),
      matcapVariant: clampMatcapVariant(parsed.matcapVariant, DEFAULT_MATCAP_VARIANT),
      flatUseVertexColors: clampBoolean(parsed.flatUseVertexColors, DEFAULT_FLAT_USE_VERTEX_COLORS),
      ambientIntensity: clampNumber(parsed.ambientIntensity, 0, 4, DEFAULT_AMBIENT_INTENSITY),
      directionalIntensity: clampNumber(parsed.directionalIntensity, 0, 4, DEFAULT_DIRECTIONAL_INTENSITY),
      materialRoughness: clampNumber(parsed.materialRoughness, 0, 1, DEFAULT_MATERIAL_ROUGHNESS),
      bakedAoIntensity: clampNumber(parsed.bakedAoIntensity, 0, 2, DEFAULT_BAKED_OCCLUSION_INTENSITY),
      wireframeThicknessPx: clampNumber(parsed.wireframeThicknessPx, 0.5, 6, DEFAULT_WIREFRAME_THICKNESS_PX),
      xrayOpacity: clampNumber(parsed.xrayOpacity, 0.02, 0.85, DEFAULT_XRAY_OPACITY),
      heatmapMinAngle: clampNumber(parsed.heatmapMinAngle, 0, 90, DEFAULT_HEATMAP_MIN_ANGLE),
      heatmapMaxAngle: clampNumber(parsed.heatmapMaxAngle, 0, 90, DEFAULT_HEATMAP_MAX_ANGLE),
      heatmapColors: Array.isArray(parsed.heatmapColors) && parsed.heatmapColors.length === 5 ? parsed.heatmapColors : DEFAULT_HEATMAP_COLORS,
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

/** Whether a serialized scene carries any support at all. */
function voxlSupportsContainData(document: VoxlDocumentV1): boolean {
  return payloadCollections(document.supports).some((entities) => entities.length > 0);
}

/** A payload's collections as arrays, keyed by the registry's collection names. */
function payloadCollections(payload: DragonfruitImportFormat): unknown[][] {
  const record = payload as unknown as Record<string, unknown[] | undefined>;
  return SUPPORT_COLLECTION_KEYS.map((key) => record[key] ?? []);
}

function countSupportEntries(payload: DragonfruitImportFormat | null | undefined): number {
  if (!payload) return 0;
  return payloadCollections(payload).reduce((total, entities) => total + entities.length, 0);
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
  /** The plugin built a model-only mesh and supplied supports separately. */
  skipClassification?: boolean;
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

  // Every optional collection the registry declares; the required ones are
  // checked above.
  const collections = candidate as unknown as Record<string, unknown>;
  for (const key of SUPPORT_COLLECTION_KEYS) {
    const value = collections[key];
    if (value != null && !Array.isArray(value)) return null;
  }

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
    skipClassification?: unknown;
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
    skipClassification: source.skipClassification === true,
  };
}

/**
 * One build plate in the scene. `name` is '' when the user has not named it, so
 * the widget falls back to its own wording rather than showing an empty label.
 */
export type ScenePlate = {
  id: string;
  name: string;
};

/** Where a plate is in the world, and the build volume it holds there. */
export type { PlateFrame };

export interface LoadedModel {
  id: string;
  name: string;
  groupId?: string;
  groupName?: string;
  fileUrl: string;
  /**
   * The plate this model stands on. Absent means the scene's first plate, which
   * is what a scene written before plates meant by it; new models are stamped
   * with the plate they were imported onto.
   */
  plateId?: string;
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

import { deleteSupportsForModelIds, getSupportsForModel, type ModelSupportIds } from '@/supports/PlacementLogic/SupportModelLinker';
import { contactEndpointsFor, MODEL_ID_COLLECTION_KEYS, SUPPORT_COLLECTION_KEYS, SUPPORT_TYPES } from '@/supports/supportTypeRegistry';
import { beginSupportStateBatch, endSupportStateBatch } from '@/supports/state';
import {
  captureModelSupportsToClipboard,
  estimateRaftBoundsForModel,
  estimateSupportBoundsForModel,
  pasteModelSupports,
  pasteModelSupportsFromClipboard,
  type SupportClipboardPayload,
} from '@/supports/PlacementLogic/supportClipboard';
import { clearSupportSelection } from '@/supports/interaction/shared/selection/selectionController';
import { getRaftSettings, updateRaftSettings, applyImportDefaultRaftSettings, resetRaftSessionModificationFlag } from '@/supports/Rafts/Crenelated/RaftState';
import { computeFootprint } from '@/supports/Rafts/Crenelated/geometry/computeFootprint';
import { computeRaftOuterBoundary } from '@/supports/Rafts/Crenelated/geometry/computeRaftOuterBoundary';
import type { SupportBaseCircle } from '@/supports/Rafts/Crenelated/RaftTypes';
import { getImportDefaultsRaftPatch, getSavedImportDefaultsSettings } from '@/features/scene/importDefaultsPreferences';
import { readNativeFileSize } from '@/utils/pluginNetworkBridge';
import { perfMark, perfMeasure } from '@/utils/perfProbe';
import { clonePlainData } from '@/utils/plainDataClone';
import { DEFAULT_LIFT_DISTANCE_MM } from '@/features/transform/liftDefaults';

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

/** A repair run's progress sink, told also when each model of the run starts. */
export interface ModelsRepairProgressSink extends MeshRepairProgressSink {
  onModelStart?: (modelId: string, index: number, total: number) => void;
}

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

export type SceneImportHollowingChoice = 'bake' | 'keep_solid';

export type SceneImportHollowingPrompt = {
  source: string;
  fileName: string;
  modelCount: number;
  hollowedModelCount: number;
};

/**
 * Joins a pre-baked cavity to its outer shell as one hollow solid.
 *
 * A slicer that hollows before export (Lychee) ships the outer surface and the
 * cavity as two meshes, so the model alone slices filled. The cavity is stored
 * wound inward, which is what a shell's inner surface needs, making this a
 * concatenation rather than a repair.
 *
 * Positions only: geometry prep recomputes normals, and every other attribute
 * would have to be invented for the cavity's vertices.
 */
function mergeCavityIntoShell(
  shell: THREE.BufferGeometry,
  cavityPositions: Float32Array,
): THREE.BufferGeometry {
  const shellPositions = geometryPositionsAsSoup(shell);
  if (!shellPositions) return shell;

  const merged = new Float32Array(shellPositions.length + cavityPositions.length);
  merged.set(shellPositions, 0);
  merged.set(cavityPositions, shellPositions.length);

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(merged, 3));
  return out;
}

/**
 * A payload's pre-baked cavity positions, or `null` when it carries none.
 *
 * The cavity rides in the hollowing modifier as base64 rather than as geometry,
 * so this is also the test for "was this model hollowed before export".
 */
function readPayloadCavity(payload: PluginSceneImportPayload): Float32Array | null {
  const hollowing = (payload.meshModifiers as ModelMeshModifiers | undefined)?.hollowing;
  if (!hollowing?.enabled) return null;
  if (!hollowing.cavityPositionsBase64 || !hollowing.cavityPositionCount) return null;

  try {
    const bytes = base64ToBytes(hollowing.cavityPositionsBase64);
    if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return null;
    const view = new Float32Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );
    if (view.length !== hollowing.cavityPositionCount * 3) return null;
    // Copy: the decoded buffer is not guaranteed to outlive this call.
    const positions = new Float32Array(view.length);
    positions.set(view);
    return positions;
  } catch {
    return null;
  }
}

/** Positions as a flat triangle soup, resolving an index when one is present. */
function geometryPositionsAsSoup(geometry: THREE.BufferGeometry): Float32Array | null {
  const attr = geometry.getAttribute('position');
  if (!attr) return null;
  const src = attr.array as ArrayLike<number>;
  const index = geometry.getIndex();
  if (!index) return src instanceof Float32Array ? src : Float32Array.from(src);

  const idx = index.array as ArrayLike<number>;
  const soup = new Float32Array(idx.length * 3);
  for (let i = 0; i < idx.length; i += 1) {
    const s = idx[i] * 3;
    const d = i * 3;
    soup[d] = src[s];
    soup[d + 1] = src[s + 1];
    soup[d + 2] = src[s + 2];
  }
  return soup;
}

export type MeshRepairConfirmPrompt = {
  fileName: string;
  analysis: MeshAnalysisJson;
  /**
   * Whether the file can be repaired part by part. A plate imports as one model with many
   * components, and repairing it whole returns one verdict for all of them; the parts flow returns
   * a verdict per object instead. Offered only when the import has a file behind it, since the
   * parts flow reads the source.
   */
  canRepairParts: boolean;
};

/** A scene refused because it was saved by a VOXL generation we no longer read. */
export type ObsoleteVoxlScenePrompt = {
  fileName: string;
  detected: 'v1-json' | 'v1-binary';
};

/**
 * A scene written for a printer other than the one selected. Raised on import so
 * the user can switch before the scene is dropped into a machine its beds were
 * not laid out for: the plate pitch comes from the build volume, so a scene
 * packed for another printer lands on the wrong ones, and if that printer is the
 * bigger the plates do not fit here at all.
 */
export type PrinterMismatchPrompt = {
  /** The printer the scene carries, whole, so switching can add it when it is missing here. */
  bundle: VoxlPrinterBundle;
  /** The printer's name as the bundle carries it; absent when it has none. */
  recordedName?: string;
  recordedBuildVolumeMm: { width: number; depth: number; height: number };
  /** The selected profile at the moment of the import. */
  currentName: string;
  currentBuildVolumeMm: { width: number; depth: number; height: number };
  /**
   * The installed profile the scene's printer resolves to, or null when this
   * machine has none and switching will add it from the bundle.
   */
  installedProfileId: string | null;
  /** Whether the selected printer is smaller on some axis, so nothing fits as packed. */
  currentIsSmaller: boolean;
};

type MeshRepairConfirmChoice = 'repair' | 'repair_parts' | 'load_as_is' | 'cancel_import';

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

export function useSceneCollectionManager(options?: {
  /**
   * Called when the plate's lock refuses a gesture, so the caller can say so. The
   * plate that refused arrives with it: a refusal can be about a plate that is not
   * the active one (a row for another bed, a drag landing on a locked bed), and
   * saying "the plate" about the wrong bed is worse than saying nothing.
   */
  onBlockedByLock?: (plateId?: string) => void;
}) {
  const { _ } = useLingui();
  const fmt = useLocaleFormat();

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
  useEffect(() => {
    installLiveModelsProvider(() => modelsRef.current);
    return () => installLiveModelsProvider(null);
  }, []);
  useEffect(() => {
    void pruneSpilledSceneSnapshots(new Set(sceneSnapshotRegistry.keys()));
  }, []);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  /**
   * The scene's build plates, in cascade order. Deliberately not part of the
   * model-grouping snapshot machinery: a plate is a document fact, not a model
   * state, and undoing a rename is not something the history is for.
   */
  const [plates, setPlates] = useState<ScenePlate[]>(() => [{ id: uuidv4(), name: '' }]);
  /** Which plate is being worked on. */
  const [activePlateId, setActivePlateId] = useState<string>(() => plates[0].id);
  /**
   * Bumped when the plate being worked on is switched deliberately — by clicking a bed or
   * picking one in the Models panel. The view comes along: a plate you picked may be half
   * off screen. A drag that lands a model on another bed sets the active plate without
   * this, because the camera must not jump out from under the drag.
   */
  const [plateViewRunId, setPlateViewRunId] = useState(0);
  const activePlateIdRef = useRef(activePlateId);
  activePlateIdRef.current = activePlateId;

  const activePlate = plates.find((plate) => plate.id === activePlateId) ?? plates[0];
  /**
   * The active plate's name, which is what the plate widget edits and what a
   * save records as the single-plate shorthand.
   */
  const plateName = activePlate?.name ?? '';
  const setPlateName = useCallback((name: string) => {
    const target = activePlateIdRef.current;
    setPlates((prev) => prev.map((plate) => (plate.id === target ? { ...plate, name } : plate)));
  }, []);
  /**
   * Which plates refuse edits. A lock, not a document field: it is about the
   * session you are working in, so it is not written to the file and it does not
   * travel with the scene. Per plate, because locking one bed says nothing about
   * the next. A ref mirrors it for the guards below, which are stable callbacks
   * and must read the current value rather than the one they closed over.
   */
  const [lockedPlateIds, setLockedPlateIds] = useState<string[]>([]);
  const lockedPlateIdsRef = useRef<string[]>([]);
  lockedPlateIdsRef.current = lockedPlateIds;
  const plateLocked = lockedPlateIds.includes(activePlateId);
  const setPlateLocked = useCallback((locked: boolean) => {
    const target = activePlateIdRef.current;
    setLockedPlateIds((prev) => {
      if (locked) return prev.includes(target) ? prev : [...prev, target];
      return prev.filter((id) => id !== target);
    });
  }, []);

  const platesRef = useRef<ScenePlate[]>(plates);
  platesRef.current = plates;
  /**
   * The plate frames, in a ref because the guards and transform writers are
   * declared above them and must read the live ones rather than a stale closure.
   * The rules that read them are plateLayout's; until the frames are computed, a
   * model keeps whatever membership it already had.
   */
  const plateFramesRef = useRef<readonly PlateFrame[]>([]);
  /**
   * The plate a model stands on. A model with no membership is on the scene's
   * first plate, which is what a scene written before plates meant by it.
   */
  const modelPlateId = useCallback(
    (model: LoadedModel) => plateIdForModel(model, plateFramesRef.current),
    [],
  );
  /** Whether the plate a model stands on refuses edits. */
  const isModelPlateLocked = useCallback((model: LoadedModel) => {
    const locked = lockedPlateIdsRef.current;
    if (locked.length === 0) return false;
    return locked.includes(modelPlateId(model));
  }, [modelPlateId]);
  /** Whether the plate new work would land on refuses edits. */
  const isActivePlateLocked = useCallback(
    () => lockedPlateIdsRef.current.includes(activePlateIdRef.current),
    [],
  );
  /** Whether one named plate refuses edits. */
  const isPlateLocked = useCallback(
    (plateId: string) => lockedPlateIdsRef.current.includes(plateId),
    [],
  );
  // Told, not shown: the manager has no UI, so a refused gesture reports through this
  // callback and the page decides what that looks like.
  const onBlockedByLockRef = useRef<((plateId?: string) => void) | undefined>(undefined);

  /**
   * The plate whose lock refused a gesture about `model`: the bed it would land on
   * when that one is locked, the one it stands on otherwise. Only called once a
   * guard has already refused, so it always names a bed that really is locked.
   */
  const lockedPlateIdFor = useCallback((model: LoadedModel, landedTransform?: LoadedModel['transform']) => {
    if (landedTransform) {
      const landedPlateId = modelPlateId({ ...model, transform: landedTransform });
      if (isPlateLocked(landedPlateId)) return landedPlateId;
    }
    return modelPlateId(model);
  }, [isPlateLocked, modelPlateId]);
  // An empty plate has no name: deleting the last model, or starting a new scene,
  // clears it, and the widget falls back to its default wording. Scoped to a
  // single-plate scene, so a plate you add and name is not emptied out from under
  // you by the first plate happening to be bare.
  useEffect(() => {
    if (models.length > 0) return;
    if (plates.length > 1) return;
    setPlates((prev) => (prev[0]?.name ? [{ ...prev[0], name: '' }] : prev));
  }, [models.length, plates.length]);

  const modelsRef = useRef<LoadedModel[]>([]);
  const activeModelIdRef = useRef<string | null>(null);
  const selectedModelIdsRef = useRef<string[]>([]);
  // Whether the most recently loaded .voxl was the chunked 3.1 layout. Read by
  // the import/export manager right after a load to seed the scene's save-format
  // so autosave preserves an old file's format without ever downgrading a 3.1
  // one. Defaults to true (newest) for non-voxl / fresh scenes.
  const lastLoadedVoxlFormatChunkedRef = useRef<boolean>(true);
  modelsRef.current = models;
  onBlockedByLockRef.current = options?.onBlockedByLock;
  activeModelIdRef.current = activeModelId;
  selectedModelIdsRef.current = selectedModelIds;

  // Keep the COW chunk store in step with the scene (Ph0.1 sub-phase C).
  // Coalesced and idle-scheduled, so a burst of imports or an Auto-Arrange
  // sweeps once. See `scheduleChunkStoreSweep` for why this is a sweep rather
  // than a hook on every model-producing path.
  //
  // The sweep must also run when the scene EMPTIES: the store is keyed by model
  // id, and skipping the empty case retained every deleted model's compressed
  // mesh (~150-200 MB on a loaded scene) for the rest of the session. The first
  // mount is skipped so an empty app does not pay the export module's load.
  const hasHadModelsRef = useRef(false);
  useEffect(() => {
    if (models.length > 0) hasHadModelsRef.current = true;
    else if (!hasHadModelsRef.current) return;
    scheduleChunkStoreSweep(() => modelsRef.current);
  }, [models]);
  const [modelClipboard, setModelClipboard] = useState<ModelClipboardEntry[]>([]);

  useEffect(() => {
    installExtraRetainedGeometries(() => {
      const geometries: THREE.BufferGeometry[] = [];
      for (const entry of modelClipboard) modelGeometries(entry).forEach((geometry) => geometries.push(geometry));
      return geometries;
    });
    return () => installExtraRetainedGeometries(null);
  }, [modelClipboard]);
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
  const [obsoleteVoxlScene, setObsoleteVoxlScene] = useState<ObsoleteVoxlScenePrompt | null>(null);
  const [printerMismatch, setPrinterMismatch] = useState<PrinterMismatchPrompt | null>(null);
  const [sceneImportHollowingPrompt, setSceneImportHollowingPrompt] = useState<SceneImportHollowingPrompt | null>(null);
  const [meshRepairConfirmPrompt, setMeshRepairConfirmPrompt] = useState<MeshRepairConfirmPrompt | null>(null);
  const [meshRepairReports, setMeshRepairReports] = useState<MeshRepairReportEntry[]>([]);
  // Which models the user repaired here, as opposed to the import pass repairing them at load.
  // Every imported model carries a `nativeRepairReport`, so that field alone cannot say whether the
  // repair menu should offer "Auto-Repair Again" and the report.
  const [manuallyRepairedModelIds, setManuallyRepairedModelIds] = useState<string[]>([]);
  const [meshRepairReportPresentation, setMeshRepairReportPresentation] = useState<MeshRepairReportPresentation>('default');
  const [pendingMeshRepairReports, setPendingMeshRepairReports] = useState<MeshRepairReportEntry[]>([]);
  const sceneImportReportTimeoutRef = useRef<number | null>(null);
  const sceneImportPlacementResolveRef = useRef<((choice: SceneImportPlacementChoice) => void) | null>(null);
  const sceneImportHollowingResolveRef = useRef<((choice: SceneImportHollowingChoice) => void) | null>(null);
  const meshRepairConfirmResolveRef = useRef<((choice: MeshRepairConfirmChoice) => void) | null>(null);

  const deferredAccelerationQueueRef = useRef<THREE.BufferGeometry[]>([]);
  const deferredAccelerationProcessingRef = useRef(false);
  // Reasons, not a boolean: the camera and a pointer gesture can each pause this
  // queue, and the first one to resume must not restart it under the other.
  const deferredAccelerationPauseReasonsRef = useRef<Set<string>>(new Set());
  const deferredDisposalQueueRef = useRef<THREE.BufferGeometry[]>([]);
  const deferredDisposalProcessingRef = useRef(false);
  // Count of scheduled-but-unfinished flattening-plane computations (idle
  // callbacks after geometry swaps). Part of hasPendingBackgroundGeometryWork.
  const pendingFlatteningPlanesRef = useRef(0);
  // Models whose AO volume bake is queued or awaiting the native round trip.
  // Part of hasPendingBackgroundGeometryWork.
  const pendingAoBakeRef = useRef(0);
  /** The AO sweep's remaining work, replaced wholesale on every run. */
  const pendingAoQueueRef = useRef<string[]>([]);
  // Geometries with a bake in flight. The attribute lands only when the bake
  // resolves, so without this the queue rebuilt on a later `models` change would
  // send the same soup a second time — measured as 25 bakes of one mesh in three
  // seconds under a models-change storm, and as the one-second pair on a restored
  // model. Keyed on the geometry, so a repair that swaps in a new one is not
  // skipped.
  const pendingAoGeometriesRef = useRef<Set<THREE.BufferGeometry>>(new Set());
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

  const dismissObsoleteVoxlScene = useCallback(() => {
    setObsoleteVoxlScene(null);
  }, []);

  /**
   * Answer the printer-mismatch prompt. Switching selects the scene's printer
   * when this machine already has it, and otherwise adds it from the bundle the
   * scene carries, which is the point of shipping it whole.
   */
  const resolvePrinterMismatch = useCallback((choice: 'switch' | 'keep') => {
    if (choice === 'switch' && printerMismatch) {
      const installedId = printerMismatch.installedProfileId;
      if (installedId) setActivePrinterProfile(installedId);
      else setActivePrinterProfile(importPrinterBundle(printerMismatch.bundle));
    }
    setPrinterMismatch(null);
  }, [printerMismatch]);

  /**
   * Show the report a model already carries, from its recorded repair.
   *
   * The record lives on the model (`meshDefects.nativeRepairReport`) and survives everything the
   * scene does to it, so a model repaired earlier in the session can still say what was done.
   */
  const openMeshRepairReportForModel = useCallback((modelId: string) => {
    const model = models.find((entry) => entry.id === modelId);
    const report = model?.geometry.meshDefects?.nativeRepairReport;
    if (!model || !report) return;
    // The same dialog a repair just showed: the wins, the follow-up notes and the technical details.
    setMeshRepairReportPresentation('optimistic');
    setMeshRepairReports([{ id: `model-${modelId}`, modelName: model.name, report }]);
  }, [models]);

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

  const resolveSceneImportHollowingPrompt = useCallback((choice: SceneImportHollowingChoice) => {
    const resolve = sceneImportHollowingResolveRef.current;
    sceneImportHollowingResolveRef.current = null;
    setSceneImportHollowingPrompt(null);
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

  const requestSceneImportHollowingChoice = useCallback(async (
    prompt: SceneImportHollowingPrompt,
  ): Promise<SceneImportHollowingChoice> => {
    // Headless: take the file at its word and keep the authored hollow.
    if (typeof window === 'undefined') {
      return 'bake';
    }

    if (sceneImportHollowingResolveRef.current) {
      // Fail-safe: resolve previous unresolved prompt so imports never deadlock.
      sceneImportHollowingResolveRef.current('bake');
      sceneImportHollowingResolveRef.current = null;
    }

    setSceneImportHollowingPrompt(prompt);

    return await new Promise<SceneImportHollowingChoice>((resolve) => {
      sceneImportHollowingResolveRef.current = resolve;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sceneImportPlacementResolveRef.current) {
        const resolve = sceneImportPlacementResolveRef.current;
        sceneImportPlacementResolveRef.current = null;
        resolve('load_as_is');
      }
      if (sceneImportHollowingResolveRef.current) {
        const resolve = sceneImportHollowingResolveRef.current;
        sceneImportHollowingResolveRef.current = null;
        resolve('bake');
      }
    };
  }, []);

  // Lighting controls (Global)
  const [ambientIntensity, setAmbientIntensity] = useState<number>(DEFAULT_AMBIENT_INTENSITY);
  const [directionalIntensity, setDirectionalIntensity] = useState<number>(DEFAULT_DIRECTIONAL_INTENSITY);
  const [materialRoughness, setMaterialRoughness] = useState<number>(DEFAULT_MATERIAL_ROUGHNESS);
  const [bakedAoIntensity, setBakedAoIntensity] = useState<number>(DEFAULT_BAKED_OCCLUSION_INTENSITY);

  // Geometry prep runs outside React and bakes before a model reaches the scene,
  // so it reads the intensity from the module rather than from this state.
  useEffect(() => {
    setBakedOcclusionIntensity(bakedAoIntensity);
  }, [bakedAoIntensity]);

  // Shader-specific settings (Global)
  const [shaderType, setShaderType] = useState<MeshShaderType>(DEFAULT_SHADER_TYPE);
  // What the Mesh settings tab edits. Deliberately separate from shaderType:
  // the camera dropdown owns what the viewport renders, the settings tab owns
  // which type's options it is showing.
  const [configuredShaderType, setConfiguredShaderType] = useState<MeshShaderType>(DEFAULT_SHADER_TYPE);
  const [matcapVariant, setMatcapVariant] = useState<MatcapVariant>(DEFAULT_MATCAP_VARIANT);
  const [flatUseVertexColors, setFlatUseVertexColors] = useState<boolean>(DEFAULT_FLAT_USE_VERTEX_COLORS);
  const [wireframeThicknessPx, setWireframeThicknessPx] = useState<number>(DEFAULT_WIREFRAME_THICKNESS_PX);
  const [xrayOpacity, setXrayOpacity] = useState<number>(DEFAULT_XRAY_OPACITY);
  const [heatmapMinAngle, setHeatmapMinAngle] = useState<number>(DEFAULT_HEATMAP_MIN_ANGLE);
  const [heatmapMaxAngle, setHeatmapMaxAngle] = useState<number>(DEFAULT_HEATMAP_MAX_ANGLE);
  const [heatmapColors, setHeatmapColors] = useState<string[]>(DEFAULT_HEATMAP_COLORS);
  const [preferredMeshColor, setPreferredMeshColor] = useState<string>(DEFAULT_MESH_COLOR);
  const [hoverTintStrength, setHoverTintStrength] = useState<number>(DEFAULT_HOVER_TINT_STRENGTH);
  const [selectedTintStrength, setSelectedTintStrength] = useState<number>(DEFAULT_SELECTED_TINT_STRENGTH);
  const [storedView3dSettings, setView3dSettingsState] = useState<View3DSettings>(() => DEFAULT_VIEW3D_SETTINGS);
  const profileState = useSyncExternalStore(subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreServerSnapshot);
  const activePrinterProfile = useMemo(() => getActivePrinterProfile(profileState), [profileState]);
  /**
   * Read at drop time rather than only at render: the follow decision is made inside
   * callbacks with empty dependency lists, so a ref carries the live value.
   */
  const multiPlateSettings = useSyncExternalStore(
    subscribeToMultiPlateSettings,
    getMultiPlateSettingsSnapshot,
    getMultiPlateSettingsServerSnapshot,
  );
  const followLandedPlateRef = useRef(multiPlateSettings.followLandedPlate);
  followLandedPlateRef.current = multiPlateSettings.followLandedPlate;
  /** The grid the beds are laid out on, in the shape the cascade reads. */
  const plateOrdering = useMemo<PlateOrdering>(() => plateOrderingFor(multiPlateSettings), [multiPlateSettings]);
  /** Read inside callbacks that must not be rebuilt when the layout changes. */
  const plateOrderingRef = useRef(plateOrdering);
  plateOrderingRef.current = plateOrdering;
  /** The ordering the models' positions were last laid out under. */
  const appliedPlateOrderingRef = useRef(plateOrdering);

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

  // What a save embeds as the printer this scene was built for: the profile
  // whole, plus the materials that belong to it. Memoized on the store snapshot
  // so an unchanged selection does not re-render the autosave options.
  const voxlPrinterBundle = useMemo(
    () => (activePrinterProfile
      ? toVoxlPrinterBundle(
          activePrinterProfile,
          getMaterialProfilesForPrinter(activePrinterProfile.id, profileState),
        )
      : null),
    [activePrinterProfile, profileState],
  );

  useEffect(() => {
    const persistedAppearance = readMeshAppearanceFromLocalStorage();
    if (persistedAppearance) {
      setShaderType(persistedAppearance.shaderType);
      setConfiguredShaderType(persistedAppearance.configuredShaderType);
      setMatcapVariant(persistedAppearance.matcapVariant);
      setFlatUseVertexColors(persistedAppearance.flatUseVertexColors);
      setAmbientIntensity(persistedAppearance.ambientIntensity);
      setDirectionalIntensity(persistedAppearance.directionalIntensity);
      setMaterialRoughness(persistedAppearance.materialRoughness);
      setBakedAoIntensity(persistedAppearance.bakedAoIntensity);
      setWireframeThicknessPx(persistedAppearance.wireframeThicknessPx);
      setXrayOpacity(persistedAppearance.xrayOpacity);
      setHeatmapMinAngle(persistedAppearance.heatmapMinAngle ?? DEFAULT_HEATMAP_MIN_ANGLE);
      setHeatmapMaxAngle(persistedAppearance.heatmapMaxAngle ?? DEFAULT_HEATMAP_MAX_ANGLE);
      setHeatmapColors(persistedAppearance.heatmapColors ?? DEFAULT_HEATMAP_COLORS);
      setPreferredMeshColor(persistedAppearance.meshColor);
      setHoverTintStrength(persistedAppearance.hoverTintStrength);
      setSelectedTintStrength(persistedAppearance.selectedTintStrength);
    }

    setRecentOpenedFiles(readRecentOpenedFilesFromLocalStorage());
    setView3dSettingsState(getSavedView3DSettings());
  }, []);

  // The whole appearance record is persisted whenever any of it changes, so
  // settings survive a reload: the view mode the camera dropdown picks, the
  // type the Mesh tab is configuring, and every parameter either of them edits.
  useEffect(() => {
    writeMeshAppearanceToLocalStorage({
      v: 1,
      shaderType,
      configuredShaderType,
      matcapVariant,
      flatUseVertexColors,
      ambientIntensity,
      directionalIntensity,
      materialRoughness,
      bakedAoIntensity,
      wireframeThicknessPx,
      xrayOpacity,
      heatmapMinAngle,
      heatmapMaxAngle,
      heatmapColors,
      meshColor: preferredMeshColor,
      hoverTintStrength,
      selectedTintStrength,
    });
  }, [
    shaderType,
    configuredShaderType,
    matcapVariant,
    flatUseVertexColors,
    ambientIntensity,
    directionalIntensity,
    materialRoughness,
    bakedAoIntensity,
    wireframeThicknessPx,
    xrayOpacity,
    heatmapMinAngle,
    heatmapMaxAngle,
    heatmapColors,
    preferredMeshColor,
    hoverTintStrength,
    selectedTintStrength,
  ]);

  const setView3dSettings = useCallback((next: View3DSettings) => {
    const normalized = normalizeView3DSettings(next);
    setView3dSettingsState(normalized);
    saveView3DSettings(normalized);
  }, []);

  // Global application mode
  const [mode, setMode] = useState<SupportMode>('prepare');

  /**
   * Where new work goes: the middle of the **active** plate, in world
   * coordinates. The plate's own frame is what the app's rect maths speaks, so
   * the cascade offset is added here and in `isRectInsidePlate` rather than at
   * every caller.
   */
  const defaultImportCenterXY = useMemo(() => {
    const { centerX: localX, centerY: localY } = plateLocalRect(view3dSettings);
    const index = Math.max(0, plates.findIndex((plate) => plate.id === activePlateId));
    const { dxMm, dyMm } = plateCascadeOffsetMm(index, {
      widthMm: view3dSettings.widthMm,
      depthMm: view3dSettings.depthMm,
    }, plates.length, plateOrdering);
    return new THREE.Vector2(localX + dxMm, localY + dyMm);
  }, [
    activePlateId,
    plateOrdering,
    plates,
    view3dSettings.depthMm,
    view3dSettings.originMode,
    view3dSettings.widthMm,
  ]);

  type Rect2D = { minX: number; maxX: number; minY: number; maxY: number };

  const intersectsRect = useCallback((a: Rect2D, b: Rect2D) => {
    return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
  }, []);

  /** The active plate's build volume in world coordinates. */
  const activePlateRect = useMemo<Rect2D>(() => {
    const index = Math.max(0, plates.findIndex((plate) => plate.id === activePlateId));
    const { dxMm, dyMm } = plateCascadeOffsetMm(index, {
      widthMm: view3dSettings.widthMm,
      depthMm: view3dSettings.depthMm,
    }, plates.length, plateOrdering);
    const local = plateLocalRect(view3dSettings);
    const minX = local.minX + dxMm;
    const minY = local.minY + dyMm;
    return {
      minX,
      maxX: minX + view3dSettings.widthMm,
      minY,
      maxY: minY + view3dSettings.depthMm,
    };
  }, [activePlateId, plateOrdering, plates, view3dSettings.depthMm, view3dSettings.originMode, view3dSettings.widthMm]);

  const isRectInsidePlate = useCallback((rect: Rect2D) => {
    return (
      rect.minX >= activePlateRect.minX
      && rect.maxX <= activePlateRect.maxX
      && rect.minY >= activePlateRect.minY
      && rect.maxY <= activePlateRect.maxY
    );
  }, [activePlateRect]);

  // Projected through the whole rotation: a model tipped on X or Y does not stand
  // on the footprint its unrotated XY size describes.
  const footprintForTransform = useCallback((
    geometry: Pick<GeometryWithBounds, 'geometry' | 'center'>,
    transform: ModelTransform,
  ) => computeProjectedFootprintSize(geometry, transform.rotation, transform.scale), []);

  const buildMeshPlacementOffsets = useCallback((
    center: { x: number; y: number },
    geometry: Pick<GeometryWithBounds, 'geometry' | 'center'>,
    transform: ModelTransform,
  ) => {
    const footprint = footprintForTransform(geometry, transform);
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

  /** A model's footprint where it stands, as a world rect. Every bed test starts from it. */
  const modelFootprintRect = useCallback((
    model: Pick<LoadedModel, 'geometry' | 'transform'>,
  ): Rect2D => {
    const placement = buildMeshPlacementOffsets(
      { x: model.transform.position.x, y: model.transform.position.y },
      model.geometry,
      model.transform,
    );

    return {
      minX: model.transform.position.x + placement.minXOffset,
      maxX: model.transform.position.x + placement.maxXOffset,
      minY: model.transform.position.y + placement.minYOffset,
      maxY: model.transform.position.y + placement.maxYOffset,
    };
  }, [buildMeshPlacementOffsets]);

  const isModelFootprintInsidePlate = useCallback((
    model: Pick<LoadedModel, 'geometry' | 'transform'>,
  ) => isRectInsidePlate(modelFootprintRect(model)), [isRectInsidePlate, modelFootprintRect]);

  const findFreeSpotCentersForModels = useCallback((
    incomingModels: Array<Pick<LoadedModel, 'geometry' | 'transform'>>,
    spacingMm = 5,
  ): Array<{ x: number; y: number }> => {
    if (incomingModels.length === 0) return [];

    const centerX = defaultImportCenterXY.x;
    const centerY = defaultImportCenterXY.y;
    const activePlateOffset = plateOffsetForRef.current(activePlateIdRef.current);
    // The search runs in world coordinates over the ACTIVE plate's volume, so a
    // model imported onto the second plate lands on the second plate.
    const { minX, maxX, minY, maxY } = activePlateRect;

    const placementOffsets = incomingModels.map((model) => buildMeshPlacementOffsets(
      { x: model.transform.position.x, y: model.transform.position.y },
      model.geometry,
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
          model.geometry,
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

      // Larger than a bed, it fits on none of them, and the column beside the plates sits
      // metres out of view. Centred on the bed being worked on, it is on screen, flagged as
      // out of bounds, and one scale away from fitting.
      if (placement.width > maxX - minX || placement.depth > maxY - minY) {
        return { x: centerX, y: centerY };
      }

      for (const candidate of candidateCenters) {
        const rect = makeRectAt(candidate.x, candidate.y);
        if (!isRectInsidePlate(rect)) continue;
        if (blockedRects.some((blocked) => intersectsRect(rect, blocked))) continue;
        blockedRects.push(rect);
        return { x: candidate.x, y: candidate.y };
      }

      // Then the scene's other beds, in cascade order, each checked in its own frame. A paste has
      // always filled the beds that exist before adding one; an import used to give up after the
      // active plate and set the model down beside the plates.
      for (const plate of platesRef.current) {
        if (plate.id === activePlateIdRef.current) continue;
        const { dxMm, dyMm } = plateOffsetForRef.current(plate.id);
        const bedRect: Rect2D = {
          minX: activePlateRect.minX - activePlateOffset.dxMm + dxMm,
          maxX: activePlateRect.maxX - activePlateOffset.dxMm + dxMm,
          minY: activePlateRect.minY - activePlateOffset.dyMm + dyMm,
          maxY: activePlateRect.maxY - activePlateOffset.dyMm + dyMm,
        };
        const fitsBed = (rect: Rect2D) => (
          rect.minX >= bedRect.minX && rect.maxX <= bedRect.maxX
          && rect.minY >= bedRect.minY && rect.maxY <= bedRect.maxY
        );

        for (const candidate of candidateCenters) {
          const rect = makeRectAt(candidate.x, candidate.y);
          if (!fitsBed(rect)) continue;
          if (blockedRects.some((blocked) => intersectsRect(rect, blocked))) continue;
          blockedRects.push(rect);
          return { x: candidate.x, y: candidate.y };
        }
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
  }, [activePlateRect, buildMeshPlacementOffsets, defaultImportCenterXY.x, defaultImportCenterXY.y, estimateSupportBoundsForModel, intersectsRect, isRectInsidePlate]);

  const applySceneSnapshot = useCallback((snapshot: SceneSnapshot) => {
    if (snapshot.modifierRecord) {
      storeModelMeshModifiers(snapshot.modifierRecord.modelId, cloneMeshModifiersForHistory(snapshot.modifierRecord.modifiers));
      clearPreparedGeometryCacheForModel(snapshot.modifierRecord.modelId);
    }
    // A colour change also repaints the vertex colours, and the geometry is shared with the
    // snapshot rather than copied, so the colour being restored has to be painted back.
    const currentColorById = new Map(modelsRef.current.map((model) => [model.id, model.color]));
    snapshot.models.forEach((model) => {
      const currentColor = currentColorById.get(model.id);
      if (currentColor !== undefined && currentColor !== model.color) paintModelBaseColor(model, model.color);
    });
    setModels(snapshot.models.map(cloneLoadedModel));
    setActiveModelId(snapshot.activeModelId);
    setSelectedModelIds([...snapshot.selectedModelIds]);

    // The printer is part of the scene: the beds are spaced by its build volume, so an entry
    // taken under one printer and undone under another would put every model back against
    // frames that never applied to it. The layout memory moves with it, or restoring a
    // snapshot would look like a printer switch to the effect that shifts models with their
    // beds.
    if (snapshot.printerProfileId !== undefined) {
      const printerId = snapshot.printerProfileId;
      if (printerId && printerId !== (getActivePrinterProfile()?.id ?? null)) {
        setActivePrinterProfile(printerId);
      }
      const restoredPrinter = printerId
        ? getProfileStoreSnapshot().printerProfiles.find((profile) => profile.id === printerId)
        : undefined;
      if (restoredPrinter) {
        laidOutFootprintRef.current = {
          printerId,
          widthMm: restoredPrinter.buildVolumeMm.width,
          depthMm: restoredPrinter.buildVolumeMm.depth,
        };
      }
    }

    // A snapshot that carries beds also carries which one was being worked on,
    // falling back to the first when that plate is one of the ones that went.
    if (snapshot.plates) {
      const plates = snapshot.plates.map((plate) => ({ ...plate }));
      const active = snapshot.activePlateId;
      setPlates(plates);
      setActivePlateId((prev) => (active && plates.some((plate) => plate.id === active)
        ? active
        : (plates[0]?.id ?? prev)));
    }

    // Supports cannot outlive the models that own them. A snapshot taken while
    // the scene was empty can still carry a support state from an earlier step;
    // restoring it would leave unselectable supports on the plate.
    if (snapshot.models.length === 0) {
      resetStore();
    } else if (snapshot.supportState) {
      // setSupportSnapshot restores kickstands with everything else -- they are
      // ordinary SupportState collections, and their roots and host knots ride in
      // `roots` and `knots`.
      setSupportSnapshot(clonePlainData(snapshot.supportState));
    }
  }, []);

  useEffect(() => {
    const unregisterSceneModelsHistory = sceneHistory.register(
      SCENE_MODELS_SNAPSHOT_APPLY,
      (payload, direction) => {
        if (!payload?.key) return false;

        const pair = sceneSnapshotRegistry.get(payload.key);
        if (!pair) return false;

        const moveSupports = () => {
          if (!pair.supportMoves || pair.supportMoves.length === 0) return;
          for (const move of pair.supportMoves) {
            // Undo puts the supports back where they were; redo moves them again.
            if (direction === 'undo') transformSupportsForModel(move.modelId, move.to, move.from);
            else transformSupportsForModel(move.modelId, move.from, move.to);
          }
        };

        if (hasSpilledSceneSnapshot(payload.key)) {
          void rehydrateSceneSnapshotPair(payload.key, pair)
            .then((restored) => {
              if (!restored) {
                console.warn('[UndoSpill] Scene snapshot scratch data is missing; undo was not applied.');
                return;
              }
              moveSupports();
              applySceneSnapshot(direction === 'undo' ? pair.before : pair.after);
            })
            .catch((error) => console.warn('[UndoSpill] Failed restoring scene snapshot.', error));
          return true;
        }

        moveSupports();
        applySceneSnapshot(direction === 'undo' ? pair.before : pair.after);
        return true;
      },
    );

    return () => {
      unregisterSceneModelsHistory();
    };
  }, [applySceneSnapshot]);

  const pushSceneSnapshotHistory = useCallback((before: SceneSnapshot, after: SceneSnapshot, description?: MessageDescriptor, modelId?: string, supportMoves?: SupportTransformMove[]): string => {
    const key = storeSceneSnapshotPair({
      before,
      after,
      ...(supportMoves && supportMoves.length > 0 ? { supportMoves } : {}),
    });
    sceneHistory.push({
      type: SCENE_MODELS_SNAPSHOT_APPLY,
      description,
      payload: { key, ...(modelId ? { modelId } : {}) },
    });
    return key;
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
        // A duplicate shares the source's vertex data, so it shares the edge
        // overlay derived from it. Leaving this out made every duplicated model
        // look like it had never been edged: the idle edge pass rebuilt the
        // overlay for each copy, which is O(triangles) and blocked the main
        // thread for most of a second on an 8-model duplicate.
        ...(source.edgeGeometry ? { edgeGeometry: source.edgeGeometry } : {}),
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
    if (deferredAccelerationPauseReasonsRef.current.size > 0) return;
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
      if (deferredAccelerationPauseReasonsRef.current.size > 0) {
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

  const setBackgroundGeometryWorkPaused = useCallback((paused: boolean, reason = 'camera') => {
    const reasons = deferredAccelerationPauseReasonsRef.current;
    if (paused) reasons.add(reason);
    else reasons.delete(reason);
    if (reasons.size === 0) {
      processDeferredAccelerationQueue();
    }
  }, [processDeferredAccelerationQueue]);

  /**
   * True while deferred post-swap geometry work (BVH acceleration builds,
   * deferred geometry disposals, flattening-plane computation, AO bakes) is
   * queued or
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
    || pendingAoBakeRef.current > 0
    || pendingAoQueueRef.current.length > 0
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
    // The lock's whole point: nothing on a locked plate can be selected. Guarded at
    // the gesture rather than at the setter, because the internal writers (import,
    // duplicate, split) call the setter directly and must keep working.
    const lockedTarget = modelsRef.current.find((model) => model.id === id);
    if (lockedTarget && isModelPlateLocked(lockedTarget)) {
      onBlockedByLockRef.current?.(lockedPlateIdFor(lockedTarget));
      return;
    }
    setActiveModelId(id);

    setSelectedModelIds((prev) => {
      if (mode === 'single') return [id];
      if (mode === 'add') {
        return prev.includes(id) ? prev : [...prev, id];
      }
      return prev.includes(id) ? prev.filter((sid) => sid !== id) : [...prev, id];
    });
  }, []);

  // Locking a plate drops any selection with it: the models are no longer
  // selectable, so a selection left standing would have the panels acting on models
  // the plate refuses to touch.
  useEffect(() => {
    if (!plateLocked) return;
    setSelectedModelIds((prev) => (prev.length > 0 ? [] : prev));
  }, [plateLocked]);

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
    // One door for every way a mesh arrives — picker, drop, the panel's plus — so the
    // lock is enforced here rather than at each of them. New meshes land on the
    // active plate, so that is the plate whose lock matters.
    if (isActivePlateLocked()) {
      onBlockedByLockRef.current?.(activePlateIdRef.current);
      return;
    }
    const files = Array.from(filesInput).filter((file) => getMeshExtension(file.name) !== null);

    if (files.length === 0) {
      return;
    }

    setImportProgress({
      active: true,
      type: 'mesh',
      label: importLabelLoadingMesh(files.length, _),
      detail: files.length > 1 ? importDetailPreparing(0, files.length, _) : importDetailPreparingGeometry(_),
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
    let liftDistance = DEFAULT_LIFT_DISTANCE_MM;
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

    /**
     * Puts a model on a bed of its own when the search could not seat it on one.
     *
     * The search fills the beds the scene has, and its last resort is a column beside the plates,
     * which is where an over-sized model used to end up. A paste adds a bed for an overflow copy
     * instead, and an import does the same here. A model larger than a bed has nowhere to go
     * either way and keeps the search's fallback.
     */
    const seatModelOnNewBedIfNeeded = (
      model: LoadedModel,
      assignedCenter: { x: number; y: number } | undefined,
    ): void => {
      if (!assignedCenter) return;

      const { minX: localMinX, minY: localMinY } = plateLocalRect(view3dSettings);
      const insideAnyBed = platesRef.current.some((plate) => {
        const { dxMm, dyMm } = plateOffsetForRef.current(plate.id);
        const minX = localMinX + dxMm;
        const minY = localMinY + dyMm;
        return assignedCenter.x >= minX && assignedCenter.x <= minX + view3dSettings.widthMm
          && assignedCenter.y >= minY && assignedCenter.y <= minY + view3dSettings.depthMm;
      });
      if (insideAnyBed) return;

      const placement = buildMeshPlacementOffsets(
        { x: model.transform.position.x, y: model.transform.position.y },
        model.geometry,
        model.transform,
      );
      if (placement.width > view3dSettings.widthMm || placement.depth > view3dSettings.depthMm) return;

      const reserved = addPlatesRef.current(1);
      const plate = reserved.added[0];
      if (!plate) return;

      const { dxMm, dyMm } = reserved.offsets.get(plate.id) ?? { dxMm: 0, dyMm: 0 };
      const { centerX: localCenterX, centerY: localCenterY } = plateLocalRect(view3dSettings);
      model.transform.position.set(localCenterX + dxMm, localCenterY + dyMm, model.transform.position.z);
      model.plateId = plate.id;
    };
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
          label: importLabelLoadingMesh(files.length, _),
          detail: files.length > 1
            ? importDetailIndexedFile(i + 1, files.length, file.name, _)
            : importDetailLoadingFile(file.name, _),
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
                  label: importLabelAutoRepairing(files.length, _),
                  detail: files.length > 1
                    ? importDetailIndexedFile(i + 1, files.length, file.name, _)
                    : importDetailAutoRepairingFile(file.name, _),
                  progress: null,
                });
                return;
              }

              if (stage === 'analyzing') {
                setImportProgress({
                  active: true,
                  type: 'mesh',
                  label: importLabelInspecting(files.length, _),
                  detail: files.length > 1
                    ? importDetailIndexedFile(i + 1, files.length, file.name, _)
                    : importDetailInspectingFile(file.name, _),
                  progress: null,
                });
                return;
              }

              if (stage === 'classifying') {
                setImportProgress({
                  active: true,
                  type: 'mesh',
                  label: importLabelClassifying(files.length, _),
                  detail: files.length > 1
                    ? importDetailIndexedFile(i + 1, files.length, file.name, _)
                    : importDetailClassifyingFile(file.name, _),
                  progress: null,
                });
              }
            },
            onConfirmHeavyRepair: async (analysis: MeshAnalysisJson) => {
              const choice = await requestMeshRepairConfirmation({
                fileName: file.name,
                analysis,
                canRepairParts: Boolean((file as File & { filePath?: string }).filePath),
              });
              if (choice === 'cancel_import') {
                throw new Error('MESH_IMPORT_CANCELLED_BY_USER');
              }
              if (choice === 'repair_parts') {
                setImportProgress({
                  active: true,
                  type: 'mesh',
                  label: importLabelAutoRepairing(files.length, _),
                  detail: files.length > 1
                    ? importDetailIndexedFile(i + 1, files.length, file.name, _)
                    : importDetailAutoRepairingFile(file.name, _),
                  progress: null,
                });
                return 'repair_parts';
              }
              if (choice === 'repair') {
                setImportProgress({
                  active: true,
                  type: 'mesh',
                  label: importLabelAutoRepairing(files.length, _),
                  detail: files.length > 1
                    ? importDetailIndexedFile(i + 1, files.length, file.name, _)
                    : importDetailAutoRepairingFile(file.name, _),
                  progress: null,
                });
              }
              return choice === 'load_as_is' ? 'skip' : choice;
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
              // Imported meshes land on the plate being worked on, which is also
              // the plate the placement search above was run against.
              plateId: activePlateIdRef.current,
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
                ?? countTriangles(merged.geometry),
            };

            const assignedCenter = findFreeSpotCentersForModels([...stagedNewModels, model], 5).at(-1);
            if (assignedCenter) {
              model.transform.position.set(assignedCenter.x, assignedCenter.y, model.transform.position.z);
            }
            seatModelOnNewBedIfNeeded(model, assignedCenter);

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
              plateId: activePlateIdRef.current,
              geometry: geom,
              transform: {
                position: new THREE.Vector3(defaultImportCenterXY.x, defaultImportCenterXY.y, initialZ),
                rotation: new THREE.Euler(0, 0, 0),
                scale: new THREE.Vector3(1, 1, 1),
              },
              visible: true,
              color,
              polygonCount: geom.nativePreview?.originalTriangleCount
                ?? countTriangles(geom.geometry),
            };

            const assignedCenter = findFreeSpotCentersForModels([...stagedNewModels, model], 5).at(-1);
            if (assignedCenter) {
              model.transform.position.set(assignedCenter.x, assignedCenter.y, model.transform.position.z);
            }
            seatModelOnNewBedIfNeeded(model, assignedCenter);

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
          label: importLabelLoadingMesh(files.length, _),
          detail: files.length > 1
            ? importDetailProcessedCount(Math.min(i + 1, files.length), files.length, _)
            : importDetailFinalizingModel(_),
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
              reportAutoRepaired(_),
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
  }, [_, defaultImportCenterXY.x, defaultImportCenterXY.y, emitSceneImportReport, findFreeSpotCentersForModels, getMeshExtension, requestMeshRepairConfirmation, trackRecentOpenedFiles, waitForUiYield]);

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
    // Resolved before the state update rather than inside it: a setter is not a
    // place for a side effect, and the active plate is a second piece of state.
    const current = modelsRef.current.find((m) => m.id === id);
    if (current) {
      const plateId = plateIdForModel({ ...current, transform }, plateFramesRef.current);
      if (plateId && plateId !== current.plateId && followLandedPlateRef.current) {
        setActivePlateId((active) => (active === plateId ? active : plateId));
      }
    }

    setModels((prev) => prev.map((m) => {
      if (m.id !== id) return m;
      // Membership follows the model: it stands on whichever plate it now does.
      return withPlateMembership({ ...m, transform }, plateFramesRef.current);
    }));
  }, []);

  const updateModelTransform = useCallback((
    id: string,
    transform: ModelTransform,
    previousTransformOverride?: ModelTransform,
    options?: {
      /**
       * The plate this move lands on, when the caller made it in the same step. The
       * plate list this render still holds does not include a bed created moments
       * ago, so resolving the position against it would put the model on the old
       * plate and leave the new one empty.
       */
      landedPlateId?: string;
    },
  ) => {
    // Every move lands here — drag, gizmo, the transform panel, the nudge hotkeys —
    // so a locked plate refuses them all at the one place that writes a transform.
    //
    // Both beds are checked: the one the model leaves, and the one it would land on. A model
    // dragged from an unlocked bed onto a locked one is refused there, and refusing the write
    // leaves it where it started.
    const currentModel = modelsRef.current.find((m) => m.id === id);
    if (currentModel && (
      isModelPlateLocked(currentModel)
      || isModelPlateLocked({ ...currentModel, transform })
    )) {
      onBlockedByLockRef.current?.(lockedPlateIdFor(currentModel, transform));
      return {
        updated: false,
        supportsChanged: false,
        kickstandsChanged: false,
        supportLocalFramePreserved: false,
      };
    }
    if (!currentModel) {
      return {
        updated: false,
        supportsChanged: false,
        kickstandsChanged: false,
        supportLocalFramePreserved: false,
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
        supportLocalFramePreserved: false,
      };
    }

    const deltaRotationEqual = Math.abs(beforeTransform.rotation.x - transform.rotation.x) <= 1e-8
      && Math.abs(beforeTransform.rotation.y - transform.rotation.y) <= 1e-8
      && Math.abs(beforeTransform.rotation.z - transform.rotation.z) <= 1e-8
      && beforeTransform.rotation.order === transform.rotation.order;
    const deltaScaleEqual = Math.abs(beforeTransform.scale.x - transform.scale.x) <= 1e-8
      && Math.abs(beforeTransform.scale.y - transform.scale.y) <= 1e-8
      && Math.abs(beforeTransform.scale.z - transform.scale.z) <= 1e-8;
    /**
     * A pure XY translation moves the world support data and the model frame by
     * the same delta, so the supports' model-local coordinates are unchanged.
     * Z is not rigid (roots stay on the plate) and rotation/scale move the
     * contacts relative to the frame, so both must re-merge.
     */
    const supportLocalFramePreserved = deltaRotationEqual
      && deltaScaleEqual
      && Math.abs(beforeTransform.position.z - transform.position.z) <= 1e-8;

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

    // Which plate the moved models land on, resolved before the state update: a
    // setter is not a place for a side effect, and the active plate is state too.
    const landedPlateIds = new Set<string>();
    for (const model of modelsRef.current) {
      const nextTransform = updateMap.get(model.id);
      if (!nextTransform) continue;
      const plateId = plateIdForModel({ ...model, transform: nextTransform }, plateFramesRef.current);
      if (plateId) landedPlateIds.add(plateId);
    }
    // A drag that lands on another bed makes that bed the one you are working on,
    // which the Multi-Plate setting can turn off.
    const followedPlateId = followedPlateIdForMove({
      followLandedPlate: followLandedPlateRef.current,
      explicitPlateId: options?.landedPlateId,
      landedPlateIds,
    });

    setModels(prev => prev.map(m => {
      const nextTransform = updateMap.get(m.id);
      if (!nextTransform) return m;
      // Membership follows the model: it stands on whichever plate it now does.
      return withPlateMembership({ ...m, transform: nextTransform }, plateFramesRef.current, options?.landedPlateId);
    }));

    if (followedPlateId && activePlateIdRef.current !== followedPlateId) {
      setActivePlateId(followedPlateId);
      // The drop brings the view with it, the way picking a bed does. The drop, not
      // the pointer moving: the camera must not jump out from under the drag.
      setPlateViewRunId((id) => id + 1);
    }

    return {
      updated: true,
      supportsChanged,
      kickstandsChanged,
      supportLocalFramePreserved,
    };
  }, []);

  const commitModelTransformHistory = useCallback((
    id: string,
    beforeTransform: ModelTransform,
    afterTransform: ModelTransform,
    description?: MessageDescriptor,
    supportSnapshotOptions?: TransformHistorySupportSnapshotOptions & {
      /**
       * Set when the same gesture created the plate the model landed on. The bed
       * is then part of this step, so one undo takes the model back and the empty
       * bed with it rather than leaving it behind.
       */
      plateSpawn?: { platesBefore: ScenePlate[]; activePlateIdBefore: string };
    },
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

    // A transform moves supports by the same delta as the model; the store already
    // holds them at the "after" position, so the undo step only needs the two
    // transforms. An explicit support state (a caller that also changed support
    // content) still takes the snapshot path.
    const includeSupportByOption = supportSnapshotOptions?.includeSupportState === true
      || !!supportSnapshotOptions?.supportBefore
      || !!supportSnapshotOptions?.supportAfter;
    const supportMoves: SupportTransformMove[] = [];
    if (!includeSupportByOption) {
      const supportStateNow = getSnapshot();
      if (hasSupportsForModel(id, supportStateNow)) {
        supportMoves.push({ modelId: id, from: beforeTransform, to: afterTransform });
      }
      for (const model of beforeModels) {
        if (model.id === id) continue;
        const current = currentModels.find((candidate) => candidate.id === model.id);
        if (!current || transformsEqual(model.transform, current.transform)) continue;
        if (!hasSupportsForModel(model.id, supportStateNow)) continue;
        supportMoves.push({ modelId: model.id, from: model.transform, to: current.transform });
      }
    }

    const spawn = supportSnapshotOptions?.plateSpawn;
    const before = captureSceneSnapshot(beforeModels, currentActiveModelId, currentSelectedModelIds, {
      includeSupportState: includeSupportByOption,
      supportStateOverride: supportSnapshotOptions?.supportBefore,
      supportStateOwned: !!supportSnapshotOptions?.supportBefore,
      ...(spawn ? { plates: spawn.platesBefore, activePlateId: spawn.activePlateIdBefore } : {}),
    });
    const after = captureSceneSnapshot(afterModels, currentActiveModelId, currentSelectedModelIds, {
      includeSupportState: includeSupportByOption,
      supportStateOverride: supportSnapshotOptions?.supportAfter,
      supportStateOwned: !!supportSnapshotOptions?.supportAfter,
      ...(spawn ? { plates: platesRef.current, activePlateId: activePlateIdRef.current } : {}),
    });
    const targetModelName = targetModel.name ?? id;
    pushSceneSnapshotHistory(before, after, description ?? transformModelLabel(targetModelName), undefined, supportMoves);
    return true;
  }, [pushSceneSnapshotHistory]);

  const commitModelTransformsHistory = useCallback((
    beforeTransforms: Array<{ id: string; transform: ModelTransform }>,
    description?: MessageDescriptor,
    supportSnapshotOptions?: TransformHistorySupportSnapshotOptions,
  ) => {
    const currentModels = modelsRef.current;
    const currentActiveModelId = activeModelIdRef.current;
    const currentSelectedModelIds = selectedModelIdsRef.current;
    const beforeTransformMap = new Map(beforeTransforms.map((entry) => [entry.id, entry.transform]));
    const changedIds = currentModels
      .filter((model) => {
        const beforeTransform = beforeTransformMap.get(model.id);
        return beforeTransform && !transformsEqual(beforeTransform, model.transform);
      })
      .map((model) => model.id);
    if (changedIds.length === 0) return false;

    const beforeModels = currentModels.map((model) => {
      const beforeTransform = beforeTransformMap.get(model.id);
      return beforeTransform
        ? { ...model, transform: cloneTransform(beforeTransform) }
        : model;
    });
    const includeSupportByOption = supportSnapshotOptions?.includeSupportState === true
      || !!supportSnapshotOptions?.supportBefore
      || !!supportSnapshotOptions?.supportAfter;
    const supportMoves: SupportTransformMove[] = [];
    if (!includeSupportByOption) {
      const supportStateNow = getSnapshot();
      for (const model of currentModels) {
        const beforeTransform = beforeTransformMap.get(model.id);
        if (!beforeTransform || transformsEqual(beforeTransform, model.transform)) continue;
        if (!hasSupportsForModel(model.id, supportStateNow)) continue;
        supportMoves.push({ modelId: model.id, from: beforeTransform, to: model.transform });
      }
    }

    const before = captureSceneSnapshot(beforeModels, currentActiveModelId, currentSelectedModelIds, {
      includeSupportState: includeSupportByOption,
      supportStateOverride: supportSnapshotOptions?.supportBefore,
    });
    const after = captureSceneSnapshot(currentModels, currentActiveModelId, currentSelectedModelIds, {
      includeSupportState: includeSupportByOption,
      supportStateOverride: supportSnapshotOptions?.supportAfter,
    });
    pushSceneSnapshotHistory(before, after, description ?? transformModelsLabel(beforeTransforms.length), undefined, supportMoves);
    return true;
  }, [pushSceneSnapshotHistory]);

  const updateModelTransforms = useCallback((
    updates: Array<{ id: string; transform: ModelTransform }>,
    options?: {
      pushHistory?: boolean;
      /**
       * Set when the same action added the plates these models land on. The beds are
       * then part of this step, so one undo takes the models back and the beds with
       * them rather than leaving empty beds behind.
       */
      platesBefore?: { plates: ScenePlate[]; activePlateId: string };
      /** The beds as they stand after the addition. Defaults to the hook's own list. */
      platesAfter?: { plates: ScenePlate[]; activePlateId: string };
    },
  ) => {
    const lockedMove = updates.find((update) => {
      const model = modelsRef.current.find((candidate) => candidate.id === update.id);
      if (!model) return false;
      // The bed it is leaving, and the bed it would land on: a model dragged onto a locked bed is
      // refused there, even though the bed it came from takes edits. Refusing the commit leaves
      // the model where it started, which is what the drag should have done.
      if (isModelPlateLocked(model)) return true;
      return isModelPlateLocked({ ...model, transform: update.transform });
    });
    if (lockedMove) {
      // Say so: a transform that silently does nothing reads as a broken tool.
      const refused = modelsRef.current.find((candidate) => candidate.id === lockedMove.id);
      onBlockedByLockRef.current?.(refused ? lockedPlateIdFor(refused, lockedMove.transform) : undefined);
      return {
        updated: false,
        supportsChanged: false,
        kickstandsChanged: false,
        supportLocalFramePreserved: false,
      };
    }
    if (updates.length === 0) {
      return {
        updated: false,
        supportsChanged: false,
        kickstandsChanged: false,
        supportLocalFramePreserved: false,
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
    const allUpdatedIds = Array.from(updateMap.keys());
    const includeSupportHistory = allUpdatedIds.some((id) => hasSupportsForModel(id, supportStateBefore));

    const shouldPushHistory = options?.pushHistory !== false;
    const platesBefore = options?.platesBefore;
    const before = shouldPushHistory
      ? captureSceneSnapshot(currentModels, currentActiveModelId, currentSelectedModelIds, {
          includeSupportState: includeSupportHistory,
          supportStateOverride: includeSupportHistory ? supportStateBefore : undefined,
          ...(platesBefore ? { plates: platesBefore.plates, activePlateId: platesBefore.activePlateId } : {}),
        })
      : null;

    let supportsChanged = false;
    let kickstandsChanged = false;
    let updated = false;
    let supportLocalFramePreserved = true;
    const perfStoreStart = perfMark();
    updateMap.forEach((nextTransform, id) => {
      const currentModel = currentModels.find((model) => model.id === id);
      if (!currentModel) return;
      if (transformsEqual(currentModel.transform, nextTransform)) return;
      const before = currentModel.transform;
      if (Math.abs(before.rotation.x - nextTransform.rotation.x) > 1e-8
        || Math.abs(before.rotation.y - nextTransform.rotation.y) > 1e-8
        || Math.abs(before.rotation.z - nextTransform.rotation.z) > 1e-8
        || before.rotation.order !== nextTransform.rotation.order
        || Math.abs(before.scale.x - nextTransform.scale.x) > 1e-8
        || Math.abs(before.scale.y - nextTransform.scale.y) > 1e-8
        || Math.abs(before.scale.z - nextTransform.scale.z) > 1e-8
        || Math.abs(before.position.z - nextTransform.position.z) > 1e-8) {
        supportLocalFramePreserved = false;
      }
      const commit = transformSupportsForModel(id, before, nextTransform);
      supportsChanged = supportsChanged || commit.supportsChanged;
      kickstandsChanged = kickstandsChanged || commit.kickstandsChanged;
      updated = true;
    });

    perfMeasure('store:transform', perfStoreStart);

    if (!updated) {
      return {
        updated: false,
        supportsChanged,
        kickstandsChanged,
        supportLocalFramePreserved: false,
      };
    }

    const nextModels = currentModels.map((m) => {
      const nextTransform = updateMap.get(m.id);
      if (!nextTransform) return m;
      // Membership follows the model, folded into the same update so a drag does
      // not cost a second render.
      return withPlateMembership({ ...m, transform: nextTransform }, plateFramesRef.current);
    });

    // Follow the moved set when it lands wholly on one plate, which is a drag of one or a
    // few models onto another bed. The Multi-Plate setting can turn the following off.
    const movedPlateIds = new Set(
      nextModels
        .filter((model) => updateMap.has(model.id) && model.plateId)
        .map((model) => model.plateId as string),
    );
    const followedPlateId = followedPlateIdForMove({
      followLandedPlate: followLandedPlateRef.current,
      landedPlateIds: movedPlateIds,
    });
    if (followedPlateId && activePlateIdRef.current !== followedPlateId) {
      setActivePlateId(followedPlateId);
      // A drag that lands on another bed makes that bed the one you are on, and the view
      // comes with it — after the drop, never during it, which is why this is the commit
      // rather than the pointer moving.
      setPlateViewRunId((id) => id + 1);
    }

    if (!shouldPushHistory) modelsRef.current = nextModels;
    setModels(nextModels);

    if (shouldPushHistory && before) {
      const supportStateAfter = includeSupportHistory ? getSnapshot() : undefined;
      const after = captureSceneSnapshot(nextModels, currentActiveModelId, currentSelectedModelIds, {
        includeSupportState: includeSupportHistory,
        supportStateOverride: supportStateAfter,
        ...(platesBefore
          ? {
              plates: options?.platesAfter?.plates ?? platesRef.current,
              activePlateId: options?.platesAfter?.activePlateId ?? activePlateIdRef.current,
            }
          : {}),
      });
      pushSceneSnapshotHistory(before, after, transformModelsLabel(updates.length));
    }

    return {
      updated,
      supportsChanged,
      kickstandsChanged,
      supportLocalFramePreserved,
    };
  }, [pushSceneSnapshotHistory]);

  const replaceModelGeometry = useCallback((
    id: string,
    nextBufferGeometry: THREE.BufferGeometry,
    historyDescription: MessageDescriptor,
    options?: {
      includeSupportState?: boolean;
      deferPostProcessing?: boolean;
      meshModifiersAfter?: ModelMeshModifiers | null;
      meshModifiersBefore?: ModelMeshModifiers | null;
      /** Lands with the geometry, in the same update and history step. */
      transformAfter?: ModelTransform;
      /**
       * Records a history step whose before-state differs from the live scene: a tool
       * that previewed its change on the model (Mirror) passes the state from before it.
       */
      historyBefore?: { transform?: ModelTransform; supportState?: SupportState };
    },
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

    // Rebuild the edge overlay for the swapped geometry, but only when the model
    // had one — i.e. when the user has the overlay enabled (`buildModelEdgeGeometry`
    // is never called otherwise, so presence is the enable signal).
    const nextEdgeGeometry = target.geometry.edgeGeometry
      ? buildModelEdgeGeometry(nextBufferGeometry)
      : undefined;

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

    const polygonCount = nextBufferGeometry.getAttribute('position')
      ? countTriangles(nextBufferGeometry)
      : target.polygonCount;

    const modifierAfter = options?.meshModifiersAfter;
    const historyBefore = options?.historyBefore;
    const recordHistory = modifierAfter !== undefined || historyBefore !== undefined;
    const includeSupportHistory = recordHistory
      ? (options?.includeSupportState ?? hasSupportsForModel(id, getSnapshot()))
      : false;
    const modelsBefore = historyBefore?.transform
      ? currentModels.map((m) => (m.id === id ? { ...m, transform: historyBefore.transform as ModelTransform } : m))
      : currentModels;
    const before = recordHistory
      ? captureSceneSnapshot(modelsBefore, currentActiveModelId, currentSelectedModelIds, {
          includeSupportState: includeSupportHistory,
          supportStateOverride: historyBefore?.supportState,
        })
      : null;
    if (before && modifierAfter !== undefined) {
      before.modifierRecord = {
        modelId: id,
        modifiers: cloneMeshModifiersForHistory(options?.meshModifiersBefore !== undefined ? options.meshModifiersBefore : getStoredMeshModifiers(id)),
      };
    }

    const nextModels = currentModels.map((m) => (
      m.id === id
        ? {
            ...m,
            geometry: nextGeometry,
            polygonCount,
            ...(options?.transformAfter ? { transform: cloneTransform(options.transformAfter) } : {}),
            isSupportGeometry: target.isSupportGeometry,
            linkGroupId: target.linkGroupId,
          }
        : m
    ));
    if (modifierAfter !== undefined) {
      storeModelMeshModifiers(id, modifierAfter);
      clearPreparedGeometryCacheForModel(id);
    }
    setModels(nextModels);

    if (before) {
      const after = captureSceneSnapshot(nextModels, currentActiveModelId, currentSelectedModelIds, {
        includeSupportState: includeSupportHistory,
      });
      if (modifierAfter !== undefined) {
        after.modifierRecord = { modelId: id, modifiers: cloneMeshModifiersForHistory(modifierAfter) };
      }
      pushSceneSnapshotHistory(before, after, historyDescription, id);
    }
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
    historyDescription: MessageDescriptor,
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

    const polygonCount = countTriangles(bufferGeometry);

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
      meshModifiers: base.meshModifiers ? clonePlainData(base.meshModifiers) : undefined,
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
    historyDescription: MessageDescriptor,
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
      polygonCount: countTriangles(pg.geometry),
      meshModifiers: source.meshModifiers ? clonePlainData(source.meshModifiers) : undefined,
    }));

    // ONE atomic update: source becomes part 0 (geometry swapped + position
    // compensated so it doesn't shift), the rest are appended.
    const nextModels = [
      ...currentModels.map((m) => (
        m.id === sourceId
          ? {
              ...m,
              geometry: part0,
              polygonCount: countTriangles(part0.geometry),
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

  /**
   * The Higher Contrast Model Edges setting can be enabled after models are
   * already loaded, and those models have no overlay geometry — import only
   * builds one while the setting is on. Fill them in here, one model per idle
   * callback: each build is ~2 s for a 500k-triangle mesh, so a batch would
   * freeze the app, and the overlay is worth nothing until it is looked at.
   * The result is cached on the geometry, so it is built exactly once.
   */
  const higherContrastModelEdges = useSyncExternalStore(
    subscribeToWorkspaceCameraSettings,
    getWorkspaceCameraSettingsSnapshot,
    getWorkspaceCameraSettingsServerSnapshot,
  ).higherContrastModelEdges;

  useEffect(() => {
    if (!MODEL_EDGE_OVERLAY_ENABLED || !higherContrastModelEdges) return;

    const queue = modelsRef.current
      .filter((model) => !model.geometry.edgeGeometry && model.geometry.geometry.getAttribute('position'))
      .map((model) => model.id);
    if (queue.length === 0) return;

    let cancelled = false;
    const scheduleIdle = (cb: () => void) => {
      if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(cb, { timeout: 500 });
      } else {
        setTimeout(cb, 16);
      }
    };

    const step = () => {
      if (cancelled) return;
      const id = queue.shift();
      if (!id) return;

      const model = modelsRef.current.find((m) => m.id === id);
      if (model) {
        const edges = buildModelEdgeGeometry(model.geometry.geometry);
        if (edges) {
          setModels((prev) => prev.map((m) => (
            m.id === id && m.geometry === model.geometry
              ? { ...m, geometry: { ...m.geometry, edgeGeometry: edges } }
              : m
          )));
        }
      }
      if (queue.length > 0) scheduleIdle(step);
    };

    scheduleIdle(step);
    return () => { cancelled = true; };
  }, [higherContrastModelEdges, setModels]);

  /**
   * Baked ambient occlusion.
   *
   * One native bake per model, on an idle callback, off the main thread:
   * `dragonfruit-mesh-core::vertex_occlusion` fires a hemisphere fan per vertex
   * from the mesh's own normal, which measures 12-263 ms for 40k-640k triangle
   * meshes. The result is attached to the geometry as `aBakedAo`, so nothing is
   * paid per frame afterwards.
   */
  useEffect(() => {
    // Whatever the last run left, this one owns the queue from here: cleared
    // before any early return, because a stale one keeps
    // `hasPendingBackgroundGeometryWork()` true for work nobody will do (the
    // modifier-apply overlay polls it to clear its spinner).
    pendingAoQueueRef.current = [];

    // Zero intensity means off, so there is nothing to bake for: raising the
    // slider later re-runs this and the geometries that never got an attribute
    // are the ones that get baked.
    if (!canBakeOcclusion() || bakedAoIntensity <= 0) return;

    const queue = modelsRef.current
      .filter((model) => {
        const geometry = model.geometry.geometry;
        if (!geometry.getAttribute('position')) return false;
        // Re-bake when the geometry was replaced (repair, boolean cut, hole
        // punch): the attribute lives on the old geometry, so without this the
        // new shape would be shaded with the old shape's occlusion.
        if (geometry.getAttribute(BAKED_OCCLUSION_ATTRIBUTE) !== undefined) return false;
        // A bake already in flight for this geometry has not attached yet, so it
        // would look identical to "never baked" and be sent a second time.
        return !pendingAoGeometriesRef.current.has(geometry);
      })
      .map((model) => model.id);
    if (queue.length === 0) return;

    // What this run still has to bake, as a ref as well as a local: the workers
    // below shift the same array, so the ref is the live remainder and
    // `hasPendingBackgroundGeometryWork` can read it without the run's own
    // bookkeeping. Re-derived on every run, so a superseded run cannot leave
    // anything counted.
    pendingAoQueueRef.current = queue;

    let cancelled = false;

    const scheduleIdle = (cb: () => void) => {
      if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(cb, { timeout: 500 });
      } else {
        setTimeout(cb, 16);
      }
    };

    const bakeOne = async () => {
      if (cancelled) return;
      const id = queue.shift();
      if (!id) return;
      // Taken, so in flight: the counter rides the take, not the whole queue. It
      // used to be `+= queue.length` at the top of the run and decremented per
      // bake, so the items a superseded run never took stayed counted — and every
      // `models` change while a bake was queued (a hollowing apply patches them,
      // the idle plane pass patches them again) leaked one. The "finalizing"
      // overlay then waited out its 20 s cap after every hollow, with all the
      // work done in the first 200 ms.
      pendingAoBakeRef.current += 1;
      const model = modelsRef.current.find((m) => m.id === id);
      const geometry = model?.geometry.geometry;
      if (geometry) pendingAoGeometriesRef.current.add(geometry);
      try {
        if (geometry) {
          const occlusion = await bakeOcclusionForGeometry(geometry);
          // Attach whatever came back even if this run was superseded: the
          // values belong to this geometry, and discarding them is what left
          // it looking unbaked and re-queueable on the next `models` change.
          if (occlusion) {
            const attribute = new THREE.BufferAttribute(occlusion, 1);
            attribute.setUsage(THREE.StaticDrawUsage);
            geometry.setAttribute(BAKED_OCCLUSION_ATTRIBUTE, attribute);
            // The store, not the `models` array: replacing that array here
            // invalidated everything derived from it — the clearance map and
            // the raft rebuilt on every bake that landed. See
            // `bumpBakedOcclusionVersion`.
            bumpBakedOcclusionVersion(geometry);
          }
        }
      } catch (error) {
        // A failed bake is not worth surfacing: the model simply keeps the
        // unoccluded look it has today.
        console.warn('[ao] bake failed', error);
      } finally {
        if (geometry) pendingAoGeometriesRef.current.delete(geometry);
        pendingAoBakeRef.current = Math.max(0, pendingAoBakeRef.current - 1);
        // One model per idle callback, not a loop over the queue. The soup copy
        // and the attribute attach are main-thread work, so chaining bakes back to
        // back is what made a fifteen-model scene stutter for the whole drain
        // rather than between models. Interaction always outranks this.
        scheduleIdle(() => void bakeOne());
      }
    };

    // Two bakes in flight, not one. The ray pass saturates the pool on its own,
    // but the weld, the tree build and the IPC transfer of each model are serial
    // phases — on a print-sized model that is about a quarter of its bake, and in
    // a loaded scene it is a quarter of *every* model's bake spent with fifteen
    // cores idle. Both commands share one rayon pool, so overlapping them lets
    // one model's serial phase run during another's ray pass. Two rather than
    // more: each in-flight bake holds its soup and its output, and past a couple
    // the pool is oversubscribed for no further gain.
    for (let worker = 0; worker < Math.min(AO_BAKE_CONCURRENCY, queue.length); worker += 1) {
      scheduleIdle(() => void bakeOne());
    }
    return () => { cancelled = true; };
  }, [models, bakedAoIntensity]);

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
    const currentModels = modelsRef.current;
    const target = currentModels.find((model) => model.id === id);
    if (!target || target.visible === visible) return;

    const nextModels = currentModels.map((model) => (
      model.id === id ? { ...model, visible } : model
    ));
    const before = captureSceneSnapshot(currentModels, activeModelIdRef.current, selectedModelIdsRef.current);
    setModels(nextModels);
    const after = captureSceneSnapshot(nextModels, activeModelIdRef.current, selectedModelIdsRef.current);
    pushSceneSnapshotHistory(before, after, visible ? showModelLabel(target.name) : hideModelLabel(target.name));
  }, [pushSceneSnapshotHistory]);

  const lastModifierHistoryRef = useRef<{ key: string; modelId: string; description: MessageDescriptor; at: number } | null>(null);

  /**
   * Stores a model's mesh modifiers. With `historyDescription` the change is an undo step: the
   * modifiers ride on a scene snapshot's `modifierRecord`, and the hollowing and hole-punch
   * panels resync from them on undo. With `merge` as well, a run of edits with the same
   * description on the same model, each within the merge window of the last and with nothing
   * pushed in between, stays one step whose after-state follows the latest edit.
   */
  const setModelMeshModifiers = useCallback((
    id: string,
    meshModifiers: ModelMeshModifiers | undefined,
    options?: ModelMeshModifiersHistoryOptions,
  ) => {
    const description = options?.historyDescription;
    const modifiersBefore = description ? cloneMeshModifiersForHistory(getStoredMeshModifiers(id)) : undefined;
    // Store externally — model objects never carry meshModifiers directly.
    storeModelMeshModifiers(id, meshModifiers);

    if (description) {
      const now = Date.now();
      const last = lastModifierHistoryRef.current;
      const top = peekUndo();
      const mergeInto = options?.merge
        && last
        && last.modelId === id
        && last.description.id === description.id
        && now - last.at <= MODIFIER_HISTORY_MERGE_WINDOW_MS
        && top?.type === SCENE_MODELS_SNAPSHOT_APPLY
        && (top.payload as SceneSnapshotPayload | undefined)?.key === last.key
        ? sceneSnapshotRegistry.get(last.key)
        : undefined;
      if (mergeInto && last) {
        mergeInto.after.modifierRecord = { modelId: id, modifiers: cloneMeshModifiersForHistory(meshModifiers) };
        last.at = now;
      } else {
        const currentModels = modelsRef.current;
        const before = captureSceneSnapshot(currentModels, activeModelIdRef.current, selectedModelIdsRef.current);
        before.modifierRecord = { modelId: id, modifiers: modifiersBefore };
        const after = captureSceneSnapshot(currentModels, activeModelIdRef.current, selectedModelIdsRef.current);
        after.modifierRecord = { modelId: id, modifiers: cloneMeshModifiersForHistory(meshModifiers) };
        const key = storeSceneSnapshotPair({ before, after });
        // No `modelId` on the payload: that is the geometry-swap marker the hollowing manager
        // drops its caches on, and a draft edit leaves the geometry alone.
        sceneHistory.push({ type: SCENE_MODELS_SNAPSHOT_APPLY, description, payload: { key } });
        lastModifierHistoryRef.current = { key, modelId: id, description, at: now };
      }
    }

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
    const currentModels = modelsRef.current;
    const target = currentModels.find((model) => model.id === id);
    if (!target || target.name === name) return;

    const nextModels = currentModels.map((model) => (
      model.id === id ? { ...model, name } : model
    ));
    const before = captureSceneSnapshot(currentModels, activeModelIdRef.current, selectedModelIdsRef.current);
    setModels(nextModels);
    const after = captureSceneSnapshot(nextModels, activeModelIdRef.current, selectedModelIdsRef.current);
    pushSceneSnapshotHistory(before, after, renameLabel(target.name));
  }, [pushSceneSnapshotHistory]);

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
        ?? countTriangles(bodyGeom.geometry),
    }));

    const currentModels = modelsRef.current;
    const before = captureSceneSnapshot(currentModels, activeModelIdRef.current, selectedModelIdsRef.current);

    // Remove the merged source, add individual models
    const nextModels = [
      ...currentModels.filter((m) => m.id !== modelId),
      ...newModels,
    ];
    setModels(nextModels);

    // Select all new bodies
    const newIds = newModels.map((m) => m.id);
    setActiveModelId(newIds[0]);
    setSelectedModelIds(newIds);

    const after = captureSceneSnapshot(nextModels, newIds[0], newIds);
    pushSceneSnapshotHistory(before, after, splitModelLabel(source.name));
  }, [pushSceneSnapshotHistory]);

  /** Splits a model that has a classified model/support triangle split
   *  (from the native repair engine) into two independent models:
   *  one for the model body and one for the support geometry.
   *  Requires `model_triangle_count` in the native repair report. */
  const splitSupports = useCallback(async (modelId: string) => {
    setImportProgress({
      active: true,
      type: 'mesh',
      label: importLabelSplittingSupports(_),
      detail: importDetailSeparatingGeometry(_),
      progress: null,
    });
    await waitForUiYield();

    try {
    const source = modelsRef.current.find((m) => m.id === modelId);
    if (!source) return;

    const split = splitClassifiedSupportGeometry(source, {
      interactive: true,
      computeEdgeGeometry: getSavedWorkspaceCameraSettings().higherContrastModelEdges,
    });
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

    setImportProgress((p) => ({ ...p, detail: importDetailFinalizing(_) }));
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
        rebuilt: false,
        cancelled: false,
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
    pushSceneSnapshotHistory(before, after, splitSupportsLabel(source.name));
    } catch (e) {
      console.error(e);
      emitSceneImportReport(reportSplitSupportsFailed(_), 'error');
    } finally {
      setImportProgress({ active: false, type: null, label: '', detail: '', progress: null });
    }
  }, [_, pushSceneSnapshotHistory, setImportProgress, waitForUiYield, emitSceneImportReport]);

  /** Re-combines split model and support geometries back into a single model,
   *  transforming the supports to align with any model movement/rotation. */
  const mergeSupports = useCallback(async () => {
    setImportProgress({
      active: true,
      type: 'mesh',
      label: importLabelMergingSupports(_),
      detail: importDetailRecombiningGeometry(_),
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
          rebuilt: false,
          cancelled: false,
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
      pushSceneSnapshotHistory(before, after, mergeSupportsLabel(mergedModel.name));
    } catch (e) {
      console.error(e);
      emitSceneImportReport(reportMergeSupportsFailed(_), 'error');
    } finally {
      setImportProgress({ active: false, type: null, label: '', detail: '', progress: null });
    }
  }, [_, pushSceneSnapshotHistory, setImportProgress, waitForUiYield, emitSceneImportReport]);

  const scanModelForSupportsInPlace = useCallback(async (modelId: string): Promise<boolean> => {
    const model = modelsRef.current.find(m => m.id === modelId);
    if (!model) return false;
    
    setImportProgress({
      active: true,
      type: 'mesh',
      label: importLabelScanningSupports(_),
      detail: importDetailClassifyingFile(model.name, _),
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
      const polygonCount = processed.geometry.getAttribute('position')
        ? countTriangles(processed.geometry)
        : model.polygonCount;
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
        emitSceneImportReport(reportScanned(model.name, _), 'success');
      }

      return true;
    } catch (err) {
      console.error('[scanModelForSupportsInPlace] Scan failed:', err);
      setPendingMeshRepairReports([]);
      const message = err instanceof Error ? err.message : String(err);
      emitSceneImportReport(reportScanFailed(message, _), 'error', { durationMs: 6_000 });
      return false;
    } finally {
      setImportProgress({ active: false, type: null, label: '', detail: '', progress: null });
    }
  }, [_, clearSceneImportReport, emitSceneImportReport, setImportProgress, waitForUiYield]);

  const renameGroup = useCallback((groupId: string, nextName: string) => {
    const trimmed = nextName.trim();
    if (!trimmed) return;

    const currentModels = modelsRef.current;
    const members = currentModels.filter((model) => model.groupId === groupId);
    if (members.length === 0 || members.every((model) => model.groupName === trimmed)) return;

    const nextModels = currentModels.map((model) => (
      model.groupId === groupId
        ? { ...model, groupName: trimmed }
        : model
    ));
    const before = captureSceneSnapshot(currentModels, activeModelIdRef.current, selectedModelIdsRef.current);
    setModels(nextModels);
    const after = captureSceneSnapshot(nextModels, activeModelIdRef.current, selectedModelIdsRef.current);
    pushSceneSnapshotHistory(before, after, renameLabel(members[0].groupName ?? trimmed));
  }, [pushSceneSnapshotHistory]);

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

  const deleteModels = useCallback(async (idsInput: string[], options?: { pushHistory?: boolean }) => {
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
    const supportsByModel = new Map<string, ModelSupportIds>();
    const supportPrimitiveCountByModel = new Map<string, number>();

    for (const model of existing) {
      const supportIds = getSupportsForModel(supportStateBeforeDelete, model.id);
      supportsByModel.set(model.id, supportIds);

      // Every modelId-bearing collection `getSupportsForModel` fills.
      const supportPrimitiveCount = MODEL_ID_COLLECTION_KEYS
        .reduce((total, key) => total + supportIds[key].length, 0);

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

      return MODEL_ID_COLLECTION_KEYS.some((key) => supportIds[key].length > 0);
    };

    const includeSupportHistory = existing.some((model) => modelHasSupports(model.id));
    const currentModels = modelsRef.current;
    const currentActiveModelId = activeModelIdRef.current;
    const currentSelectedModelIds = selectedModelIdsRef.current;

    // A caller removing a whole plate pushes one entry for the plate and its
    // models together, so it asks this to stay off the stack.
    const shouldPushHistory = options?.pushHistory !== false;
    // The beds are named in both snapshots: the delete that empties the scene takes the
    // spare beds with it, and undo has to bring them back with the models.
    const currentPlates = platesRef.current;
    const before = shouldPushHistory
      ? captureSceneSnapshot(currentModels, currentActiveModelId, currentSelectedModelIds, {
          plates: currentPlates,
          activePlateId: activePlateIdRef.current,
          includeSupportState: includeSupportHistory,
        })
      : null;

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

    /**
     * A scene with nothing left standing is one empty bed, not a scatter of empty ones:
     * beds exist to hold models, so the delete that empties the scene takes the spare
     * beds with it. Plate 1 stays — the scene always has a bed under it — and the view
     * follows, the way it does when the bed being worked on goes.
     */
    const emptyingTheScene = nextModels.length === 0 && currentPlates.length > 1;
    const nextPlates = emptyingTheScene ? currentPlates.slice(0, 1) : currentPlates;
    const nextActivePlateId = emptyingTheScene ? currentPlates[0].id : activePlateIdRef.current;
    if (emptyingTheScene) {
      setPlates(nextPlates);
      if (activePlateIdRef.current !== nextActivePlateId) setPlateViewRunId((id) => id + 1);
      setActivePlateId(nextActivePlateId);
    }

    setModels(nextModels);
    setActiveModelId(nextActiveModelId);
    setSelectedModelIds(nextSelectedModelIds);

    // Clean up external mesh modifier store
    ids.forEach((id) => deleteStoredMeshModifiers(id));

    // Clean up associated supports before capturing the "after" snapshot so undo/redo remains atomic.
    const supportState = getSnapshot();
    let totalRemovedSupports = 0;
    if (includeSupportHistory) {
      // One pass and one store write for the whole selection: a per-model call
      // rebuilt the support store once per model, so Ctrl+A, Delete on a
      // supported plate normalised twenty times.
      totalRemovedSupports += deleteSupportsForModelIds(supportState, ids);

      // Defensive pass: guarantee no orphaned supports survive model deletion.
      const orphanedModelIds = Array.from(ids).filter((modelId) => {
        const remaining = getSupportsForModel(getSnapshot(), modelId);
        return MODEL_ID_COLLECTION_KEYS.some((key) => remaining[key].length > 0);
      });
      if (orphanedModelIds.length > 0) {
        totalRemovedSupports += deleteSupportsForModelIds(getSnapshot(), orphanedModelIds);
      }
    }
    // Prepare's merged support geometry is per model and outlives the view that
    // built it; the delete has to hand it back or a cleared plate keeps every
    // deleted model's merged supports in RAM.
    releasePrepareMergedSupportsFor(ids);

    if (shouldPushHistory && before) {
      const after = captureSceneSnapshot(nextModels, nextActiveModelId, nextSelectedModelIds, {
        plates: nextPlates,
        activePlateId: nextActivePlateId,
        includeSupportState: includeSupportHistory,
      });
      const deletedLabel = existing.length === 1
        ? deleteModelLabel(existing[0].name)
        : deleteModelsLabel(existing.length);
      const deleteHistoryKey = pushSceneSnapshotHistory(before, after, deletedLabel);
      // A delete must actually give the mesh memory back. The undo pair is the
      // only thing still holding the deleted geometry, so move that geometry to
      // the scratch store now instead of letting it sit in RAM until the history
      // budget evicts the pair. Undo re-reads it; shared meshes are skipped.
      void spillSceneSnapshotKey(deleteHistoryKey, nextModels);
    }

    console.log(`[SceneCollection] Deleted ${ids.size} model(s) and ${totalRemovedSupports} associated supports.`);
  }, [pushSceneSnapshotHistory, tryRevokeObjectUrl, waitForUiYield]);

  const deleteModel = useCallback((id: string) => {
    void deleteModels([id]);
  }, [deleteModels]);

  const deleteSupportsForModels = useCallback((idsInput: string[], description?: MessageDescriptor) => {
    const ids = new Set(idsInput);
    if (ids.size === 0) return 0;

    const currentModels = modelsRef.current;
    const existingModelIds = currentModels
      .filter((model) => ids.has(model.id))
      .map((model) => model.id);
    if (existingModelIds.length === 0) return 0;

    const supportStateBefore = getSnapshot();
    const hasSupportsForModel = (modelId: string) => {
      const supportIds = getSupportsForModel(supportStateBefore, modelId);
      return MODEL_ID_COLLECTION_KEYS.some((key) => supportIds[key].length > 0);
    };

    const targetIds = existingModelIds.filter((modelId) => hasSupportsForModel(modelId));
    if (targetIds.length === 0) return 0;

    const currentActiveModelId = activeModelIdRef.current;
    const currentSelectedModelIds = selectedModelIdsRef.current;
    const before = captureSceneSnapshot(currentModels, currentActiveModelId, currentSelectedModelIds, { includeSupportState: true });

    let totalRemovedSupports = 0;
    const supportState = getSnapshot();
    totalRemovedSupports += deleteSupportsForModelIds(supportState, targetIds);

    const after = captureSceneSnapshot(currentModels, currentActiveModelId, currentSelectedModelIds, { includeSupportState: true });
    const defaultDescription = targetIds.length === 1
      ? deleteSupportsForModelLabel(currentModels.find((m) => m.id === targetIds[0])?.name ?? targetIds[0])
      : deleteSupportsForModelsLabel(targetIds.length);

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
    const targetIds = (ids && ids.length > 0) ? ids : selectedModelIds;
    if (targetIds.length === 0) return false;

    const selected = selectModelsForClipboard(models, targetIds);
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

  const cutSelectedModels = useCallback((ids: string[]) => {
    return performModelCut(ids, copySelectedModels, deleteModels);
  }, [copySelectedModels, deleteModels]);

  const cutModel = useCallback((id: string) => {
    return cutSelectedModels([id]);
  }, [cutSelectedModels]);

  const pasteModel = useCallback(() => {
    if (modelClipboard.length === 0) return null;

    const beforeModels = models;
    const beforeActiveModelId = activeModelId;
    const beforeSelectedModelIds = selectedModelIds;
    const supportStateBefore = getSnapshot();
    const first = modelClipboard[0];

    const pastedGeometry = cloneGeometryWithBounds(first.geometry, { shared: true });

    const id = uuidv4();
    const pastedModel: LoadedModel = {
      id,
      name: pastedModelName(first.name, _),
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
      beginSupportStateBatch();
      try {
        pasteModelSupportsFromClipboard(
          first.supportClipboard,
          id,
          first.transform,
          pastedModel.transform,
          { recordHistory: false },
        );
      } finally {
        endSupportStateBatch();
        endSupportStateBatch();
      }

      const before = captureSceneSnapshot(beforeModels, beforeActiveModelId, beforeSelectedModelIds, {
        includeSupportState: true,
        supportStateOverride: supportStateBefore,
      });
      const after = captureSceneSnapshot(nextModels, id, [id], { includeSupportState: true });
      pushSceneSnapshotHistory(before, after, pasteModelLabel(first.name));
    });

    return id;
  }, [_, activeModelId, cloneGeometryWithBounds, modelClipboard, models, pushSceneSnapshotHistory, selectedModelIds]);

  const pasteCopiedModelsAutoArrange = useCallback((spacingMm = 5) => {
    if (modelClipboard.length === 0) return [] as string[];

    const beforeModels = models;
    const beforeActiveModelId = activeModelId;
    const beforeSelectedModelIds = selectedModelIds;
    const supportStateBefore = getSnapshot();
    const platesBefore = platesRef.current;
    const entries = modelClipboard;

    const centerX = defaultImportCenterXY.x;
    const centerY = defaultImportCenterXY.y;
    // The search runs in world coordinates over the ACTIVE plate's volume, so a
    // model imported onto the second plate lands on the second plate.
    const { minX, maxX, minY, maxY } = activePlateRect;

    type Rect2D = { minX: number; maxX: number; minY: number; maxY: number };

    const intersectsRect = (a: Rect2D, b: Rect2D) => {
      return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
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

      // Every declared type widens the rectangle. A brace contributes nothing
      // of its own: the knots it spans are expanded above. The radius field
      // differs by contact kind -- a cone's is in its profile, a disk's is on
      // the contact.
      for (const descriptor of SUPPORT_TYPES) {
        const entities = payload[descriptor.location.key] as unknown as Array<Record<string, any>> | undefined;
        if (!entities) continue;
        for (const entity of entities) {
          if (descriptor.hasSegments) expandSegments(entity.segments as any[]);
          for (const { kind, field } of contactEndpointsFor(descriptor.id)) {
            const contact = entity[field];
            if (!contact?.pos) continue;
            const diameter = kind === 'cone'
              ? contact.profile?.contactDiameterMm
              : contact.contactDiameterMm;
            expand(contact.pos, Math.max(0.001, (diameter ?? 0) / 2));
          }
        }
      }

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
      geometry: Pick<GeometryWithBounds, 'geometry' | 'center'>,
      transform: ModelTransform,
      supportPayload: SupportClipboardPayload | null | undefined,
    ): PlacementOffsets => {
      // The footprint every other placement uses: projected through the whole rotation,
      // so a model tipped on X or Y is not packed by its unrotated size.
      const meshFootprint = footprintForTransform(geometry, transform);
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
      entry.geometry,
      entry.transform,
      entry.supportClipboard,
    ));

    const maxWidth = Math.max(...entryPlacementOffsets.map((entry) => entry.width));
    const maxDepth = Math.max(...entryPlacementOffsets.map((entry) => entry.depth));

    const blockedRects: Rect2D[] = models
      .filter((model) => model.visible)
      .map((model) => {
        const meshPlacement = buildPlacementOffsets(
          { x: model.transform.position.x, y: model.transform.position.y },
          model.geometry,
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

    /**
     * Places as many of `pending` as the given bed can take, in that bed's own
     * coordinates, and hands back the ones it could not.
     *
     * Only positions that keep a model wholly on the bed count. A copy hanging over the
     * edge is one the out-of-volume check is right to flag, and a copy out in the void
     * beside the scene is worse than the bed it should have been given, so anything left
     * over goes to the next bed — which the caller adds.
     */
    /**
     * Places as many of `pending` as the given bed can take, in that bed's own frame, and
     * hands back the ones it could not.
     *
     * Only positions that keep a copy wholly on the bed count. A copy hanging over the
     * edge is one the out-of-volume check is right to flag, and a copy out in the void
     * beside the scene is worse than the bed it should have been given, so anything left
     * over goes to the next bed — which the caller adds.
     */
    const placeIntoBed = (
      bedRect: Rect2D,
      bedCenter: { x: number; y: number },
      blockers: readonly Rect2D[],
      pending: Array<{ entryIndex: number; placement: PlacementOffsets }>,
    ): {
      placed: Array<{ entryIndex: number; x: number; y: number }>;
      unplaced: Array<{ entryIndex: number; placement: PlacementOffsets }>;
    } => {
      if (pending.length === 0) return { placed: [], unplaced: [] };

      const isInsideBed = (rect: Rect2D) => (
        rect.minX >= bedRect.minX
        && rect.maxX <= bedRect.maxX
        && rect.minY >= bedRect.minY
        && rect.maxY <= bedRect.maxY
      );

      const stepX = Math.max(4, maxWidth + Math.max(0, spacingMm));
      const stepY = Math.max(4, maxDepth + Math.max(0, spacingMm));

      // Candidate centres are the grid inside this bed, nearest its middle first.
      const halfSpanX = Math.max(Math.abs(bedCenter.x - bedRect.minX), Math.abs(bedRect.maxX - bedCenter.x));
      const halfSpanY = Math.max(Math.abs(bedCenter.y - bedRect.minY), Math.abs(bedRect.maxY - bedCenter.y));
      const maxRing = Math.max(Math.ceil(halfSpanX / stepX) + 2, Math.ceil(halfSpanY / stepY) + 2);

      const candidateCenters: Array<{ x: number; y: number; distSq: number }> = [];
      for (let ring = 0; ring <= maxRing; ring += 1) {
        if (ring === 0) {
          candidateCenters.push({ x: bedCenter.x, y: bedCenter.y, distSq: 0 });
          continue;
        }

        for (let gx = -ring; gx <= ring; gx += 1) {
          const x = bedCenter.x + gx * stepX;
          for (const gy of [ring, -ring]) {
            const y = bedCenter.y + gy * stepY;
            candidateCenters.push({ x, y, distSq: ((x - bedCenter.x) ** 2) + ((y - bedCenter.y) ** 2) });
          }
        }

        for (let gy = -ring + 1; gy <= ring - 1; gy += 1) {
          const y = bedCenter.y + gy * stepY;
          for (const gx of [ring, -ring]) {
            const x = bedCenter.x + gx * stepX;
            candidateCenters.push({ x, y, distSq: ((x - bedCenter.x) ** 2) + ((y - bedCenter.y) ** 2) });
          }
        }
      }

      candidateCenters.sort((a, b) => a.distSq - b.distSq);

      const placed: Array<{ entryIndex: number; x: number; y: number }> = [];
      const unplaced: Array<{ entryIndex: number; placement: PlacementOffsets }> = [];
      const taken: Rect2D[] = [];

      for (const { entryIndex, placement } of pending) {
        const rectAt = (x: number, y: number): Rect2D => ({
          minX: x + placement.minXOffset,
          maxX: x + placement.maxXOffset,
          minY: y + placement.minYOffset,
          maxY: y + placement.maxYOffset,
        });

        const spot = candidateCenters.find((candidate) => {
          const rect = rectAt(candidate.x, candidate.y);
          return isInsideBed(rect)
            && !blockers.some((blocked) => intersectsRect(rect, blocked))
            && !taken.some((blocked) => intersectsRect(rect, blocked));
        });

        if (!spot) {
          unplaced.push({ entryIndex, placement });
          continue;
        }

        taken.push(rectAt(spot.x, spot.y));
        placed.push({ entryIndex, x: spot.x, y: spot.y });
      }

      return { placed, unplaced };
    };

    // The plate being worked on is filled first, in world coordinates: the search runs
    // against its own volume, keeping clear of everything standing on it.
    const activeOffset = plateOffsetForRef.current(activePlateIdRef.current);
    /**
     * Where each copy ended up: in the millimetres of the bed it goes to. A bed is picked
     * after the plan, not during it, because the beds are all the same shape and one this
     * paste adds is empty — so what fits on one is known before it exists.
     */
    const placedByEntry = new Map<number, { bedId: string | null; slot: number; x: number; y: number }>();

    let pendingPlacements = entries.map((entry, entryIndex) => ({
      entryIndex,
      placement: entryPlacementOffsets[entryIndex],
    }));

    const activePlacements = placeIntoBed(
      { minX, maxX, minY, maxY },
      { x: centerX, y: centerY },
      blockedRects,
      pendingPlacements,
    );
    activePlacements.placed.forEach((entry) => {
      // The active plate's own millimetres, so a bed that moves under the copies when more
      // are added takes them with it.
      placedByEntry.set(entry.entryIndex, {
        bedId: activePlateIdRef.current,
        slot: -1,
        x: entry.x - activeOffset.dxMm,
        y: entry.y - activeOffset.dyMm,
      });
    });
    pendingPlacements = activePlacements.unplaced;

    const localPlateRect: Rect2D = plateLocalRect(view3dSettings);
    const { minX: localMinX, minY: localMinY } = localPlateRect;

    // The beds the scene already has are filled next, in plate order: the run that spilled
    // onto plate 2 leaves room on it, and a paste that went straight to a new bed would add
    // plate 3 alongside a bed that is still half empty. What each one holds is known — they
    // are the same shape as this plate, and what stands on them is in `blockedRects` — so a
    // copy that fits needs no new bed at all.
    for (const plate of platesRef.current) {
      if (pendingPlacements.length === 0) break;
      if (plate.id === activePlateIdRef.current) continue;

      const offset = plateOffsetForRef.current(plate.id);
      const bedRect: Rect2D = {
        minX: localPlateRect.minX + offset.dxMm,
        maxX: localPlateRect.maxX + offset.dxMm,
        minY: localPlateRect.minY + offset.dyMm,
        maxY: localPlateRect.maxY + offset.dyMm,
      };
      const bedPlacements = placeIntoBed(
        bedRect,
        { x: (bedRect.minX + bedRect.maxX) * 0.5, y: (bedRect.minY + bedRect.maxY) * 0.5 },
        blockedRects,
        pendingPlacements,
      );
      bedPlacements.placed.forEach((entry) => {
        // That bed's own millimetres, so it rides with the bed the way the active plate's
        // copies do.
        placedByEntry.set(entry.entryIndex, {
          bedId: plate.id,
          slot: -1,
          x: entry.x - offset.dxMm,
          y: entry.y - offset.dyMm,
        });
      });
      pendingPlacements = bedPlacements.unplaced;
    }

    // Whatever the beds could not take gets a bed of its own rather than hanging off an
    // edge or landing in the void beside the scene. The plan runs on a bed's own
    // frame — every bed is the same shape, and a bed added here is empty — so the beds are
    // added once, together, with the count the plan needs.
    let plannedBeds = 0;
    while (pendingPlacements.length > 0 && plannedBeds < MAX_PASTE_PLATES) {
      const bedPlacements = placeIntoBed(
        localPlateRect,
        { x: (localPlateRect.minX + localPlateRect.maxX) * 0.5, y: (localPlateRect.minY + localPlateRect.maxY) * 0.5 },
        [],
        pendingPlacements,
      );
      if (bedPlacements.placed.length === 0) break;

      bedPlacements.placed.forEach((entry) => {
        placedByEntry.set(entry.entryIndex, { bedId: null, slot: plannedBeds, x: entry.x, y: entry.y });
      });
      pendingPlacements = bedPlacements.unplaced;
      plannedBeds += 1;
    }

    const reserved = addPlatesRef.current(plannedBeds);

    // A model larger than a bed fits on none of them: it is set down clear of every bed,
    // the way an arrange sets down what it cannot pack, instead of on top of what does fit.
    if (pendingPlacements.length > 0) {
      const localCenterY = localMinY + view3dSettings.depthMm * 0.5;
      let columnRightX = localMinX - 8;

      for (const { entryIndex, placement } of pendingPlacements) {
        placedByEntry.set(entryIndex, {
          bedId: activePlateIdRef.current,
          slot: -1,
          x: columnRightX - placement.width * 0.5,
          y: localCenterY,
        });
        columnRightX -= placement.width + Math.max(0, spacingMm);
      }
    }

    // Every copy was planned in its bed's own frame, so its world position is that frame
    // plus where the bed finally sits — which the additions above have settled.
    const assignedCenters = entries.map((entry, index) => {
      const placement = placedByEntry.get(index);
      if (!placement) return null;

      const bedId = placement.bedId ?? reserved.added[placement.slot]?.id;
      if (!bedId) return null;

      const offset = reserved.offsets.get(bedId) ?? { dxMm: 0, dyMm: 0 };
      return { x: placement.x + offset.dxMm, y: placement.y + offset.dyMm };
    });

    /**
     * The bed each copy landed on, so the copy carries it. Its position is what decides
     * which plate it stands on, but a copy planned onto a bed is a copy that belongs to
     * it, and the stored membership is what a printer switch shifts the models by.
     */
    const assignedPlateIds = entries.map((_, index) => {
      const placement = placedByEntry.get(index);
      if (!placement) return undefined;
      return placement.bedId ?? reserved.added[placement.slot]?.id;
    });

    const createdIds: string[] = [];
    const pastedModels: LoadedModel[] = entries.map((entry, index) => {
      const id = uuidv4();
      createdIds.push(id);

      const geometry = cloneGeometryWithBounds(entry.geometry, { shared: true });

      const center = assignedCenters[index] ?? { x: centerX, y: centerY };

      return {
        id,
        name: pastedModelName(entry.name, _),
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
        ...(assignedPlateIds[index] ? { plateId: assignedPlateIds[index] } : {}),
      };
    });

    // The live list, not this render's: adding beds for the overflow shifts the models
    // standing on the beds the cascade re-laid, and the paste must not undo that.
    const nextModels = [...modelsRef.current, ...pastedModels];
    setModels(nextModels);

    if (createdIds.length > 0) {
      setActiveModelId(createdIds[0]);
      setSelectedModelIds(createdIds);

      schedulePostPaint(() => {
        beginSupportStateBatch();
        beginSupportStateBatch();
        try {
          pasteModelSupports(
            pastedModels.flatMap((pastedModel, index) => {
              const sourceEntry = entries[index];
              if (!sourceEntry?.supportClipboard) return [];
              return [{
                payload: sourceEntry.supportClipboard,
                targetModelId: pastedModel.id,
                sourceTransform: sourceEntry.transform,
                targetTransform: pastedModel.transform,
              }];
            }),
            { recordHistory: false },
          );
        } finally {
          endSupportStateBatch();
          endSupportStateBatch();
        }

        // The support state is only part of this step when a copied model brought some
        // with it: cloning it for a paste that carries none is the expensive half of
        // pasting into a scene that has supports of its own.
        const pasteCarriesSupports = entries.some((entry) => entry.supportClipboard != null);

        const before = captureSceneSnapshot(beforeModels, beforeActiveModelId, beforeSelectedModelIds, {
          includeSupportState: pasteCarriesSupports,
          ...(pasteCarriesSupports ? { supportStateOverride: supportStateBefore } : {}),
          ...(plannedBeds > 0
            ? { plates: platesBefore, activePlateId: activePlateIdRef.current }
            : {}),
        });
        const after = captureSceneSnapshot(nextModels, createdIds[0], createdIds, {
          includeSupportState: pasteCarriesSupports,
          ...(plannedBeds > 0
            ? { plates: reserved.plates, activePlateId: activePlateIdRef.current }
            : {}),
        });
        pushSceneSnapshotHistory(before, after, pasteModelsLabel(createdIds.length));
      });
    }

    return createdIds;
  }, [_, activeModelId, cloneGeometryWithBounds, defaultImportCenterXY.x, defaultImportCenterXY.y, footprintForTransform, modelClipboard, models, pushSceneSnapshotHistory, selectedModelIds, view3dSettings.depthMm, view3dSettings.originMode, view3dSettings.widthMm]);

  const duplicateModelWithTransforms = useCallback((
    sourceId: string,
    transforms: ModelTransform[],
    sourceTransform?: ModelTransform | null,
    options?: {
      /**
       * Set when the same run added the beds these copies land on — a duplicate that
       * overflowed the plate. The beds are then part of this step, so one undo takes the
       * copies back and the beds with them rather than leaving empty beds behind.
       */
      platesBefore?: { plates: ScenePlate[]; activePlateId: string };
      /** The beds as they stand after the addition. Defaults to the hook's own list. */
      platesAfter?: { plates: ScenePlate[]; activePlateId: string };
    },
  ) => {
    if (transforms.length === 0) return [] as string[];

    const source = models.find((m) => m.id === sourceId);
    if (!source) return [] as string[];
    const supportClipboard = captureModelSupportsToClipboard(sourceId);

    const platesBefore = options?.platesBefore;
    const before = captureSceneSnapshot(models, activeModelId, selectedModelIds, {
      includeSupportState: true,
      ...(platesBefore ? { plates: platesBefore.plates, activePlateId: platesBefore.activePlateId } : {}),
    });

    const resolvedGroupId = source.groupId ?? `group-${uuidv4()}`;
    const resolvedGroupName = source.groupName ?? source.name;

    const createdIds: string[] = [];
    const newModels: LoadedModel[] = transforms.map((nextTransform, index) => {
      const id = uuidv4();
      createdIds.push(id);

      const geometry = cloneGeometryWithBounds(source.geometry, { shared: true });

      return {
        id,
        name: duplicatedModelName(source.name, index + 1, _),
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
    beginSupportStateBatch();
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

      // One write for every copy: the merge and the store's own index rebuild
      // are per-write, so pasting them one at a time cost N of each.
      pasteModelSupports(
        newModels.map((model) => ({
          payload: supportClipboard as SupportClipboardPayload,
          targetModelId: model.id,
          sourceTransform: originalSourceTransform,
          targetTransform: model.transform,
        })),
        { recordHistory: false },
      );

      if (createdIds.length > 0) {
        setActiveModelId(createdIds[0]);
        setSelectedModelIds([sourceId, ...createdIds]);

        const nextSelected = [sourceId, ...createdIds];
        const after = captureSceneSnapshot(nextModels, createdIds[0], nextSelected, {
          includeSupportState: true,
          ...(platesBefore
            ? {
                plates: options?.platesAfter?.plates ?? platesRef.current,
                activePlateId: options?.platesAfter?.activePlateId ?? activePlateIdRef.current,
              }
            : {}),
        });
        pushSceneSnapshotHistory(before, after, createdIds.length === 1 ? duplicateModelLabel(source.name) : duplicateModelsLabel(createdIds.length));
      }
    } finally {
      endSupportStateBatch();
      endSupportStateBatch();
    }

    return createdIds;
  }, [_, activeModelId, cloneGeometryWithBounds, models, pushSceneSnapshotHistory, selectedModelIds]);

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
      console.warn(`[SceneCollection] Unsupported scene file: ${file.name}`);
      if (!options?.suppressReport) {
        emitSceneImportReport(reportUnsupportedSceneFile(file.name, _), 'error');
      }
      return false;
    }

    const pluginImport = scenePluginImportHandlersByExtension.get(extension.toLowerCase());
    if (!pluginImport) {
      console.warn(`[SceneCollection] No registered scene import handler for ${extension}.`);
      if (!options?.suppressReport) {
        emitSceneImportReport(reportNoSceneImportHandler(extension, _), 'error');
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
        label: importLabelFileType(pluginImport.fileType.displayName, _),
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

      // A scene whose models were hollowed before export carries the cavity as a
      // second mesh, so the model alone slices filled. Ask before baking it in:
      // the answer decides the geometry every stage below works on, so it is
      // settled here, before any of it runs.
      const hollowedPayloads = normalizedPayloads.filter(
        (p) => readPayloadCavity(p) !== null,
      );
      let bakeImportedHollowing = true;
      if (hollowedPayloads.length > 0 && !options?.suppressPlacementPrompt) {
        const choice = await requestSceneImportHollowingChoice({
          source: extension.slice(1).toUpperCase(),
          fileName: file.name,
          modelCount: normalizedPayloads.length,
          hollowedModelCount: hollowedPayloads.length,
        });
        bakeImportedHollowing = choice === 'bake';
      }

      // Process all geometries sequentially
      const processedItems: Array<{
        normalized: PluginSceneImportPayload;
        processed: GeometryWithBounds;
      }> = [];
      // Each baked model's shell as it was before the cavity joined it, read
      // back below when the modifiers are stored.
      const shellSnapshotByPayload = new Map<
        PluginSceneImportPayload,
        { sourcePositionsBase64: string; sourcePositionCount: number }
      >();
      for (const normalized of normalizedPayloads) {
        // The plugin built this geometry in the renderer, so it has not been
        // through the native loaders that refine coarse faces. Refine it here, and
        // keep the normals the command returns: it ships one per face, so there is
        // nothing left for `computeVertexNormals` to derive.
        let geometry = normalized.geometry;
        // Bake the cavity in first, so refine, classification and the BVH all
        // describe the hollow solid rather than the shell that encloses it.
        if (bakeImportedHollowing) {
          const cavity = readPayloadCavity(normalized);
          if (cavity) {
            const shellTris = (geometry.getAttribute('position')?.count ?? 0) / 3;
            // The shell before the cavity joins it is what Remove Hollowing
            // restores, and this is the last point it exists on its own.
            try {
              shellSnapshotByPayload.set(normalized, snapshotGeometryPositions(geometry));
            } catch (error) {
              console.warn('[SceneCollection] Could not snapshot the pre-hollow shell', error);
            }
            geometry = mergeCavityIntoShell(geometry, cavity);
            console.log(
              `[SceneCollection] Baked cavity into model: ${shellTris.toLocaleString()} + `
              + `${(cavity.length / 9).toLocaleString()} = `
              + `${((geometry.getAttribute('position')?.count ?? 0) / 3).toLocaleString()} triangles`,
            );
          }
        }
        let skipComputeNormals = false;
        // The mesh loaders already gate refinement on size. Plugin geometry
        // takes this path directly, so apply the same ceiling here instead of
        // sending a multi-million-triangle soup over IPC for a dense mesh.
        if (shouldRefineCoarseFaces(geometry)) {
          try {
            const refined = await refineCoarseFaces(geometry);
            if (refined) {
              geometry = refined;
              skipComputeNormals = true;
            }
          } catch (error) {
            console.warn('[refine] plugin geometry left unrefined', error);
          }
        }
        const processed = await processGeometry(geometry, {
          center: false,
          ...(skipComputeNormals ? { _skipComputeNormals: true } : {}),
          nativeProcessingMode: autoRepairScenes ? 'auto' : 'none',
          skipClassification: skipsNativePassForModelOnly(
            normalized.skipClassification === true,
            autoRepairScenes,
          ),
          onNativeProcessingStage: (stage) => {
            if (options?.suppressProgress) return;

            if (stage === 'repairing') {
              setImportProgress({
                active: true,
                type: 'scene',
                label: importLabelFileType(pluginImport.fileType.displayName, _),
                detail: normalizedPayloads.length > 1
                  ? importDetailAutoRepairingMesh(processedItems.length + 1, normalizedPayloads.length, _)
                  : importDetailAutoRepairingFile(file.name, _),
                progress: null,
              });
              return;
            }

            if (stage === 'analyzing') {
              setImportProgress({
                active: true,
                type: 'scene',
                label: importLabelFileType(pluginImport.fileType.displayName, _),
                detail: normalizedPayloads.length > 1
                  ? importDetailInspectingMesh(processedItems.length + 1, normalizedPayloads.length, _)
                  : importDetailInspectingFile(file.name, _),
                progress: null,
              });
              return;
            }

            if (stage === 'classifying') {
              setImportProgress({
                active: true,
                type: 'scene',
                label: importLabelFileType(pluginImport.fileType.displayName, _),
                detail: normalizedPayloads.length > 1
                  ? importDetailClassifyingMesh(processedItems.length + 1, normalizedPayloads.length, _)
                  : importDetailClassifyingFile(file.name, _),
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

      // Arranging waits for the supports: the raft is what stands on the plate, and
      // only the store can measure it. Models land where the file put them first.

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

        // The file's own place, which the arrange pass revises once supports exist.
        const finalPosition = originalPosition.clone();
        const finalRotation = importedTransform.rotation;

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
            rotation: finalRotation,
            scale: importedTransform.scale,
          },
          visible: true,
          color: '#a3a3a3',
          polygonCount: countTriangles(processed.geometry),
          ignoreAutoLift: true,
          meshModifiers: undefined,
          manualZMoveOverride: true,
        };

        // Store meshModifiers externally so model objects stay lightweight
        if (meshModifiers) {
          const stored = cloneMeshModifiersShallow(meshModifiers);
          const hollowing = (stored as ModelMeshModifiers).hollowing;
          if (hollowing?.enabled && hollowing.cavityPositionsBase64) {
            // `bakedIntoGeometry` is what the hollowing panel trusts when it
            // decides whether the cavity is already in the mesh, so it has to
            // follow the choice rather than the file's own claim. Declining
            // keeps the cavity for Interior View and leaves the panel able to
            // bake it later.
            // The shell snapshot rides along when the cavity was baked, so
            // Remove Hollowing has a solid to put back.
            const shellSnapshot = shellSnapshotByPayload.get(normalized);
            (stored as ModelMeshModifiers).hollowing = {
              ...hollowing,
              bakedIntoGeometry: bakeImportedHollowing,
              ...(shellSnapshot ?? {}),
            };
          }
          storeModelMeshModifiers(model.id, stored);
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

      // A rough arrangement on the raft each model stands on, now that the supports
      // are in the store. The Arrange tool is where a careful nesting is asked for.
      const arrangeImportedModels = () => {
        if (!shouldAutoArrangeOnImport || newModels.length === 0) return;

        const bedWidth = view3dSettings.widthMm;
        const bedDepth = view3dSettings.depthMm;
        const { minX: localMinX, minY: localMinY } = plateLocalRect(view3dSettings);

        /** A model's footprint at a given Z, grown to the raft standing beside it. */
        const footprintAt = (model: LoadedModel, rotationZ: number, reach: { x: number; y: number }) => {
          const mesh = computeProjectedFootprintSize(
            model.geometry,
            new THREE.Euler(
              model.transform.rotation.x,
              model.transform.rotation.y,
              rotationZ,
              model.transform.rotation.order,
            ),
            model.transform.scale,
          );
          return { width: mesh.width + reach.x, depth: mesh.depth + reach.y };
        };

        const byId = new Map(newModels.map((model) => [model.id, model]));
        const turnOf = new Map<string, number>();
        const items: ShelfItem[] = newModels.map((model) => {
          const currentZ = model.transform.rotation.z;
          const turnedZ = currentZ + (Math.PI / 2);
          turnOf.set(model.id, turnedZ);
          const bare = computeProjectedFootprintSize(
            model.geometry, model.transform.rotation, model.transform.scale,
          );
          // Only what stands on the plate: the raft around the model's roots.
          const raft = estimateRaftBoundsForModel(model.id);
          const reach = raft
            ? {
              x: Math.max(0, (raft.maxX - raft.minX) - bare.width),
              y: Math.max(0, (raft.maxY - raft.minY) - bare.depth),
            }
            : { x: 0, y: 0 };
          const asIs = footprintAt(model, currentZ, reach);
          // The raft turns with the model, so its reach swaps axes with it.
          const turned = footprintAt(model, turnedZ, { x: reach.y, y: reach.x });
          return {
            id: model.id,
            width: asIs.width,
            depth: asIs.depth,
            turnedWidth: turned.width,
            turnedDepth: turned.depth,
          };
        });

        // Planned in each bed's own millimetres, then resolved: dynamic ordering
        // re-lays the grid as beds are added, so an offset read early goes stale.
        type PlannedSeat = { id: string; x: number; y: number; rotationZ: number };
        const plateLocalSeats: PlannedSeat[][] = [];

        const planSeats = (placements: ReturnType<typeof shelfPack>['placed']): PlannedSeat[] => (
          placements.flatMap((placement) => {
            const model = byId.get(placement.id);
            if (!model) return [];
            return [{
              id: placement.id,
              x: placement.x,
              y: placement.y,
              rotationZ: placement.turned
                ? turnOf.get(placement.id) ?? model.transform.rotation.z
                : model.transform.rotation.z,
            }];
          })
        );

        const packBed = (pending: ShelfItem[]) => shelfPack(pending, {
          widthMm: bedWidth,
          depthMm: bedDepth,
          spacingMm: IMPORT_ARRANGE_SPACING_MM,
        });

        let pending = items;
        const existingPlateIds = platesRef.current.map((plate) => plate.id);

        // The beds the scene already has, in order.
        for (let i = 0; i < existingPlateIds.length; i += 1) {
          if (pending.length === 0) break;
          const result = packBed(pending);
          plateLocalSeats[i] = planSeats(result.placed);
          const spilled = new Set(result.spilled);
          pending = pending.filter((entry) => spilled.has(entry.id));
        }

        // Then a bed for each spill, still only planned.
        const newBedSeats: PlannedSeat[][] = [];
        let guard = 0;
        while (pending.length > 0 && guard < MAX_IMPORT_PLATES) {
          guard += 1;
          const result = packBed(pending);

          if (result.placed.length === 0) {
            // Too large for an empty bed in either pose: it takes one on its own,
            // overhanging, rather than being left adrift off every plate.
            const stranded = pending[0];
            const model = byId.get(stranded.id);
            newBedSeats.push([{
              id: stranded.id,
              x: bedWidth * 0.5,
              y: bedDepth * 0.5,
              rotationZ: model?.transform.rotation.z ?? 0,
            }]);
            pending = pending.slice(1);
            continue;
          }

          newBedSeats.push(planSeats(result.placed));
          const spilled = new Set(result.spilled);
          pending = pending.filter((entry) => spilled.has(entry.id));
        }

        // Every bed at once, so the grid settles before any offset is read.
        const reserved = newBedSeats.length > 0
          ? addPlatesRef.current(newBedSeats.length)
          : null;

        const seats = new Map<string, { x: number; y: number; rotationZ: number }>();
        const placeOnBed = (plateId: string, planned: PlannedSeat[] | undefined) => {
          if (!planned || planned.length === 0) return;
          const { dxMm, dyMm } = reserved
            ? reserved.offsets.get(plateId) ?? plateOffsetForRef.current(plateId)
            : plateOffsetForRef.current(plateId);
          for (const seat of planned) {
            seats.set(seat.id, {
              x: localMinX + dxMm + seat.x,
              y: localMinY + dyMm + seat.y,
              rotationZ: seat.rotationZ,
            });
          }
        };

        existingPlateIds.forEach((plateId, index) => placeOnBed(plateId, plateLocalSeats[index]));
        newBedSeats.forEach((planned, index) => {
          const plate = reserved?.added[index];
          if (plate) placeOnBed(plate.id, planned);
        });

        const moved = newModels.filter((model) => {
          const seat = seats.get(model.id);
          if (!seat) return false;
          return Math.abs(seat.x - model.transform.position.x) > 1e-6
            || Math.abs(seat.y - model.transform.position.y) > 1e-6
            || Math.abs(seat.rotationZ - model.transform.rotation.z) > 1e-6;
        });
        if (moved.length === 0) return;

        const afterById = new Map(moved.map((model) => {
          const seat = seats.get(model.id)!;
          return [model.id, {
            position: new THREE.Vector3(seat.x, seat.y, model.transform.position.z),
            rotation: new THREE.Euler(
              model.transform.rotation.x,
              model.transform.rotation.y,
              seat.rotationZ,
              model.transform.rotation.order,
            ),
            scale: model.transform.scale.clone(),
          }];
        }));

        setModels((prev) => prev.map((model) => {
          const after = afterById.get(model.id);
          return after ? { ...model, transform: after } : model;
        }));

        // The supports follow their model, in one notify for the whole run.
        beginSupportStateBatch();
        try {
          for (const model of moved) {
            const after = afterById.get(model.id);
            if (!after) continue;
            const before = {
              position: model.transform.position.clone(),
              rotation: model.transform.rotation.clone(),
              scale: model.transform.scale.clone(),
            };
            // The model object is the one `newModels` holds, so later reads see the move.
            model.transform = after;
            transformSupportsForModel(model.id, before, after);
          }
        } finally {
          endSupportStateBatch();
        }
      };

      // Load supports for all models in a single animation frame batch
      const pendingSupports = supportEntries.filter((e) => !!e.supportData);
      if (pendingSupports.length > 0) {
        const applySupports = () => {
          beginSupportStateBatch();
          try {
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
          } finally {
            endSupportStateBatch();
          }
          arrangeImportedModels();
        };
        if (typeof window !== 'undefined') {
          requestAnimationFrame(applySupports);
        } else {
          applySupports();
        }
      } else {
        arrangeImportedModels();
      }

      const totalSupportCount = supportEntries.reduce(
        (sum, e) => sum + countSupportEntries(e.supportData ?? null),
        0,
      );
      if (!options?.suppressReport) {
        emitSceneImportReport(
          reportImportedScene(extension.slice(1).toUpperCase(), newModels.length, totalSupportCount, 0, _),
          'success',
        );
      }

      console.log(`[SceneCollection] ${extension} import successful: ${newModels.map((m) => m.name).join(', ')}`);
      return true;
    } catch (err) {
      console.error('[SceneCollection] Failed to process plugin scene geometry:', err);
      const msg = err instanceof Error ? err.message : String(err);
      if (!options?.suppressReport) {
        emitSceneImportReport(reportSceneImportFailed(msg, _), 'error');
      }
      if (!options?.suppressReport && typeof window !== 'undefined') {
        window.alert(alertSceneImportFailed(msg, _));
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
  }, [_, emitSceneImportReport, findFreeSpotCentersForModels, getSceneExtension, isModelFootprintInsidePlate, processGeometry, requestSceneImportHollowingChoice, requestSceneImportPlacementChoice, scenePluginImportHandlersByExtension, setActiveModelId, setModels, setSelectedModelIds, shouldAutoRepairSceneImports, trackRecentOpenedFiles, waitForUiYield]);

  const handleImportVoxlFile = useCallback(async (file: File, options?: SceneImportRunOptions): Promise<boolean> => {
    if (!options?.suppressRecentTracking) {
      trackRecentOpenedFiles([file], 'scene', { sourcePaths: [options?.sourcePath] });
    }

    if (!options?.suppressProgress) {
      setImportProgress({
        active: true,
        type: 'scene',
        label: importLabelVoxlScene(_),
        detail: file.name,
        progress: null,
      });
    }

    await waitForUiYield();

    try {
      const autoRepairScenes = shouldAutoRepairSceneImports(options);
      // Peek at the first 6 bytes to detect the container. The binary container
      // starts with "VOXL" magic (0x56 0x4F 0x58 0x4C) + uint16 version >= 2;
      // anything else is either an obsolete V1 scene or not a VOXL file at all.
      const headerBytes = new Uint8Array(await file.slice(0, 6).arrayBuffer());
      const isV2 = isVoxlBinaryV2(headerBytes);

      if (!isV2) {
        const obsolete = detectObsoleteVoxlVersion(headerBytes);
        if (obsolete) {
          throw new VoxlObsoleteVersionError(obsolete);
        }
        throw new Error('Not a VOXL file: the VOXL binary header is missing.');
      }

      const importStarted = performance.now();
      let committedAt = 0;
      // The file's own path, when it has one: that is what lets the native loader
      // read a mesh chunk by range instead of receiving its bytes. Same expression
      // the sidecar resolution below uses.
      const voxlPath = (file as File & { path?: string; filePath?: string }).path
        || (file as File & { filePath?: string }).filePath
        || options?.sourcePath
        || undefined;
      // With a path, the 13 mesh chunks (677 MB, ~2 s of inflate before any model
      // work starts) stay where they are and the loader inflates each one itself.
      // Without one — a zip entry, a synthesized file — nothing changes.
      const parsed = await parseVoxlBinaryV2(new Uint8Array(await file.arrayBuffer()), {
        deferMeshChunks: Boolean(voxlPath),
      });
      const parsedAt = performance.now();
      const document: VoxlDocumentV1 = parsed.document;
      const resolvedMeshBytes: Map<string, Uint8Array> = parsed.meshBytes;
      const resolvedOriginalMeshBytes = parsed.originalMeshBytes;
      const originalMeshChunks = parsed.originalMeshChunks;
      // sourceVersion is 3.1 only when the file actually carries modifier
      // chunks; anything lower is treated as inline for format preservation.
      lastLoadedVoxlFormatChunkedRef.current = parsed.sourceVersion >= 3.1;

      // The file's plates, read once: the models below are stamped with the
      // plate they stand on, and the scene adopts the list after they land.
      const scenePlates = readScenePlates(document.scene);
      const importedPlateIds = new Set(scenePlates.plates.map((plate) => plate.id));
      const importedDefaultPlateId = scenePlates.plates[0]?.id;
      /** A model's plate, when the file names one of its own; otherwise its first. */
      const plateIdForImport = (raw?: string): string | undefined =>
        raw && importedPlateIds.has(raw) ? raw : importedDefaultPlateId;

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

      // Build every unique mesh, a couple at a time, before the placement loop.
      // Placement stays in order below because it depends on what is already on the
      // plate; building does not. Each build is a native round trip with serial
      // phases (parse, refine, classify) around a parallel one, so two in flight let
      // one model's serial phase run during another's. The hash is computed here once
      // per model and reused by the loop, so neither the content hash nor the
      // integrity check is paid twice.
      //
      // The `classification` a `MODL` entry carries is **not** used. It is a boundary
      // into the soup the file stores, and a file written before the mesh chunk's
      // signature could see a reordered soup pairs it with a different order: the
      // boundary then cuts a slab out of the model and paints it as support. A count
      // check cannot tell those apart, so the loader classifies the payload it just
      // built and the sections come from that answer. Cost: one classify per model on
      // load — the same pass a fresh STL import pays, done natively inside the loader
      // rather than as a second round trip.
      const buildOptionsFor = (model: (typeof document.models)[number]): ProcessGeometryOptions => ({
        nativeProcessingMode: autoRepairScenes ? 'auto' : 'none',
        assumeSupportGeometry: model.isSupportGeometry,
        skipClassification: model.isSupportGeometry,
        // The payload is the scene's own mesh: refining it again changes the count and
        // order every boundary indexes, and grows it on each round trip.
        _refine: false,
      });
      const hashByModelId = new Map<string, string>();
      const uniqueBuilds = new Map<
        string,
        {
          bytes?: Uint8Array;
          range?: VoxlMeshRange;
          name: string;
          model: (typeof document.models)[number];
        }
      >();
      const meshRanges = parsed.meshRanges;
      for (const [index, model] of document.models.entries()) {
        const meshRef = model.mesh;
        const bytes = resolvedMeshBytes.get(model.id);
        const range = meshRanges?.get(model.id);
        if (!meshRef || meshRef.mode !== 'embedded-chunk' || (!bytes && !range)) continue;
        const declaredSha = typeof meshRef.sha256 === 'string' && meshRef.sha256.trim().length > 0
          ? meshRef.sha256.trim().toLowerCase()
          : undefined;
        // A deferred chunk has no bytes to hash. Its identity inside the file is its
        // chunk anyway — a V3 duplicate points at the owner's chunk — so the chunk
        // index is the dedup key, and it is stable for the whole parse.
        const contentHash = declaredSha
          ?? (range
            ? `chunk:${typeof meshRef.chunkIndex === 'number' ? meshRef.chunkIndex : index}`
            : await sha256Hex(bytes!));
        hashByModelId.set(model.id, contentHash);
        if (builtGeometryByHash.has(contentHash) || uniqueBuilds.has(contentHash)) continue;
        uniqueBuilds.set(contentHash, {
          ...(bytes ? { bytes } : { range: range! }),
          name: meshRef.fileName?.trim() || `${model.name || 'model'}.stl`,
          model,
        });
      }
      if (uniqueBuilds.size > 0) {
        let finished = 0;
        const buildCount = uniqueBuilds.size;
        // Every mesh's occlusion bake is left in flight rather than awaited per
        // model: it is the GPU's work (0.4-1.2 s a model on the scene this was
        // measured against) while the remaining meshes are still being parsed,
        // refined and classified, and running them one model at a time left the
        // GPU idle for most of the load. They are all awaited below, before any
        // model is placed, so each one's first frame still carries its occlusion
        // — the pop-in that baking after the fact produced.
        const pendingOcclusionBakes: Array<Promise<boolean>> = [];
        await runWithConcurrency([...uniqueBuilds], VOXL_BUILD_CONCURRENCY, async ([hash, spec]) => {
          try {
            const options = {
              ...buildOptionsFor(spec.model),
              _deferOcclusionBake: (bake: Promise<boolean>) => pendingOcclusionBakes.push(bake),
            };
            const built = spec.range && voxlPath
              ? await loadMeshGeometryFromRange(voxlPath, spec.range, spec.name, options)
              : await loadMeshGeometry(spec.bytes!, spec.name, options);
            builtGeometryByHash.set(hash, built);
          } catch (error) {
            // The loop below reports the model as skipped; one mesh that will not
            // build is not worth failing the whole scene over.
            console.error(`[SceneCollection] Failed building VOXL mesh "${spec.model.name}"`, error);
          }
          finished += 1;
          setImportProgress({
            active: true,
            type: 'scene',
            label: importLabelVoxlScene(_),
            detail: importDetailVoxlModel(finished, buildCount, spec.model.name, _),
            progress: null,
          });
        });
        await Promise.all(pendingOcclusionBakes);
      }
      const builtAt = performance.now();

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
          label: importLabelVoxlScene(_),
          detail: importDetailVoxlModel(i + 1, document.models.length, model.name, _),
          progress: null,
        });

        if (meshRef.mode !== 'embedded-chunk') {
          console.warn(`[SceneCollection] Skipping VOXL model "${model.name}": mesh mode \"${meshRef.mode}\" is not importable without embedded mesh data.`);
          skippedModels += 1;
          continue;
        }

        // Mesh bytes arrive pre-decoded from the container's MESH chunks — unless
        // the parse deferred them, in which case the location is what arrives and
        // the native loader reads it.
        const meshDataBytes = resolvedMeshBytes.get(model.id);
        const meshRange = meshRanges?.get(model.id);
        if (!meshDataBytes && !(meshRange && voxlPath)) {
          console.warn(`[SceneCollection] Skipping VOXL model "${model.name}": missing embedded mesh payload.`);
          skippedModels += 1;
          continue;
        }

        try {
          const bytes = meshDataBytes;

          // Dedup key: the file's own SHA when present, else the content hash
          // (also the integrity value). Compute once; reused as the cache key.
          const declaredSha =
            typeof meshRef.sha256 === 'string' && meshRef.sha256.trim().length > 0
              ? meshRef.sha256.trim().toLowerCase()
              : undefined;
          // Computed by the build pass above; the fallback covers a model it skipped.
          const contentHash = hashByModelId.get(model.id)
            ?? declaredSha
            ?? (bytes ? await sha256Hex(bytes) : `chunk:${typeof meshRef.chunkIndex === 'number' ? meshRef.chunkIndex : i}`);

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
            // A deferred chunk has no bytes here to hash: its integrity is the
            // container's own (the directory ranges are bounds-checked as the file
            // is parsed) and the loader refuses a short read. The byte-source path
            // below verifies the declared SHA as before.
            if (declaredSha && bytes) {
              const actual = await sha256Hex(bytes);
              if (actual !== declaredSha) {
                throw new Error('VOXL integrity check failed (SHA-256 mismatch).');
              }
            }
            // The build pass above builds every unique mesh; reaching here means that
            // build failed, and it already logged why.
            throw new Error(`VOXL mesh for "${model.name}" did not build.`);
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

          const polygonCount = countTriangles(geometry.geometry);
          const color = clampHexColor(model.color, DEFAULT_MESH_COLOR);
          const importedPlateId = plateIdForImport(model.plateId);

          importedModels.push({
            id: resolvedId,
            name: sanitizeImportedModelDisplayName(model.name),
            fileUrl: '',
            ...(importedPlateId ? { plateId: importedPlateId } : {}),
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

      const placedAt = performance.now();

      const sourceTransformsByModelId = new Map<string, ModelTransform>();
      for (const imported of importedModels) {
        sourceTransformsByModelId.set(imported.id, cloneTransform(imported.transform));
      }

      // The file's models stand where its own printer's beds were laid out, and the cascade
      // spaces beds by the build volume: on any other printer every bed but the first is
      // somewhere else, so the models have to make the same move. A model centred on plate 2
      // stays centred on plate 2. The file's supports follow their models, because the shift
      // is the delta against the transforms captured above.
      const recordedLayoutMm = document.meta?.printer?.printer.buildVolumeMm;
      if (recordedLayoutMm && scenePlates.plates.length > 1) {
        const filePlates = scenePlates.plates.map((plate) => ({ id: plate.id, name: plate.name ?? '' }));
        const shifted = modelsShiftedForRelaidPlates(filePlates, filePlates, importedModels, {
          laidOut: {
            widthMm: recordedLayoutMm.width,
            depthMm: recordedLayoutMm.depth,
            originMode: view3dSettings.originMode,
          },
          // The grid the file's beds were laid out on, which is what its model positions
          // are measured against. A file that does not say was written under the dynamic
          // grid, the only one there was. Without this, opening a scene in the other
          // ordering would leave every model standing where its bed no longer is.
          wasOrdering: readPlateOrdering(document.extensions?.[VOXL_PLATE_ORDERING_EXTENSION])
            ?? DYNAMIC_PLATE_ORDERING,
        });
        if (shifted !== importedModels) importedModels.splice(0, importedModels.length, ...shifted);
      }

      // "Off-plate" means standing on none of the file's beds, not off the bed being worked
      // on: reading the active one alone called every model on any other bed out of bounds,
      // which in a multi-plate scene is the whole point of the file. A file that names no
      // plates of its own leaves the beds already here in place, so those are the ones.
      const { minX: localBedMinX, minY: localBedMinY } = plateLocalRect(view3dSettings);
      const bedRectAt = (index: number, count: number): Rect2D => {
        const { dxMm, dyMm } = plateCascadeOffsetMm(index, {
          widthMm: view3dSettings.widthMm,
          depthMm: view3dSettings.depthMm,
        }, count, plateOrderingRef.current);
        return {
          minX: localBedMinX + dxMm,
          maxX: localBedMinX + dxMm + view3dSettings.widthMm,
          minY: localBedMinY + dyMm,
          maxY: localBedMinY + dyMm + view3dSettings.depthMm,
        };
      };
      const importedBedRects: Rect2D[] = scenePlates.plates.map((plate, index) => (
        bedRectAt(index, scenePlates.plates.length)
      ));
      const bedRectsForImport = importedBedRects.length > 0
        ? importedBedRects
        : platesRef.current.map((plate, index, all) => bedRectAt(index, all.length));
      const offPlateImportedModels = importedModels.filter(
        (model) => !rectStandsOnAnyBed(modelFootprintRect(model), bedRectsForImport),
      );
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

        // A cached or older scene can carry a model whose size was never recorded —
        // the writer used to store 0 for unknown, which reads back as "0 B". The
        // document keeps the model's original path when it has one, so the size is
        // one metadata call away. Desktop only: `readNativeFileSize` answers null
        // elsewhere, which leaves the size unknown rather than wrong.
        await Promise.all(importedModels.map(async (model) => {
          if (typeof model.fileSizeBytes === 'number' && model.fileSizeBytes > 0) return;
          const sourcePath = typeof model.sourcePath === 'string' ? model.sourcePath.trim() : '';
          if (!sourcePath) return;
          const size = await readNativeFileSize(sourcePath);
          if (size != null && size > 0) model.fileSizeBytes = size;
        }));

        setModels((prev) => [...prev, ...importedModels]);
        committedAt = performance.now();

        // Everything this file brought in is selected, so a freshly opened scene acts
        // on all of it at once. The file's own selection is deliberately not restored:
        // a saved scene carries one model's worth in most files, and honouring it left
        // an import acting on a single model and looking like the rest were not there.
        // The active model still follows the file, because that is the one the panels
        // read, and falls back to the first imported model when the file names none.
        const mappedActiveId = (document.scene.activeModelId && idMap.get(document.scene.activeModelId))
          || importedModels[0]?.id
          || null;

        setActiveModelId(mappedActiveId);
        setSelectedModelIds(importedModels.map((model) => model.id));

        // The scene's plates: `plates` is canonical, the older `plateName` is the
        // single-plate shorthand a file written before plates carries. A file with
        // no plate list at all leaves this scene's plates as they were, since this
        // path merges into the scene rather than replacing it.
        if (scenePlates.plates.length > 0) {
          setPlates(scenePlates.plates.map((plate) => ({ id: plate.id, name: plate.name ?? '' })));
          setActivePlateId(scenePlates.activePlateId ?? scenePlates.plates[0].id);
        } else if (scenePlates.legacyName) {
          const legacyName = scenePlates.legacyName;
          setPlates((prev) => prev.map((plate, index) => (index === 0 ? { ...plate, name: legacyName } : plate)));
        }

        // A scene built for another printer should not be dropped into this one without
        // a word: its beds were spaced for the machine it names, and when that machine is
        // the bigger the plates do not fit here at all. Read the store fresh rather than
        // the memo, because this callback can run long after it was created.
        const recordedPrinter = document.meta?.printer;
        const recordedVolume = recordedPrinter?.printer.buildVolumeMm;
        const currentPrinter = getActivePrinterProfile(getProfileStoreSnapshot());
        if (recordedPrinter && recordedVolume && currentPrinter) {
          const installed = findPrinterProfileForBundle(recordedPrinter, getProfileStoreSnapshot());
          // Resolving to the profile selected now means the scene is already on its printer.
          if (installed?.id !== currentPrinter.id) {
            const recordedName = typeof recordedPrinter.printer.name === 'string' && recordedPrinter.printer.name.trim().length > 0
              ? recordedPrinter.printer.name
              : undefined;
            setPrinterMismatch({
              bundle: recordedPrinter,
              ...(recordedName ? { recordedName } : {}),
              recordedBuildVolumeMm: { ...recordedVolume },
              currentName: currentPrinter.name,
              currentBuildVolumeMm: { ...currentPrinter.buildVolumeMm },
              installedProfileId: installed?.id ?? null,
              currentIsSmaller: buildVolumeIsSmaller(currentPrinter, recordedPrinter),
            });
          }
        }
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

      // Where a scene load went, in the app's own log next to the native timings:
      // parse, the per-model build pass (native load + prep, with the bakes in
      // flight), in-order placement, and the commit that hands the models to
      // React. The frame that follows the commit — every geometry's upload and
      // BVH reaching the GPU — is *after* this line, which is why the total here
      // is not the user's wait.
      const phaseTiming =
        `[voxl] load: parse ${(parsedAt - importStarted).toFixed(0)}ms, ` +
        `build ${(builtAt - parsedAt).toFixed(0)}ms, ` +
        `place ${(placedAt - builtAt).toFixed(0)}ms, ` +
        `commit ${(committedAt - placedAt).toFixed(0)}ms, ` +
        `total ${(committedAt - importStarted).toFixed(0)}ms`;
      console.log(phaseTiming);
      void logToNativeFile('info', phaseTiming);

      if (importedModelCount > 0) {
        if (!options?.suppressReport) {
          emitSceneImportReport(
            reportImportedScene('VOXL', importedModelCount, importedSupportCount, skippedModels, _),
            skippedModels > 0 ? 'warning' : 'success',
          );
        }
      }

      if (importedModels.length === 0) {
        console.warn('[SceneCollection] VOXL import completed without importable meshes (expected embedded-chunk meshes).');
        if (!options?.suppressReport) {
          emitSceneImportReport(reportVoxlNoMeshes(_), 'warning');
        }
        return false;
      }
      return true;
    } catch (error) {
      console.error('[SceneCollection] VOXL import failed:', error);
      if (error instanceof VoxlObsoleteVersionError) {
        // A V1 scene is refused outright: no shipped DragonFruit ever wrote one
        // (the first release already wrote the binary container), so this is
        // explained rather than reported as a parse failure.
        setObsoleteVoxlScene({ fileName: file.name, detected: error.detected });
        if (!options?.suppressReport) {
          emitSceneImportReport(reportVoxlUnsupportedVersion(file.name, _), 'warning');
        }
        return false;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (!options?.suppressReport) {
        emitSceneImportReport(reportVoxlImportFailed(message, _), 'error');
      }
      if (!options?.suppressReport && typeof window !== 'undefined') {
        window.alert(alertSceneImportFailed(message, _));
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
  }, [_, cloneGeometryWithBounds, emitSceneImportReport, findFreeSpotCentersForModels, isModelFootprintInsidePlate, requestSceneImportPlacementChoice, shouldAutoRepairSceneImports, trackRecentOpenedFiles, waitForUiYield]);

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
      label: importLabelScenes(_),
      detail: importDetailPreparing(0, files.length, _),
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
        label: importLabelScenes(_),
        detail: importDetailIndexedFile(i + 1, files.length, file.name, _),
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
      emitSceneImportReport(reportSceneFilesImported(successCount, _), 'success');
    } else if (successCount > 0) {
      emitSceneImportReport(reportSceneFilesPartlyImported(successCount, files.length, failureCount, _), 'warning');
    } else {
      emitSceneImportReport(reportSceneFilesAllFailed(files.length, _), 'error');
    }
    return successCount > 0;
  }, [_, emitSceneImportReport, getSceneExtension, importSceneFile, trackRecentOpenedFiles, waitForUiYield]);

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
    //
    // Only an STL goes without its bytes, as from the native picker: an OBJ or 3MF
    // the native loader cannot read falls back to the renderer's loaders, which
    // parse the File itself. Given an empty one, the 3MF unzip worker failed
    // without answering and the import hung.
    if (entry.kind === 'mesh' && entry.sourcePath) {
      const core = entry.name.toLowerCase().endsWith('.stl') ? null : await loadTauriCore();
      const bytes = core
        ? await core.invoke<ArrayBuffer>('read_print_file_bytes', { sourcePath: entry.sourcePath })
        : null;
      const pathFile = new File(bytes ? [new Uint8Array(bytes)] : [], entry.name, {
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

    // A mesh entry recorded before the on-disk path was tracked carries no
    // sourcePath, so it can only be restored from the cached blob and the native
    // loader is skipped. Re-importing the file records the path and heals it.
    if (entry.kind === 'mesh' && !entry.sourcePath) {
      console.warn(
        '[SceneCollection] Recent mesh entry has no on-disk path; restoring from cache. ' +
        'Re-import the file to enable the native loader for it.',
      );
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
        emitSceneImportReport(reportSupportJsonUnsupported(_), 'error');
        return;
      }

      applyImportDefaultsToRaftState();
      loadFromImportFormat(parsed);
      emitSceneImportReport(reportSupportJsonImported(_), 'success');

    } catch (err) {
      console.error('[SceneCollection] Failed to import support JSON:', err);
      emitSceneImportReport(reportSupportJsonFailed(_), 'error');
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

    const currentModels = modelsRef.current;
    const target = currentModels.find((model) => model.id === activeModelId);
    if (!target || target.color === normalizedColor) return;

    paintModelBaseColor(target, normalizedColor);
    const nextModels = currentModels.map((model) => (
      model.id === target.id ? { ...model, color: normalizedColor } : model
    ));
    const before = captureSceneSnapshot(currentModels, activeModelIdRef.current, selectedModelIdsRef.current);
    setModels(nextModels);
    const after = captureSceneSnapshot(nextModels, activeModelIdRef.current, selectedModelIdsRef.current);
    pushSceneSnapshotHistory(before, after, colorModelLabel(target.name));
  }, [activeModelId, pushSceneSnapshotHistory]);

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
      isSupport ? MARK_AS_SUPPORT_LABEL : MARK_AS_MODEL_LABEL,
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
    pushSceneSnapshotHistory(before, after, linkModelsLabel(targetModels.length));
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
    pushSceneSnapshotHistory(before, after, unlinkModelsLabel(targetModels.length));
  }, [pushSceneSnapshotHistory]);

  /**
   * Put a model back to how it arrived, by loading its file again.
   *
   * A repair leaves no copy of what it replaced, so undo re-reads the source and lets the import
   * path do what it did the first time. The file goes through Rust: the webview refuses a `file://`
   * fetch. Only the geometry is swapped, so the model keeps its transform and does not move.
   */
  const undoRepairsInPlace = useCallback(async (modelId: string) => {
    const model = models.find((entry) => entry.id === modelId);
    const sourcePath = model?.sourcePath?.trim();
    if (!model || !sourcePath) {
      emitSceneImportReport(_(msg`No source file to restore this model from.`), 'warning');
      return false;
    }
    try {
      const positions = await loadMeshFromPath(sourcePath);
      if (!positions || positions.length === 0) {
        throw new Error('the file produced no geometry');
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const reloaded = await processGeometry(geometry, {
        center: false,
        nativeProcessingMode: shouldAutoRepairSceneImports() ? 'auto' : 'none',
      });
      const posAttr = reloaded.geometry.getAttribute('position') as THREE.BufferAttribute | null;
      const polygonCount = posAttr ? Math.floor(posAttr.count / 3) : model.polygonCount;
      setModels(prev => prev.map(entry =>
        entry.id === modelId ? { ...entry, geometry: reloaded, polygonCount } : entry
      ));
      // The repair is gone, so the menu must stop offering it and the report it left.
      setManuallyRepairedModelIds(prev => prev.filter((id) => id !== modelId));
      setMeshRepairReports([]);
      setPendingMeshRepairReports([]);
      emitSceneImportReport(reportRestoredModel(model.name, _), 'success');
      return true;
    } catch (error) {
      console.error('[undoRepairsInPlace] Reload failed:', error);
      emitSceneImportReport(_(msg`Could not restore the model.`), 'error');
      return false;
    }
  }, [_, emitSceneImportReport, models, shouldAutoRepairSceneImports]);

  /**
   * Re-runs the full native repair pipeline on each model in turn and swaps every result in as
   * one undo step. Intended for the manual "Repair Mesh" action, on one model or a selection.
   * The reports of every model that had one are shown together; a model that fails is reported
   * and the rest still run. A cancel stops the run on the model it lands on: the models already
   * finished keep their repair, the one in progress is left alone. Resolves true when every
   * model was repaired.
   */
  const repairModelsInPlace = useCallback(async (
    modelIds: readonly string[],
    repairProgressSink?: ModelsRepairProgressSink,
  ): Promise<boolean> => {
    const repaired = new Map<string, { geometry: GeometryWithBounds; polygonCount: number }>();
    const reportEntries: MeshRepairReportEntry[] = [];
    const repairedNames: string[] = [];
    let allRepaired = true;
    let cancelled = false;

    for (const [index, modelId] of modelIds.entries()) {
      const model = modelsRef.current.find(m => m.id === modelId);
      if (!model) {
        allRepaired = false;
        continue;
      }
      repairProgressSink?.onModelStart?.(modelId, index, modelIds.length);
      try {
        const processed = await processGeometry(model.geometry.geometry, {
          center: false,
          nativeProcessingMode: 'repair',
          assumeSupportGeometry: model.isSupportGeometry,
          repairProgressSink,
          // The file it came from, so the repair reads it through the same loader the
          // import did instead of uploading a triangle soup and re-deriving every vertex.
          sourcePath: model.sourcePath ?? undefined,
        });

        // A cancelled repair stopped where it was asked to, and the mesh it hands back
        // is a partly repaired one. Applying it would replace the model with something
        // the caller did not ask for, so the model is left alone and the run ends here.
        if (processed.meshDefects?.nativeRepairReport?.cancelled) {
          cancelled = true;
          allRepaired = false;
          break;
        }

        const polygonCount = processed.geometry.getAttribute('position')
          ? countTriangles(processed.geometry)
          : model.polygonCount;
        const repairReport = processed.meshDefects?.nativeRepairReport ?? null;

        repaired.set(modelId, { geometry: processed, polygonCount });
        repairedNames.push(model.name);
        if (repairReport) {
          reportEntries.push({ id: modelId, modelName: model.name, report: repairReport });
        }
      } catch (err) {
        console.error('[repairModelsInPlace] Repair failed:', err);
        allRepaired = false;
        const message = err instanceof Error ? err.message : String(err);
        emitSceneImportReport(
          modelIds.length === 1
            ? repairFailedMessage(message, _)
            : repairFailedForModelMessage(model.name, message, _),
          'error',
          { durationMs: 6_000 },
        );
      }
    }

    setPendingMeshRepairReports([]);
    if (repaired.size === 0) {
      if (cancelled) {
        emitSceneImportReport(
          repairCancelledMessage(modelIds.length, _),
          'warning',
        );
      }
      return false;
    }

    // The repairs awaited, so the scene they land in is the current one, not the one they started from.
    const currentModels = modelsRef.current;
    const nextModels = currentModels.map(m => {
      const result = repaired.get(m.id);
      return result ? { ...m, geometry: result.geometry, polygonCount: result.polygonCount } : m;
    });
    const before = captureSceneSnapshot(currentModels, activeModelIdRef.current, selectedModelIdsRef.current);
    setModels(nextModels);
    const after = captureSceneSnapshot(nextModels, activeModelIdRef.current, selectedModelIdsRef.current);
    const [onlyRepairedId] = repaired.keys();
    pushSceneSnapshotHistory(
      before,
      after,
      repaired.size === 1 ? repairModelLabel(repairedNames[0]) : repairModelsLabel(repaired.size),
      repaired.size === 1 ? onlyRepairedId : undefined,
    );
    setManuallyRepairedModelIds(prev => [...prev, ...[...repaired.keys()].filter(id => !prev.includes(id))]);

    if (reportEntries.length > 0) {
      clearSceneImportReport();
      setMeshRepairReportPresentation('optimistic');
      setMeshRepairReports(reportEntries);
    }
    if (cancelled) {
      emitSceneImportReport(repairStoppedMessage(repaired.size, modelIds.length, _), 'warning');
    } else if (reportEntries.length === 0 && allRepaired) {
      emitSceneImportReport(repairedModelsMessage(repairedNames, _), 'success');
    }

    return allRepaired;
  }, [_, clearSceneImportReport, emitSceneImportReport, pushSceneSnapshotHistory]);

  /**
   * Rebuild one model's surface with the native tetrahedral surfacing pass and swap the result in
   * as a single undo step.
   *
   * Unlike the shrinkwrap remesh, the decomposition follows the model's own points rather than a
   * uniform lattice, so fine detail survives and the boundary is closed by construction. The swap
   * lands in place, keeping the model's transform and its place in the scene. The outcome, with the
   * before/after triangle counts, is reported as a toast.
   */
  const tetSurfaceModelInPlace = useCallback(async (
    modelId: string,
    options: TetWrapOptions,
    progressSink?: TetSurfaceProgressSink,
  ): Promise<boolean> => {
    const model = modelsRef.current.find((entry) => entry.id === modelId);
    if (!model) return false;

    try {
      const result = await tetSurfaceFromGeometry(model.geometry.geometry, options, progressSink);
      if (!result) {
        emitSceneImportReport(_(msg`Remesh needs the desktop app.`), 'warning');
        return false;
      }
      // The pass awaited, so the scene it lands in may no longer hold the model.
      if (!modelsRef.current.some((entry) => entry.id === modelId)) return false;

      // The pass carries no mesh modifiers, so an empty before-state is what marks this as a
      // single undo step: the swap is recorded only when a history option is given.
      const swapped = replaceModelGeometry(modelId, result.geometry, tetSurfaceModelLabel(model.name), {
        historyBefore: {},
      });
      if (!swapped) return false;

      const { report } = result;
      emitSceneImportReport(
        tetSurfacedMessage(
          fmt.number(report.input_triangles),
          fmt.number(report.output_triangles),
          fmt.quantity(Math.round(report.ms), 0, 'ms'),
          _,
        ),
        'success',
      );
      return true;
    } catch (error) {
      console.error('[tetSurfaceModelInPlace] Remesh failed:', error);
      const message = error instanceof Error ? error.message : String(error);
      emitSceneImportReport(_(msg`Remesh failed: ${message}`), 'error', { durationMs: 6_000 });
      return false;
    }
  }, [_, emitSceneImportReport, fmt, replaceModelGeometry]);

  /**
   * Rebuild one model's surface by resolving it into a solid and swap the result in as a single
   * undo step.
   *
   * This is the mode the reference implementation's shrinkwrap uses: close what is open, boolean the
   * mesh with itself so the result is resolved and retriangulated, then drop scrap shells. Where the
   * tetrahedral remesh conforms to the model's own points and hands the same surface back, this one
   * moves it, so it is for a mesh that is not one solid. The swap lands in place, keeping the
   * model's transform and its place in the scene. The outcome, with the before/after triangle
   * counts, is reported as a toast.
   */
  const solidRemeshModelInPlace = useCallback(async (
    modelId: string,
    options: SolidRemeshOptions,
    progressSink?: SolidRemeshProgressSink,
  ): Promise<boolean> => {
    const model = modelsRef.current.find((entry) => entry.id === modelId);
    if (!model) return false;

    try {
      const result = await solidRemeshFromGeometry(model.geometry.geometry, options, progressSink);
      if (!result) {
        emitSceneImportReport(_(msg`Shrink-Wrap needs the desktop app.`), 'warning');
        return false;
      }
      // The pass awaited, so the scene it lands in may no longer hold the model.
      if (!modelsRef.current.some((entry) => entry.id === modelId)) return false;

      // The pass carries no mesh modifiers, so an empty before-state is what marks this as a
      // single undo step: the swap is recorded only when a history option is given.
      const swapped = replaceModelGeometry(modelId, result.geometry, solidRemeshModelLabel(model.name), {
        historyBefore: {},
      });
      if (!swapped) return false;

      const { report } = result;
      emitSceneImportReport(
        shrinkWrappedMessage(
          fmt.number(report.input_triangles),
          fmt.number(report.output_triangles),
          fmt.quantity(Math.round(report.ms), 0, 'ms'),
          _,
        ),
        'success',
      );
      return true;
    } catch (error) {
      console.error('[solidRemeshModelInPlace] Shrink-Wrap failed:', error);
      const message = error instanceof Error ? error.message : String(error);
      emitSceneImportReport(_(msg`Shrink-Wrap failed: ${message}`), 'error', { durationMs: 6_000 });
      return false;
    }
  }, [_, emitSceneImportReport, fmt, replaceModelGeometry]);

  // Cleanup on unmount
  useEffect(() => {
    const previous = trackedGeometriesRef.current;
    const next = new Set<THREE.BufferGeometry>();
    for (const model of models) modelGeometries(model).forEach((geometry) => next.add(geometry));

    for (const clipboardEntry of modelClipboard) {
      modelGeometries(clipboardEntry).forEach((geometry) => next.add(geometry));
    }

    for (const snapshot of sceneSnapshotRegistry.values()) {
      for (const model of snapshot.before.models) modelGeometries(model).forEach((geometry) => next.add(geometry));
      for (const model of snapshot.after.models) modelGeometries(model).forEach((geometry) => next.add(geometry));
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

  // ─── Plates ─────────────────────────────────────────────────────────────────

  /**
   * Where a plate sits in the world, from its place in the cascade. The first
   * plate is the origin, so a single-plate scene is exactly where it always was.
   */
  const plateOffsetFor = useCallback((plateId: string): { dxMm: number; dyMm: number } => {
    const index = platesRef.current.findIndex((plate) => plate.id === plateId);
    if (index <= 0) return { dxMm: 0, dyMm: 0 };
    return plateCascadeOffsetMm(index, {
      widthMm: view3dSettings.widthMm,
      depthMm: view3dSettings.depthMm,
    }, platesRef.current.length, plateOrderingRef.current);
  }, [view3dSettings.widthMm, view3dSettings.depthMm]);

  /**
   * The batched bed insert and the offset lookup, for callers declared above them.
   *
   * A paste that overflows needs both, and it is defined earlier in this hook than they
   * are; going through refs keeps the hook's declaration order intact instead of
   * rearranging a thousand lines to satisfy it.
   */
  const addPlatesRef = useRef<(count: number) => {
    plates: ScenePlate[];
    added: ScenePlate[];
    offsets: Map<string, { dxMm: number; dyMm: number }>;
  }>(() => ({ plates: [], added: [], offsets: new Map() }));
  const plateOffsetForRef = useRef(plateOffsetFor);
  plateOffsetForRef.current = plateOffsetFor;

  /**
   * Add an empty plate after the last one. The plate being worked on does not
   * change: adding a bed is not a reason to leave the one you are on.
   */
  /**
   * The models, moved with their beds when the grid is re-laid.
   *
   * Plates are numbered by position, so adding or removing one can shuffle the plates
   * already placed. A model left where its bed used to be would quietly belong to whichever
   * plate now covers that spot, so each one is shifted by exactly how far its own
   * plate moved. A model on no plate stays where it was put: it was dragged off a bed
   * deliberately and is not standing on anything that moved.
   *
   * The beds are spaced by their own footprint, so the same shift applies when the
   * build volume changes under them — a printer switch moves every bed but the first.
   * `laidOut` is the footprint they were placed on then, which is what the models'
   * positions are still measured against.
   */
  const modelsShiftedForRelaidPlates = useCallback((
    before: readonly ScenePlate[],
    after: readonly ScenePlate[],
    models: readonly LoadedModel[],
    options?: {
      /** The footprint the models were laid out against, when it is not the current one. */
      laidOut?: { widthMm: number; depthMm: number; originMode: View3DSettings['originMode'] };
      /** The ordering those beds were laid out under, when it is not the current one. */
      wasOrdering?: PlateOrdering;
    },
  ): LoadedModel[] => {
    if (after.length <= 1) return models as LoadedModel[];

    const { widthMm, depthMm, originMode } = view3dSettings;
    const footprint = { widthMm, depthMm };
    const was = options?.laidOut ?? { widthMm, depthMm, originMode };
    const nowOrdering = plateOrderingRef.current;
    const { minX: wasMinX, minY: wasMinY } = plateLocalRect(was);

    const shifts = new Map<string, { dxMm: number; dyMm: number }>();
    const frames = before.map((plate, index) => {
      const from = plateCascadeOffsetMm(index, was, before.length, options?.wasOrdering ?? nowOrdering);
      // By id, not by index: a bed taken out of the middle moves every one after it a slot
      // down. A bed that is gone takes its models with it, so they have nowhere to move.
      const afterIndex = after.findIndex((candidate) => candidate.id === plate.id);
      const to = afterIndex < 0 ? from : plateCascadeOffsetMm(afterIndex, footprint, after.length, nowOrdering);
      if (from.dxMm !== to.dxMm || from.dyMm !== to.dyMm) {
        shifts.set(plate.id, { dxMm: to.dxMm - from.dxMm, dyMm: to.dyMm - from.dyMm });
      }
      return {
        id: plate.id,
        minX: wasMinX + from.dxMm,
        minY: wasMinY + from.dyMm,
        maxX: wasMinX + from.dxMm + was.widthMm,
        maxY: wasMinY + from.dyMm + was.depthMm,
      };
    });

    if (shifts.size === 0) return models as LoadedModel[];

    return models.map((model) => {
      const { x, y } = model.transform.position;
      const frame = frames.find(
        (candidate) => x >= candidate.minX && x <= candidate.maxX && y >= candidate.minY && y <= candidate.maxY,
      );
      const shift = frame ? shifts.get(frame.id) : undefined;
      if (!shift) return model;

      return {
        ...model,
        transform: {
          ...model.transform,
          position: model.transform.position.clone().add(new THREE.Vector3(shift.dxMm, shift.dyMm, 0)),
        },
      };
    });
  }, [view3dSettings]);

  /**
   * The build volume the beds were last laid out on.
   *
   * The cascade spaces the beds by their own footprint, so a printer switch moves every
   * bed but the first. The models have to make the same move: one left at the plate 2
   * of the old printer sits off the side of the one it stands on, and reads as outside
   * its plate — which is what a smaller printer used to do to every bed but the first.
   */
  const laidOutFootprintRef = useRef<{
    printerId: string | null;
    widthMm: number;
    depthMm: number;
  } | null>(null);

  useLayoutEffect(() => {
    const previous = laidOutFootprintRef.current;
    const current = {
      printerId: activePrinterProfile?.id ?? null,
      widthMm: view3dSettings.widthMm,
      depthMm: view3dSettings.depthMm,
    };
    laidOutFootprintRef.current = current;
    if (!previous) return;

    const printerChanged = previous.printerId !== current.printerId;
    const footprintChanged = previous.widthMm !== current.widthMm
      || previous.depthMm !== current.depthMm;
    if (!printerChanged && !footprintChanged) return;

    const currentPlates = platesRef.current;
    const modelsBefore = modelsRef.current;
    const supportStateBefore = supportStateFor(modelsBefore);
    const shiftedModels = modelsShiftedForRelaidPlates(
      currentPlates,
      currentPlates,
      modelsBefore,
      {
        laidOut: {
          widthMm: previous.widthMm,
          depthMm: previous.depthMm,
          originMode: view3dSettings.originMode,
        },
      },
    );

    if (shiftedModels !== modelsBefore) {
      shiftSupportsWithModels(modelsBefore, shiftedModels);
      modelsRef.current = shiftedModels;
      setModels(shiftedModels);
      // The bed being worked on moved with the others, so the view comes along the way it
      // does when you pick a bed.
      setPlateViewRunId((id) => id + 1);
    }

    // Only a change of printer is a step worth naming. Editing the build volume of the same
    // profile moves the beds too, but there is no earlier volume to return to: the profile
    // itself is not part of the snapshot, only which one is active.
    if (!printerChanged) return;

    pushSceneSnapshotHistory(
      captureSceneSnapshot(modelsBefore, activeModelIdRef.current, selectedModelIdsRef.current, {
        plates: currentPlates,
        activePlateId: activePlateIdRef.current,
        printerProfileId: previous.printerId,
        includeSupportState: supportStateBefore !== undefined,
        supportStateOverride: supportStateBefore,
      }),
      captureSceneSnapshot(shiftedModels, activeModelIdRef.current, selectedModelIdsRef.current, {
        plates: currentPlates,
        activePlateId: activePlateIdRef.current,
        printerProfileId: current.printerId,
        includeSupportState: supportStateBefore !== undefined,
      }),
      activePrinterProfile ? switchPrinterLabel(activePrinterProfile.name) : SWITCH_PRINTER_LABEL,
    );
  }, [
    activePrinterProfile,
    modelsShiftedForRelaidPlates,
    pushSceneSnapshotHistory,
    view3dSettings.depthMm,
    view3dSettings.originMode,
    view3dSettings.widthMm,
  ]);

  /**
   * Switching the layout moves every bed but the first, so the models standing on them
   * move too: left where they were, each would belong to whichever bed the new layout
   * put under that spot. The same shift the plate-add path applies, told which ordering
   * the positions were laid out under, because that is the layout they are leaving.
   *
   * No history entry: the ordering is a setting, not scene content, so there is no
   * earlier document state to return to — the way a build volume edit moves the beds
   * without being a step of its own.
   */
  useEffect(() => {
    const previous = appliedPlateOrderingRef.current;
    if (previous.mode === plateOrdering.mode && previous.columns === plateOrdering.columns) return;
    appliedPlateOrderingRef.current = plateOrdering;

    const currentPlates = platesRef.current;
    if (currentPlates.length <= 1) return;

    const modelsBefore = modelsRef.current;
    const shiftedModels = modelsShiftedForRelaidPlates(currentPlates, currentPlates, modelsBefore, {
      wasOrdering: previous,
    });
    if (shiftedModels === modelsBefore) return;

    shiftSupportsWithModels(modelsBefore, shiftedModels);
    modelsRef.current = shiftedModels;
    setModels(shiftedModels);
    // The bed being worked on moved with the others, so the view comes along.
    setPlateViewRunId((id) => id + 1);
  }, [modelsShiftedForRelaidPlates, plateOrdering]);

  const addPlate = useCallback((options?: { pushHistory?: boolean }): string => {
    const plate: ScenePlate = { id: uuidv4(), name: '' };
    const current = platesRef.current;
    const next = [...current, plate];
    const modelsBefore = modelsRef.current;
    const shiftedModels = modelsShiftedForRelaidPlates(current, next, modelsBefore);

    if (options?.pushHistory === false) {
      setPlates(next);
      if (shiftedModels !== modelsBefore) {
        shiftSupportsWithModels(modelsBefore, shiftedModels);
        setModels(shiftedModels);
      }
      return plate.id;
    }

    const supportStateBefore = supportStateFor(modelsBefore);
    const before = captureSceneSnapshot(modelsBefore, activeModelIdRef.current, selectedModelIdsRef.current, {
      plates: current,
      activePlateId: activePlateIdRef.current,
      includeSupportState: supportStateBefore !== undefined,
      supportStateOverride: supportStateBefore,
    });

    setPlates(next);
    if (shiftedModels !== modelsBefore) {
      shiftSupportsWithModels(modelsBefore, shiftedModels);
      setModels(shiftedModels);
    }

    const after = captureSceneSnapshot(shiftedModels, activeModelIdRef.current, selectedModelIdsRef.current, {
      plates: next,
      activePlateId: activePlateIdRef.current,
      includeSupportState: supportStateBefore !== undefined,
    });
    pushSceneSnapshotHistory(before, after, addPlateLabel(next.length));
    return plate.id;
  }, [modelsShiftedForRelaidPlates, pushSceneSnapshotHistory]);

  /**
   * Drops beds from the scene without touching what stands on them.
   *
   * For a run that is about to move every model off them: the models keep their positions
   * until the run places them, and the beds go first, so the cascade spaces the beds that
   * remain — and any the run then adds — against the count that is actually left. The models
   * standing on the beds that stay are shifted with them, the same move adding a bed makes.
   *
   * `removePlate` is the one for a delete: it takes the plates' models with it.
   *
   * No history of its own: the caller folds the beds into its own step, which one undo then
   * takes back with the placements.
   */
  const dropPlates = useCallback((plateIds: readonly string[]): ScenePlate[] => {
    const current = platesRef.current;
    const doomed = new Set(plateIds);
    const remaining = current.filter((plate) => !doomed.has(plate.id));
    if (remaining.length === current.length || remaining.length === 0) return current;

    const shiftedModels = modelsShiftedForRelaidPlates(current, remaining, modelsRef.current);
    // The refs as well as the state: an arrange places its models from the same lists in the
    // same tick, and a bed list or a model left stale would be placed against the wrong
    // cascade.
    platesRef.current = remaining;
    setPlates(remaining);
    if (shiftedModels !== modelsRef.current) {
      shiftSupportsWithModels(modelsRef.current, shiftedModels);
      modelsRef.current = shiftedModels;
      setModels(shiftedModels);
    }
    if (doomed.has(activePlateIdRef.current)) {
      setActivePlateId(remaining[0].id);
      setPlateViewRunId((id) => id + 1);
    }

    return remaining;
  }, [modelsShiftedForRelaidPlates]);

  /**
   * Add `count` empty beds after the last one, and report the scene's beds with the frame
   * each ends up at.
   *
   * A run that fills more than one bed has to know where every bed sits before it can
   * place anything: it packs in a bed's own frame and then shifts the result into the
   * bed. Adding a bed can re-lay the ones already there, so the frames are only true once
   * the whole addition has landed — and they come from refs this hook owns, which a
   * caller cannot read until React has committed. Hence one call that adds the beds and
   * answers with the frames.
   *
   * No history entry of its own: the caller folds the beds into its own step, which one
   * undo then takes back with the placements.
   */
  const addPlates = useCallback((count: number): {
    plates: ScenePlate[];
    added: ScenePlate[];
    offsets: Map<string, { dxMm: number; dyMm: number }>;
  } => {
    const current = platesRef.current;
    const footprint = { widthMm: view3dSettings.widthMm, depthMm: view3dSettings.depthMm };
    const addedPlates: ScenePlate[] = count > 0
      ? Array.from({ length: count }, () => ({ id: uuidv4(), name: '' }))
      : [];
    const settled = addedPlates.length > 0 ? [...current, ...addedPlates] : current;

    if (addedPlates.length > 0) {
      const shiftedModels = modelsShiftedForRelaidPlates(current, settled, modelsRef.current);
      setPlates(settled);
      if (shiftedModels !== modelsRef.current) {
        // The ref as well as the state: whatever asked for the beds places its models from
        // the same list in this same tick, and a model left on the stale list would be
        // dropped back to where its bed used to be.
        modelsRef.current = shiftedModels;
        setModels(shiftedModels);
      }
    }

    const offsets = new Map<string, { dxMm: number; dyMm: number }>();
    settled.forEach((plate, index) => {
      offsets.set(plate.id, plateCascadeOffsetMm(index, footprint, settled.length, plateOrderingRef.current));
    });

    return { plates: settled, added: addedPlates, offsets };
  }, [modelsShiftedForRelaidPlates, view3dSettings.depthMm, view3dSettings.widthMm]);
  addPlatesRef.current = addPlates;

  const activatePlate = useCallback((plateId: string) => {
    if (!platesRef.current.some((plate) => plate.id === plateId)) return;
    if (activePlateIdRef.current === plateId) return;

    // Working on another bed: whatever was selected on the last one is not selected
    // here, and leaving it selected would keep the gizmo and the panels on a model
    // that is not on the plate you are looking at. The panel's own plate header
    // selects that plate's models straight after, which is where a selection on the
    // plate you just moved to comes from.
    setSelectedModelIds([]);
    setActiveModelId(null);
    setActivePlateId(plateId);
    setPlateViewRunId((id) => id + 1);
  }, []);

  /**
   * Every plate's world rect: its cascade offset, and the build volume it holds
   * in world coordinates. Computed once here because the canvas, the placement
   * search and the out-of-bounds check all have to agree about where a plate is,
   * and three separate derivations is how they stop agreeing.
   */
  const plateFrames = useMemo<PlateFrame[]>(() => {
    const { widthMm, depthMm, originMode } = view3dSettings;
    return computePlateFrames({ plates, footprint: { widthMm, depthMm, originMode }, ordering: plateOrdering });
  }, [plateOrdering, plates, view3dSettings]);

  plateFramesRef.current = plateFrames;

  /** The plate a model stands on; the rule is `resolveModelPlateId` in plateLayout. */
  const resolveModelPlateId = useCallback(
    (model: LoadedModel): string => plateIdForModel(model, plateFrames),
    [plateFrames],
  );

  /** The frame of the plate a model stands on. */
  const modelPlateFrame = useCallback((model: LoadedModel): PlateFrame | undefined => {
    const plateId = resolveModelPlateId(model);
    return plateFrames.find((frame) => frame.id === plateId) ?? plateFrames[0];
  }, [plateFrames, resolveModelPlateId]);

  const renamePlate = useCallback((plateId: string, name: string) => {
    setPlates((prev) => prev.map((plate) => (plate.id === plateId ? { ...plate, name } : plate)));
  }, []);

  /**
   * Delete a plate and the models standing on it. The first plate is the scene's
   * floor and stays, and so does the last one — a scene with no bed has nowhere
   * to build — so both are refused rather than half-done.
   */
  const removePlate = useCallback((plateId: string): boolean => {
    const current = platesRef.current;
    const remaining = current.filter((plate) => plate.id !== plateId);
    if (remaining.length === 0 || remaining.length === current.length || current[0]?.id === plateId) {
      return false;
    }

    const doomed = modelsOnPlate(modelsRef.current, plateId, plateFramesRef.current);
    const nextActivePlateId = activePlateIdRef.current === plateId ? remaining[0].id : activePlateIdRef.current;
    // The supports too: the delete takes the doomed models' supports, and the shift moves the
    // others', so an undo without them would leave both where the delete put them.
    const before = captureSceneSnapshot(modelsRef.current, activeModelIdRef.current, selectedModelIdsRef.current, {
      plates: current,
      activePlateId: activePlateIdRef.current,
      includeSupportState: true,
    });

    // The beds after it move up a slot, and their models and supports with them; the doomed
    // models stay put for the delete below to find.
    const shiftedModels = modelsShiftedForRelaidPlates(current, remaining, modelsRef.current);
    platesRef.current = remaining;
    setPlates(remaining);
    if (shiftedModels !== modelsRef.current) {
      shiftSupportsWithModels(modelsRef.current, shiftedModels);
      modelsRef.current = shiftedModels;
      setModels(shiftedModels);
    }
    setActivePlateId(nextActivePlateId);
    // Deleting the bed being worked on moves to another one, and the view comes with
    // it — the same slide picking a bed gives, rather than leaving the camera where the
    // bed that is now gone used to be.
    if (activePlateIdRef.current !== nextActivePlateId) setPlateViewRunId((id) => id + 1);

    // One entry for the whole move: `deleteModels` is asked not to push its own,
    // because undoing that one alone would bring the models back onto a bed that
    // is still gone and land them on another plate.
    void deleteModels(doomed.map((model) => model.id), { pushHistory: false }).then(async () => {
      // The models, the active model and the selection all come from the scene's refs,
      // which the delete's `setState`es only refresh once React has committed — a snapshot
      // taken a microtask early still holds the deleted models, and redo then puts them
      // back on another bed.
      await waitForUiYield();

      const after = captureSceneSnapshot(modelsRef.current, activeModelIdRef.current, selectedModelIdsRef.current, {
        plates: remaining,
        activePlateId: nextActivePlateId,
        includeSupportState: true,
      });
      pushSceneSnapshotHistory(before, after, deletePlateLabel(current.findIndex((plate) => plate.id === plateId) + 1));
    });

    return true;
  }, [deleteModels, modelsShiftedForRelaidPlates, pushSceneSnapshotHistory]);

  /**
   * Delete the models *and* every bed but the first.
   *
   * This is the select-all delete: the gesture names the whole scene, so leaving the
   * other beds standing behind would leave a scene that is empty but not clean. One
   * history entry for the lot, because undoing a wipe should bring the scene back whole
   * rather than bed by bed.
   *
   * A bed is kept when something the delete does not name is still standing on it — a
   * hidden model the select-all gesture skipped keeps its bed, rather than being orphaned
   * onto a plate it never stood on.
   */
  const deleteModelsAndExtraPlates = useCallback(async (idsInput: string[]): Promise<void> => {
    const current = platesRef.current;
    const firstPlateId = current[0]?.id;
    if (current.length <= 1 || !firstPlateId) {
      await deleteModels(idsInput);
      return;
    }

    const doomed = new Set(idsInput);
    const survivorStandsOnExtraPlate = modelsRef.current.some(
      (model) => !doomed.has(model.id) && modelPlateId(model) !== firstPlateId,
    );
    if (survivorStandsOnExtraPlate) {
      await deleteModels(idsInput);
      return;
    }

    const remaining = current.slice(0, 1);
    const before = captureSceneSnapshot(modelsRef.current, activeModelIdRef.current, selectedModelIdsRef.current, {
      plates: current,
      activePlateId: activePlateIdRef.current,
      includeSupportState: true,
    });

    setPlates(remaining);
    setActivePlateId(firstPlateId);
    if (activePlateIdRef.current !== firstPlateId) setPlateViewRunId((id) => id + 1);

    await deleteModels(idsInput, { pushHistory: false });
    // The models, the active model and the selection all come from the scene's refs,
    // which the delete's `setState`es only refresh once React has committed — a
    // snapshot taken a microtask early would put the deleted models back into the
    // "after" state, and redo would resurrect them.
    await waitForUiYield();

    const after = captureSceneSnapshot(modelsRef.current, activeModelIdRef.current, selectedModelIdsRef.current, {
      plates: remaining,
      activePlateId: firstPlateId,
      includeSupportState: true,
    });
    const historyKey = pushSceneSnapshotHistory(before, after, DELETE_MODELS_AND_PLATES_LABEL);
    void spillSceneSnapshotKey(historyKey, modelsRef.current);
  }, [deleteModels, modelPlateId, pushSceneSnapshotHistory, waitForUiYield]);

  /**
   * Move models to another plate, carrying them across the cascade so they keep
   * their place on the bed they arrive at rather than landing wherever their old
   * coordinates happen to fall.
   */
  const moveModelsToPlate = useCallback((modelIds: string[], plateId: string) => {
    const plateList = platesRef.current;
    const targetIndex = plateList.findIndex((plate) => plate.id === plateId);
    if (targetIndex < 0) return;

    const footprint = { widthMm: view3dSettings.widthMm, depthMm: view3dSettings.depthMm };
    const ordering = plateOrderingRef.current;
    const target = plateCascadeOffsetMm(targetIndex, footprint, plateList.length, ordering);
    const wanted = new Set(modelIds);

    for (const model of modelsRef.current) {
      if (!wanted.has(model.id)) continue;
      const sourcePlateId = modelPlateId(model);
      const sourceIndex = Math.max(0, plateList.findIndex((plate) => plate.id === sourcePlateId));
      const source = plateCascadeOffsetMm(sourceIndex, footprint, plateList.length, ordering);
      const dx = target.dxMm - source.dxMm;
      const dy = target.dyMm - source.dyMm;
      if (dx === 0 && dy === 0) continue;
      updateModelTransform(model.id, {
        ...model.transform,
        position: new THREE.Vector3(
          model.transform.position.x + dx,
          model.transform.position.y + dy,
          model.transform.position.z,
        ),
      }, model.transform);
    }

    setModels((prev) => prev.map((model) => (wanted.has(model.id) ? { ...model, plateId } : model)));
  }, [modelPlateId, updateModelTransform, view3dSettings.widthMm, view3dSettings.depthMm]);

  return {
    models,
    activeModelId,
    setActiveModelId,
    plateName,
    setPlateName,
    plates,
    activePlateId,
    plateViewRunId,
    addPlate,
    activatePlate,
    renamePlate,
    removePlate,
    moveModelsToPlate,
    plateOffsetFor,
    addPlates,
    dropPlates,
    /** The grid the beds are laid out on, for the callers that draw one that is not there yet. */
    plateOrdering,
    plateFrames,
    modelPlateFrame,
    resolveModelPlateId,
    voxlPrinterBundle,
    printerMismatch,
    resolvePrinterMismatch,
    plateLocked,
    setPlateLocked,
    isPlateLocked,
    isModelPlateLocked,
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
    openMeshRepairReportForModel,
    undoRepairsInPlace,
    manuallyRepairedModelIds,
    dismissMeshRepairReports,
    sceneImportPlacementPrompt,
    resolveSceneImportPlacementPrompt,
    obsoleteVoxlScene,
    dismissObsoleteVoxlScene,
    sceneImportHollowingPrompt,
    resolveSceneImportHollowingPrompt,
    meshRepairConfirmPrompt,
    resolveMeshRepairConfirmPrompt,
    repairModelsInPlace,
    tetSurfaceModelInPlace,
    solidRemeshModelInPlace,
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
    commitModelTransformsHistory,
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
    deleteModelsAndExtraPlates,
    deleteModel,
    deleteSupportsForModels,
    copyModel,
    copySelectedModels,
    cutSelectedModels,
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
    bakedAoIntensity,
    setBakedAoIntensity,
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
    configuredShaderType,
    setConfiguredShaderType,
    matcapVariant,
    setMatcapVariant,
    flatUseVertexColors,
    setFlatUseVertexColors,
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
    onImportSceneChange
  };
}

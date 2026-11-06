import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { ModelHollowingModifier } from './types';
import { getStoredMeshModifierRevisionToken, resolveModelMeshModifiers } from './meshModifierStore';
import { hasHollowingToBake } from './unappliedModifiers';
import {
  computeVoxelResolution,
  getRotationQuatTuple,
  getUniformScaleFactorForThickness,
  resolveBlockedVoxelValidity,
  worldMmToLocalMm,
} from './hollowingGrid';
import { hollowFromGeometry, type HollowOptions } from '@/utils/meshHollowing';
import { loadTauriCore } from '@/utils/tauriMeshBridge';
import { splitClassifiedSupportGeometry } from '@/features/scene/splitClassifiedSupports';
import { PreparedGeometryCache, preparedGeometryDigest, type PreparedGeometryCacheTicket } from './preparedGeometryCache';

export type PreparedModelGeometry = {
  model: LoadedModel;
  geometry: THREE.BufferGeometry;
  disposeAfterUse: boolean;
};

export type PreparedLoadedModelsForOutput = {
  models: LoadedModel[];
  modifiedModelCount: number;
  dispose: () => void;
};

export type PrepareModelGeometryOptions = { onBake?: () => void };
export type PrepareLoadedModelsOptions = PrepareModelGeometryOptions & { signal?: AbortSignal };

const preparedGeometryCache = new PreparedGeometryCache();
const sourceIdentities = new WeakMap<object, number>();
let nextSourceIdentity = 1;
const derivedSources = new WeakMap<THREE.BufferGeometry, {
  sourceRevision: string;
  partition: string;
}>();
const inFlightBakes = new Map<string, {
  ticket: PreparedGeometryCacheTicket;
  promise: Promise<Float32Array>;
}>();

export function clearPreparedGeometryCacheForModel(modelId: string): void {
  preparedGeometryCache.clearModel(modelId);
}

function sourceIdentity(value: object): number {
  let id = sourceIdentities.get(value);
  if (id === undefined) {
    id = nextSourceIdentity++;
    sourceIdentities.set(value, id);
  }
  return id;
}

function attributeSignature(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null | undefined): unknown {
  if (!attribute) return null;
  const interleaved = attribute instanceof THREE.InterleavedBufferAttribute ? attribute.data : null;
  const array = attribute.array;
  return [
    sourceIdentity(attribute), sourceIdentity(array), sourceIdentity(array.buffer),
    array.constructor.name, array.byteOffset, array.byteLength, array.buffer.byteLength,
    attribute.count, attribute.itemSize, attribute.normalized,
    interleaved ? interleaved.version : Reflect.get(attribute, 'version'),
    interleaved ? sourceIdentity(interleaved) : null,
    interleaved?.stride,
    attribute instanceof THREE.InterleavedBufferAttribute ? attribute.offset : null,
  ];
}

function computeGeometrySignature(geometry: THREE.BufferGeometry): string {
  const derived = derivedSources.get(geometry);
  if (derived) return JSON.stringify([derived.sourceRevision, derived.partition]);
  return JSON.stringify([
    sourceIdentity(geometry),
    attributeSignature(geometry.getAttribute('position')),
    attributeSignature(geometry.getIndex()),
    'whole',
  ]);
}

// The blocked voxels forwarded to slice-time hollowing (and folded into the
// cache signature) must be the same list. Item #7's invalidation effect clears
// stale blockers in the UI; if a stale set still reaches slice time (rotation
// changed in the same frame, or the effect never ran), dropping them beats
// hollowing against a mismatched grid. Callers pass the store-resolved
// `hollowing`, never `model.meshModifiers?.hollowing` directly.
function getEffectiveBlockedVoxelIndices(
  model: LoadedModel,
  hollowing: ModelHollowingModifier,
): number[] {
  const blocked = hollowing.blockedVoxelIndices ?? [];
  if (blocked.length === 0) return blocked;
  const currentQuat = getRotationQuatTuple(model.transform.rotation);
  if (resolveBlockedVoxelValidity(hollowing, currentQuat) === 'stale') {
    return [];
  }
  return blocked;
}

function buildHollowOptions(model: LoadedModel, copyBlockers = true): HollowOptions | null {
  const modifiers = resolveModelMeshModifiers(model);
  const hollowing = modifiers?.hollowing;
  if (!hasHollowingToBake(modifiers) || !hollowing) return null;
  const size = model.geometry.size;
  const scaleFactor = getUniformScaleFactorForThickness(model.transform.scale);
  const quat = new THREE.Quaternion().setFromEuler(model.transform.rotation);
  return {
    mode: hollowing.mode,
    voxelResolution: computeVoxelResolution(
      worldMmToLocalMm(hollowing.voxelSizeMm, scaleFactor),
      Math.max(size.x, size.y, size.z),
    ),
    shellThicknessMm: worldMmToLocalMm(hollowing.shellThicknessMm, scaleFactor),
    blockedVoxelIndices: copyBlockers
      ? getEffectiveBlockedVoxelIndices(model, hollowing).slice()
      : getEffectiveBlockedVoxelIndices(model, hollowing),
    infillMode: hollowing.infillMode ?? 'lattice',
    infillCellMm: worldMmToLocalMm(hollowing.infillCellMm ?? 4.2426, scaleFactor),
    infillBeamRadiusMm: worldMmToLocalMm(hollowing.infillBeamRadiusMm ?? 0.35, scaleFactor),
    openFace: hollowing.openFace,
    drainHoles: [],
    previewCavityOnly: false,
    smoothInternalSurfaces: true,
    internalChamferPasses: 2,
    rotationQuat: [quat.x, quat.y, quat.z, quat.w],
  };
}

export type ModelOutputModifierSignature = readonly [string, string];
const blockerValueSignatures = new WeakMap<object, { source: number[]; value: string }>();

/** Exact effective bake inputs; draft holes and source-storage wrappers are not geometry. */
export function getModelOutputModifierSignature(model: LoadedModel): ModelOutputModifierSignature | null {
  const options = buildHollowOptions(model, false);
  if (!options) return null;
  const revision = model.meshModifiers ? undefined : getStoredMeshModifierRevisionToken(model.id);
  const source = options.blockedVoxelIndices ?? [];
  const cached = revision ? blockerValueSignatures.get(revision) : undefined;
  const blockers = cached?.source === source ? cached.value : JSON.stringify(source);
  if (revision && cached?.source !== source) blockerValueSignatures.set(revision, { source, value: blockers });
  return [JSON.stringify({ ...options, blockedVoxelIndices: undefined }), blockers];
}

async function getPreparedGeometryCacheKey(
  model: LoadedModel,
  options: HollowOptions,
): Promise<string | null> {
  // Hash exactly the effective native options, with no rounded scale/quaternion
  // or lossy blocker hash. Source identities need no full mesh traversal.
  const signature = JSON.stringify([computeGeometrySignature(model.geometry.geometry), options]);
  const digest = await preparedGeometryDigest(new TextEncoder().encode(signature));
  return digest ? JSON.stringify([model.id, digest]) : null;
}

function createGeometryFromPositions(positions: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

function splitClassifiedModelForOutput(model: LoadedModel): {
  models: LoadedModel[];
  geometries: THREE.BufferGeometry[];
} | null {
  const report = model.geometry.meshDefects?.nativeRepairReport;
  const modelTriangleCount = Math.floor(report?.model_triangle_count ?? 0);

  const geometry = model.geometry.geometry;
  const position = geometry.getAttribute('position');
  if (!position) return null;
  const totalTriangleCount = Math.floor((geometry.getIndex()?.count ?? position.count) / 3);
  if (modelTriangleCount <= 0 || modelTriangleCount >= totalTriangleCount) return null;

  // Capture before copying: later edits of the original must not relabel old partitions.
  // Classification slices the raw position soup, independently of any BVH index.
  const sourceRevision = JSON.stringify([sourceIdentity(geometry), attributeSignature(position)]);
  const split = splitClassifiedSupportGeometry(model);
  if (!split) return null;

  // Split geometries have fresh UUIDs every export. Their immutable derivation
  // is the original source storage/revisions plus the classification boundary.
  derivedSources.set(split.modelGeometry.geometry, {
    sourceRevision,
    partition: `model:0:${split.modelTriangleCount}:${split.totalTriangleCount}`,
  });
  derivedSources.set(split.supportGeometry.geometry, {
    sourceRevision,
    partition: `support:${split.modelTriangleCount}:${split.totalTriangleCount}`,
  });

  const sourceDefects = model.geometry.meshDefects;
  const modelDefects = sourceDefects ? {
    ...sourceDefects,
    nativeRepairReport: undefined,
    supportSectionGeometry: undefined,
    modelSectionGeometry: undefined,
  } : undefined;
  const supportDefects = sourceDefects ? {
    ...sourceDefects,
    supportSectionGeometry: undefined,
    modelSectionGeometry: undefined,
    nativeRepairReport: report ? {
      ...report,
      model_triangle_count: null,
      likely_support_geometry: true,
    } : undefined,
  } : undefined;

  const modelBounds = { ...split.modelGeometry, meshDefects: modelDefects };
  const supportBounds = { ...split.supportGeometry, meshDefects: supportDefects };

  const modelPart: LoadedModel = {
    ...model,
    isSupportGeometry: false,
    geometry: modelBounds,
    polygonCount: split.modelTriangleCount,
    transform: {
      position: split.modelPosition,
      rotation: model.transform.rotation.clone(),
      scale: model.transform.scale.clone(),
    },
  };
  const supportPart: LoadedModel = {
    ...model,
    id: `${model.id}:slice-supports`,
    name: `${model.name} (Supports)`,
    isSupportGeometry: true,
    geometry: supportBounds,
    polygonCount: split.supportTriangleCount,
    meshModifiers: undefined,
    transform: {
      position: split.supportPosition,
      rotation: model.transform.rotation.clone(),
      scale: model.transform.scale.clone(),
    },
  };

  return {
    models: [modelPart, supportPart],
    geometries: [modelBounds.geometry, supportBounds.geometry],
  };
}

export async function prepareModelGeometryForOutput(
  model: LoadedModel,
  options: PrepareModelGeometryOptions = {},
): Promise<PreparedModelGeometry> {
  // Hole punches remain explicit Apply-only operations, never output-time work.
  const hollowOptions = buildHollowOptions(model);
  if (!hollowOptions) {
    return { model, geometry: model.geometry.geometry, disposeAfterUse: false };
  }

  // Begin before the first await: synchronous clear also fences key hashing,
  // queued native work and in-progress disk reads/writes.
  const ticket = preparedGeometryCache.begin(model.id);
  try {
    const cacheKey = await getPreparedGeometryCacheKey(model, hollowOptions);
    if (cacheKey) {
      const cached = await preparedGeometryCache.get(cacheKey, ticket);
      if (cached) return { model, geometry: createGeometryFromPositions(cached), disposeAfterUse: true };
      const flight = inFlightBakes.get(cacheKey);
      if (ticket.valid && flight?.ticket.valid) {
        const positions = await flight.promise;
        return { model, geometry: createGeometryFromPositions(positions.slice()), disposeAfterUse: true };
      }
    }

    const bake = async (): Promise<Float32Array> => {
      if (!await loadTauriCore()) {
        throw new Error(`Hollowing for "${model.name}" is only available in DragonFruit Desktop.`);
      }
      options.onBake?.();
      const result = await hollowFromGeometry(model.geometry.geometry, hollowOptions);
      if (!result) {
        throw new Error(`Hollowing for "${model.name}" is only available in DragonFruit Desktop.`);
      }
      if (cacheKey && ticket.valid) {
        const currentOptions = buildHollowOptions(model);
        if (currentOptions && await getPreparedGeometryCacheKey(model, currentOptions) === cacheKey) {
          await preparedGeometryCache.put(cacheKey, result.positions, ticket);
        }
      }
      return result.positions;
    };
    const promise = bake();
    const flight = { ticket, promise };
    if (cacheKey && ticket.valid) inFlightBakes.set(cacheKey, flight);
    try {
      const positions = await promise;
      // Flights may have multiple consumers. No output ever owns a cache/flight
      // buffer, so modifying or disposing one output cannot poison another.
      return { model, geometry: createGeometryFromPositions(positions.slice()), disposeAfterUse: true };
    } finally {
      if (cacheKey && inFlightBakes.get(cacheKey) === flight) inFlightBakes.delete(cacheKey);
    }
  } finally {
    preparedGeometryCache.end(ticket);
  }
}

export async function prepareLoadedModelsForOutput(
  models: LoadedModel[],
  options: PrepareLoadedModelsOptions = {},
): Promise<PreparedLoadedModelsForOutput> {
  const preparedModels: LoadedModel[] = [];
  const temporaryGeometries: THREE.BufferGeometry[] = [];
  let modifiedModelCount = 0;

  const checkCancelled = () => {
    if (options.signal?.aborted) throw options.signal.reason instanceof Error
      ? options.signal.reason : new DOMException('Mesh preparation cancelled', 'AbortError');
  };
  try {
    checkCancelled();
    const slicingModels: LoadedModel[] = [];
    for (const model of models) {
      const split = splitClassifiedModelForOutput(model);
      if (split) {
        slicingModels.push(...split.models);
        temporaryGeometries.push(...split.geometries);
      } else {
        slicingModels.push(model);
      }
    }

    for (const model of slicingModels) {
      checkCancelled();
      const prepared = await prepareModelGeometryForOutput(model, options);
      const geometryChanged = prepared.geometry !== model.geometry.geometry;

      if (prepared.disposeAfterUse) {
        temporaryGeometries.push(prepared.geometry);
      }
      checkCancelled();

      if (!geometryChanged) {
        preparedModels.push(model);
        continue;
      }

      modifiedModelCount += 1;
      preparedModels.push({
        ...model,
        geometry: {
          ...model.geometry,
          geometry: prepared.geometry,
        },
      });
    }
  } catch (error) {
    for (const geometry of temporaryGeometries) {
      try {
        geometry.dispose();
      } catch {
        // no-op
      }
    }
    throw error;
  }

  return {
    models: preparedModels,
    modifiedModelCount,
    dispose: () => {
      for (const geometry of temporaryGeometries) {
        geometry.dispose();
      }
    },
  };
}
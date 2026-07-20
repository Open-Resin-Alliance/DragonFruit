import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { ModelHolePunchPlacement, ModelHollowingModifier } from './types';
import { resolveModelMeshModifiers } from './meshModifierStore';
import {
  buildRotationSignature,
  computeVoxelResolution,
  getRotationQuatTuple,
  getUniformScaleFactorForThickness,
  hashBlockedVoxelIndices,
  resolveBlockedVoxelValidity,
  worldMmToLocalMm,
} from './hollowingGrid';
import { hollowFromGeometry, type HollowOptions } from '@/utils/meshHollowing';
import { punchFromGeometry, type PunchOptions } from '@/utils/meshPunching';
import { splitClassifiedSupportGeometry } from '@/features/scene/splitClassifiedSupports';

export type PreparedModelGeometry = {
  model: LoadedModel;
  geometry: THREE.BufferGeometry;
  disposeAfterUse: boolean;
};

/**
 * The output-source contract for output-bearing consumers (slicing staging,
 * mesh export) — STL-import decimation remediation Phase 1.
 *
 * `fullres-source-file`: the model's scene geometry is a reduced native
 * preview of an oversized import; outputs must NOT consume it. The Rust-side
 * splice re-reads `sourcePath` and reprojects `w = M · (v_raw − cPre)` —
 * bytes never enter the WebView (plan §C.2).
 *
 * `scene-geometry`: stage the scene BufferGeometry exactly as before
 * (byte-identical path for every non-preview model).
 */
export type OutputGeometrySource =
  | {
      kind: 'fullres-source-file';
      sourcePath: string;
      /**
       * Stored import-time pre-centering bbox center (raw-file frame).
       * `null` when the datum was never captured (e.g. models mocked or
       * persisted before Phase 1) — consumers must then degrade to the
       * preview path WITH a user-visible warning, never guess a center.
       */
      cPre: [number, number, number] | null;
      /** Import-time staleness fingerprint; `null` skips the stat compare. */
      fingerprint: { sizeBytes: number; mtimeMs: number } | null;
      originalTriangleCount: number;
    }
  | {
      kind: 'scene-geometry';
      geometry: THREE.BufferGeometry;
    };

/** The full-res arm of {@link OutputGeometrySource}. */
export type FullResSourceFile = Extract<OutputGeometrySource, { kind: 'fullres-source-file' }>;

/**
 * Core native-preview → full-resolution-source resolution, WITHOUT the
 * slice-time unbaked-hollowing carve-out below. Returns the full-res file
 * descriptor for a native-preview model that still retains its original
 * `sourcePath`, else `null`.
 *
 * The Phase-4 permanent mutators (hollow apply/preview, repair-in-place,
 * hole-punch apply) route on THIS, not on `resolveOutputGeometrySource`: the
 * carve-out is specific to slice-time modifier BAKING
 * (`prepareModelGeometryForOutput`, which bakes an unbaked hollowing modifier
 * onto the staged geometry) — a mutator's Apply IS the bake, so it must consume
 * full resolution even when an unbaked modifier is present. The nativePreview
 * marker's presence also guarantees no prior full-res mutation has baked (those
 * clear the marker), so the original file is the correct source. (Known edge:
 * if a full-res mutation DEGRADED to the preview — missing/stale source, user
 * warned — the marker is retained and a subsequent mutation would re-source the
 * original; documented Phase-4 limitation.)
 */
export function resolveFullResSourceForModel(model: LoadedModel): FullResSourceFile | null {
  const nativePreview = model.geometry.nativePreview;
  const sourcePath = typeof model.sourcePath === 'string' && model.sourcePath.trim().length > 0
    ? model.sourcePath
    : null;
  if (!nativePreview || !sourcePath) return null;
  return {
    kind: 'fullres-source-file',
    sourcePath,
    cPre: nativePreview.cPre ?? null,
    fingerprint: nativePreview.sourceFingerprint ?? null,
    originalTriangleCount: nativePreview.originalTriangleCount,
  };
}

/**
 * Resolves the staging source for an output-bearing consumer. Native-preview
 * models with a retained source path route to the full-resolution file; all
 * other models (and preview models carrying unbaked modifiers — bounded
 * Phase-1 scope, full-res modifier routing is Phase 4) stay on the scene
 * geometry.
 */
export function resolveOutputGeometrySource(model: LoadedModel): OutputGeometrySource {
  const fullRes = resolveFullResSourceForModel(model);
  if (fullRes) {
    // Unbaked hollowing is baked WebView-side from the scene geometry; a
    // full-res splice would silently drop the modifier. Keep such models on
    // the preview path (recorded Phase-4 carryover) rather than lose the
    // user's hollowing.
    const modifiers = resolveModelMeshModifiers(model);
    const hasUnbakedHollowing = Boolean(
      modifiers?.hollowing?.enabled && !modifiers.hollowing.bakedIntoGeometry,
    );
    if (hasUnbakedHollowing) {
      console.warn(
        `[resolveOutputGeometrySource] "${model.name}" is a native preview with unbaked `
        + 'hollowing — staging the preview so the modifier applies (full-res modifier '
        + 'routing is Phase 4).',
      );
      return { kind: 'scene-geometry', geometry: model.geometry.geometry };
    }

    return fullRes;
  }

  return { kind: 'scene-geometry', geometry: model.geometry.geometry };
}

export type PreparedLoadedModelsForOutput = {
  models: LoadedModel[];
  modifiedModelCount: number;
  dispose: () => void;
};

const PREPARED_GEOMETRY_CACHE_LIMIT = 8;
const preparedGeometryCache = new Map<string, Float32Array>();

function computeGeometrySignature(geometry: THREE.BufferGeometry): string {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const vertexCount = position?.count ?? 0;
  const positionVersionRaw = position ? Reflect.get(position as object, 'version') : undefined;
  const positionVersion = typeof positionVersionRaw === 'number' ? positionVersionRaw : 0;
  const indexVersionRaw = index ? Reflect.get(index as object, 'version') : undefined;
  const indexVersion = typeof indexVersionRaw === 'number' ? indexVersionRaw : 0;
  return `${geometry.uuid}:${vertexCount}:${positionVersion}:${indexVersion}`;
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

function buildModifierSignature(model: LoadedModel): string | null {
  const modifiers = resolveModelMeshModifiers(model);
  const hollowing = modifiers?.hollowing?.enabled && !modifiers.hollowing.bakedIntoGeometry
    ? modifiers.hollowing
    : null;
  const shouldApplyPunches = !modifiers?.holePunchesBakedIntoGeometry;
  const punches = shouldApplyPunches
    ? (modifiers?.holePunches ?? []).filter((placement) => placement.radiusMm > 0 && placement.depthMm > 0)
    : [];

  if (!hollowing?.enabled && punches.length === 0) {
    return null;
  }

  const normalized = {
    hollowing: hollowing?.enabled ? {
      mode: hollowing.mode,
      voxelSizeMm: hollowing.voxelSizeMm,
      shellThicknessMm: hollowing.shellThicknessMm,
      infillMode: hollowing.infillMode ?? 'lattice',
      infillCellMm: hollowing.infillCellMm ?? 4.2426,
      infillBeamRadiusMm: hollowing.infillBeamRadiusMm ?? 0.35,
      openFace: hollowing.openFace,
      // Rotation and scale change the Rust voxel grid; the blocker hash changes
      // the keep mask. Geometry version does not change on transform (rotation
      // is a transform, geometry is local-space), so without these the cache
      // would serve a cavity computed at a stale rotation/scale/blocker set.
      // Hash (not the raw array) keeps the key O(1)-sized for large lasso
      // selections (audit #23); it covers the *effective* (validity-filtered)
      // list so the signature matches what is actually forwarded.
      rotation: buildRotationSignature(model.transform.rotation),
      scaleFactor: Number(
        getUniformScaleFactorForThickness(model.transform.scale).toFixed(6),
      ),
      blockedVoxelIndicesHash: hashBlockedVoxelIndices(
        getEffectiveBlockedVoxelIndices(model, hollowing),
      ),
    } : null,
    holePunches: punches.map((placement) => ({
      centerNorm: placement.centerNorm,
      radiusMm: placement.radiusMm,
      depthMm: placement.depthMm,
      direction: placement.direction,
    })),
  };

  return JSON.stringify(normalized);
}

function getPreparedGeometryCacheKey(model: LoadedModel): string | null {
  const modifierSignature = buildModifierSignature(model);
  if (!modifierSignature) return null;
  const geometrySignature = computeGeometrySignature(model.geometry.geometry);
  return `${model.id}:${geometrySignature}:${modifierSignature}`;
}

function getCachedPreparedPositions(cacheKey: string): Float32Array | null {
  const hit = preparedGeometryCache.get(cacheKey);
  if (!hit) return null;
  // Refresh LRU order.
  preparedGeometryCache.delete(cacheKey);
  preparedGeometryCache.set(cacheKey, hit);
  return hit;
}

function setCachedPreparedPositions(cacheKey: string, positions: Float32Array): void {
  preparedGeometryCache.set(cacheKey, positions);
  while (preparedGeometryCache.size > PREPARED_GEOMETRY_CACHE_LIMIT) {
    const oldestKey = preparedGeometryCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    preparedGeometryCache.delete(oldestKey);
  }
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

  const split = splitClassifiedSupportGeometry(model);
  if (!split) return null;

  const sourceDefects = model.geometry.meshDefects;
  const modelDefects = sourceDefects ? {
    ...sourceDefects,
    nativeRepairReport: undefined,
    supportSectionGeometry: undefined,
  } : undefined;
  const supportDefects = sourceDefects ? {
    ...sourceDefects,
    supportSectionGeometry: undefined,
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

function buildPunchOptionsFromPlacements(
  sourceBounds: { bbox: THREE.Box3; size: THREE.Vector3 },
  placements: ModelHolePunchPlacement[],
): PunchOptions {
  const bbox = sourceBounds.bbox;
  const size = sourceBounds.size;
  const toMm = (norm: number, min: number, span: number) => min + (norm * (Math.abs(span) <= 1e-9 ? 0 : span));

  return {
    punches: placements.map((placement) => {
      const mmCenterX = toMm(placement.centerNorm[0], bbox.min.x, size.x);
      const mmCenterY = toMm(placement.centerNorm[1], bbox.min.y, size.y);
      const mmCenterZ = toMm(placement.centerNorm[2], bbox.min.z, size.z);
      const centerNorm: [number, number, number] = [
        size.x <= 1e-9 ? 0.5 : (mmCenterX - bbox.min.x) / size.x,
        size.y <= 1e-9 ? 0.5 : (mmCenterY - bbox.min.y) / size.y,
        size.z <= 1e-9 ? 0.5 : (mmCenterZ - bbox.min.z) / size.z,
      ];

      return {
        centerNorm,
        radiusMm: placement.radiusMm,
        radiusYMm: placement.radiusYMm,
        direction: placement.direction,
        lengthMm: placement.depthMm,
      };
    }),
  };
}

export async function prepareModelGeometryForOutput(model: LoadedModel): Promise<PreparedModelGeometry> {
  const cacheKey = getPreparedGeometryCacheKey(model);
  if (cacheKey) {
    const cachedPositions = getCachedPreparedPositions(cacheKey);
    if (cachedPositions) {
      return {
        model,
        geometry: createGeometryFromPositions(cachedPositions),
        disposeAfterUse: true,
      };
    }
  }

  // Model objects in React state deliberately carry meshModifiers: undefined
  // (externalized store) — resolve through the store or unbaked hollowing is
  // silently skipped at slice/export time.
  const modifiers = resolveModelMeshModifiers(model);
  const hollowing = modifiers?.hollowing;
  const shouldApplyHollowing = Boolean(hollowing?.enabled && !hollowing.bakedIntoGeometry);
  // Hole punches are never auto-applied during slice/export — the user must
  // explicitly bake them first (via the hole-punch panel's Apply button or a
  // pre-slice confirmation dialog). This prevents unapplied LYS-imported holes
  // from silently corrupting the sliced output.
  const shouldApplyPunches = false;
  const punches: ModelHolePunchPlacement[] = [];

  if (!shouldApplyHollowing && punches.length === 0) {
    return {
      model,
      geometry: model.geometry.geometry,
      disposeAfterUse: false,
    };
  }

  let workingGeometry = model.geometry.geometry;
  let createdGeometry: THREE.BufferGeometry | null = null;
  const sourceBounds = {
    bbox: model.geometry.bbox,
    size: model.geometry.size,
  };

  if (shouldApplyHollowing && hollowing) {
    const maxExtent = Math.max(sourceBounds.size.x, sourceBounds.size.y, sourceBounds.size.z);
    // The voxel grid lives in the model's local space, so world-space mm params
    // (voxel size, shell thickness, infill dims) must be converted to local mm
    // before hollowing — the same conversion the preview (buildHollowingOptions)
    // and Apply paths already apply. For unscaled models this is an exact no-op
    // (worldMmToLocalMm(v, 1) === max(1e-4, v)); scaled models now slice against
    // the same grid the preview showed, so forwarded blockers land on the right
    // voxels.
    const scaleFactor = getUniformScaleFactorForThickness(model.transform.scale);
    const voxelResolution = computeVoxelResolution(
      worldMmToLocalMm(hollowing.voxelSizeMm, scaleFactor),
      maxExtent,
    );
    const quat = new THREE.Quaternion().setFromEuler(model.transform.rotation);
    const hollowOptions: HollowOptions = {
      mode: hollowing.mode,
      voxelResolution,
      shellThicknessMm: worldMmToLocalMm(hollowing.shellThicknessMm, scaleFactor),
      blockedVoxelIndices: getEffectiveBlockedVoxelIndices(model, hollowing),
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

    const hollowResult = await hollowFromGeometry(workingGeometry, hollowOptions);
    if (!hollowResult) {
      throw new Error(`Hollowing for "${model.name}" is only available in DragonFruit Desktop.`);
    }

    createdGeometry = createGeometryFromPositions(hollowResult.positions);
    workingGeometry = createdGeometry;
  }

  if (punches.length > 0) {
    const punchOptions = buildPunchOptionsFromPlacements(sourceBounds, punches);
    const punchResult = await punchFromGeometry(workingGeometry, punchOptions);
    if (!punchResult) {
      if (createdGeometry) createdGeometry.dispose();
      throw new Error(`Hole punching for "${model.name}" is only available in DragonFruit Desktop.`);
    }

    if (createdGeometry) {
      createdGeometry.dispose();
    }
    createdGeometry = createGeometryFromPositions(punchResult.positions);
    workingGeometry = createdGeometry;
  }

  if (cacheKey && createdGeometry) {
    const positionAttribute = createdGeometry.getAttribute('position') as THREE.BufferAttribute;
    if (positionAttribute?.array instanceof Float32Array) {
      setCachedPreparedPositions(cacheKey, positionAttribute.array);
    }
  }

  return {
    model,
    geometry: workingGeometry,
    disposeAfterUse: createdGeometry !== null,
  };
}

export async function prepareLoadedModelsForOutput(models: LoadedModel[]): Promise<PreparedLoadedModelsForOutput> {
  const preparedModels: LoadedModel[] = [];
  const temporaryGeometries: THREE.BufferGeometry[] = [];
  let modifiedModelCount = 0;

  try {
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
      const prepared = await prepareModelGeometryForOutput(model);
      const geometryChanged = prepared.geometry !== model.geometry.geometry;

      if (prepared.disposeAfterUse) {
        temporaryGeometries.push(prepared.geometry);
      }

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

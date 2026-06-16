import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { ModelHolePunchPlacement } from './types';
import { hollowFromGeometry, type HollowOptions } from '@/utils/meshHollowing';
import { punchFromGeometry, type PunchOptions } from '@/utils/meshPunching';

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

function buildModifierSignature(model: LoadedModel): string | null {
  const modifiers = model.meshModifiers;
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

  const modifiers = model.meshModifiers;
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
    const voxelResolution = Math.min(192, Math.max(24, Math.round(maxExtent / Math.max(0.05, hollowing.voxelSizeMm))));
    const quat = new THREE.Quaternion().setFromEuler(model.transform.rotation);
    const hollowOptions: HollowOptions = {
      mode: hollowing.mode,
      voxelResolution,
      shellThicknessMm: hollowing.shellThicknessMm,
      infillMode: hollowing.infillMode ?? 'lattice',
      infillCellMm: hollowing.infillCellMm ?? 4.2426,
      infillBeamRadiusMm: hollowing.infillBeamRadiusMm ?? 0.35,
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
    for (const model of models) {
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

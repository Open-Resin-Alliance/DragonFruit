import * as THREE from 'three';

import { getSupportFrameInverse, getSupportFrameTransform } from './supportFrames';
import { getSupportTypeDescriptor, SUPPORT_TYPES } from './supportTypeRegistry';
import { transformSupportRecord, type SupportDeltaTransform } from './state';
import type { SupportEntityAny, SupportState } from './types';

/**
 * Coordinate conversion for the model-local support store.
 *
 * `SupportState` records will be stored in the owning model frame. Import,
 * export, placement and legacy consumers still speak world space, so they
 * convert at the boundary with these helpers rather than each carrying a
 * matrix of their own.
 */

function deltaFor(matrix: THREE.Matrix4): SupportDeltaTransform {
  return {
    matrix,
    normalMatrix: new THREE.Matrix3().getNormalMatrix(matrix),
    // A frame conversion is a full affine change, including Z. The plate
    // anchoring rule belongs to model moves, not to the frame boundary.
    preserveRootZ: false,
  };
}

/** The model that owns a knot: the model of the support whose shaft hosts it. */
function modelIdByKnotId(state: SupportState): Map<string, string> {
  const byShaft = new Map<string, string>();
  for (const descriptor of SUPPORT_TYPES) {
    const collection = state[descriptor.location.key] as unknown as
      | Record<string, { id: string; modelId?: string; segments?: Array<{ id: string }> }>
      | undefined;
    for (const entity of Object.values(collection ?? {})) {
      if (!entity.modelId) continue;
      for (const segment of entity.segments ?? []) byShaft.set(segment.id, entity.modelId);
    }
  }
  const byKnot = new Map<string, string>();
  for (const knot of Object.values(state.knots)) {
    const modelId = byShaft.get(knot.parentShaftId);
    if (modelId) byKnot.set(knot.id, modelId);
  }
  return byKnot;
}

/** Convert one rooted or shafted entity between frames without touching its graph links. */
export function transformSupportEntityFrame(
  typeId: string,
  entity: SupportEntityAny,
  matrix: THREE.Matrix4,
): SupportEntityAny {
  const descriptor = getSupportTypeDescriptor(typeId as never);
  if (!descriptor) return entity;
  return transformSupportRecord(typeId as never, entity as unknown as Record<string, unknown>, deltaFor(matrix)) as unknown as SupportEntityAny;
}

export function transformKnotFrame(
  knot: SupportState['knots'][string],
  matrix: THREE.Matrix4,
): SupportState['knots'][string] {
  return transformSupportRecord('knots', knot as unknown as Record<string, unknown>, deltaFor(matrix)) as unknown as SupportState['knots'][string];
}

export function transformRootFrame(
  root: SupportState['roots'][string],
  matrix: THREE.Matrix4,
): SupportState['roots'][string] {
  return transformSupportRecord('roots', root as unknown as Record<string, unknown>, deltaFor(matrix)) as unknown as SupportState['roots'][string];
}

type FrameMatrices = ReadonlyMap<string, THREE.Matrix4>;

function entityTargetMatrix(entityModelId: string | undefined, byModel: FrameMatrices): THREE.Matrix4 | null {
  if (!entityModelId) return null;
  return byModel.get(entityModelId) ?? null;
}

/**
 * Convert every collection in `state` with the matrix for its owning model.
 * Interaction fields and `supports` are carried through untouched; the store
 * rebuilds its views when it installs the result.
 */
export function transformSupportStateFrames(
  state: SupportState,
  byModel: FrameMatrices,
): SupportState {
  const knotsByModel = modelIdByKnotId(state);
  const next: Record<string, unknown> = { ...state };
  // The derived map is rebuilt from the collections by the store, and its
  // entities still point at the old frame's records.
  delete next.supports;
  for (const descriptor of SUPPORT_TYPES) {
    const source = state[descriptor.location.key] as unknown as Record<string, SupportEntityAny>;
    const target: Record<string, SupportEntityAny> = {};
    for (const [id, entity] of Object.entries(source)) {
      const matrix = entityTargetMatrix(entity.modelId, byModel);
      target[id] = matrix ? transformSupportEntityFrame(descriptor.id, entity, matrix) : entity;
    }
    next[descriptor.location.key] = target;
  }

  const roots: Record<string, SupportState['roots'][string]> = {};
  for (const [id, root] of Object.entries(state.roots)) {
    const matrix = entityTargetMatrix(root.modelId, byModel);
    roots[id] = matrix ? transformRootFrame(root, matrix) : root;
  }
  next.roots = roots;

  const knots: Record<string, SupportState['knots'][string]> = {};
  for (const [id, knot] of Object.entries(state.knots)) {
    const matrix = entityTargetMatrix(knotsByModel.get(id), byModel);
    knots[id] = matrix ? transformKnotFrame(knot, matrix) : knot;
  }
  next.knots = knots;

  return next as unknown as SupportState;
}

/** World records into the owning model frame. */
export function toLocalSupportState(state: SupportState): SupportState {
  const byModel = new Map<string, THREE.Matrix4>();
  for (const modelId of collectModelIds(state)) {
    const inverse = getSupportFrameInverse(modelId);
    if (inverse) byModel.set(modelId, inverse);
  }
  return transformSupportStateFrames(state, byModel);
}

/** Local records back to world space. */
export function toWorldSupportState(state: SupportState): SupportState {
  const byModel = new Map<string, THREE.Matrix4>();
  for (const modelId of collectModelIds(state)) {
    const frame = getSupportFrameTransform(modelId);
    if (!frame) continue;
    byModel.set(modelId, new THREE.Matrix4().compose(
      frame.position,
      new THREE.Quaternion().setFromEuler(frame.rotation),
      frame.scale,
    ));
  }
  return transformSupportStateFrames(state, byModel);
}

function collectModelIds(state: SupportState): Set<string> {
  const ids = new Set<string>();
  for (const descriptor of SUPPORT_TYPES) {
    const collection = state[descriptor.location.key] as unknown as Record<string, { modelId?: string }>;
    for (const entity of Object.values(collection ?? {})) {
      if (entity.modelId) ids.add(entity.modelId);
    }
  }
  for (const root of Object.values(state.roots)) if (root.modelId) ids.add(root.modelId);
  return ids;
}

import * as THREE from 'three';

import type { ModelTransform } from '@/hooks/useModelTransform';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

/**
 * The model transform a model's support records are currently baked under.
 *
 * Support records are still world space. A pure XY model move does not rewrite
 * them: the records stay at the last committed frame and renderers compose the
 * inverse of that frame, so the live model group moves them as a rigid body.
 * The frame is advanced only when the records are rewritten to the new world
 * positions, a non-XY move or the flush before Support/export.
 *
 * This is the migration seam for model-local support storage. Once records are
 * local, the frame is the owning model transform and the world bake can go.
 */
export type SupportFrameSnapshot = Record<string, ModelTransform>;

type FrameEntry = {
  transform: ModelTransform;
  inverse: THREE.Matrix4;
};

const frames = new Map<string, FrameEntry>();

function cloneTransform(transform: ModelTransform): ModelTransform {
  return {
    position: transform.position.clone(),
    rotation: transform.rotation.clone(),
    scale: transform.scale.clone(),
  };
}

function composeFrame(transform: ModelTransform): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    transform.position,
    quaternionFromGlobalEuler(transform.rotation),
    transform.scale,
  );
}

export function setSupportFrame(modelId: string, transform: ModelTransform): void {
  const stored = cloneTransform(transform);
  frames.set(modelId, {
    transform: stored,
    inverse: composeFrame(stored).invert(),
  });
}

export function ensureSupportFrame(modelId: string, transform: ModelTransform): void {
  if (!frames.has(modelId)) setSupportFrame(modelId, transform);
}

export function getSupportFrameTransform(modelId: string): ModelTransform | null {
  const entry = frames.get(modelId);
  return entry ? cloneTransform(entry.transform) : null;
}

export function getSupportFrameInverse(modelId: string): THREE.Matrix4 | null {
  const entry = frames.get(modelId);
  return entry ? entry.inverse.clone() : null;
}

/** The inverse matrices the merged-support baker consumes, one per known model. */
export function getSupportFrameInverseMap(): Map<string, THREE.Matrix4> {
  const map = new Map<string, THREE.Matrix4>();
  for (const [modelId, entry] of frames) map.set(modelId, entry.inverse.clone());
  return map;
}

/** Track each live model's current transform and drop frames for removed models. */
export function syncSupportFrames(models: ReadonlyArray<{ id: string; transform: ModelTransform }>): void {
  const live = new Set<string>();
  for (const model of models) {
    live.add(model.id);
    setSupportFrame(model.id, model.transform);
  }
  for (const modelId of Array.from(frames.keys())) {
    if (!live.has(modelId)) frames.delete(modelId);
  }
}

export function captureSupportFrames(): SupportFrameSnapshot {
  const snapshot: SupportFrameSnapshot = {};
  for (const [modelId, entry] of frames) snapshot[modelId] = cloneTransform(entry.transform);
  return snapshot;
}

export function restoreSupportFrames(
  snapshot: SupportFrameSnapshot | undefined,
  models?: ReadonlyArray<{ id: string; transform: ModelTransform }>,
): void {
  frames.clear();
  if (snapshot) {
    for (const [modelId, transform] of Object.entries(snapshot)) setSupportFrame(modelId, transform);
  }
  if (models) syncSupportFrames(models);
}

export function resetSupportFrames(): void {
  frames.clear();
}

export function hasSupportFrame(modelId: string): boolean {
  return frames.has(modelId);
}

import { useCallback, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { computePreciseModelWorldBounds } from '@/utils/modelBounds';
import { generateCandidates } from './logic/generateCandidates';
import { measureOrientation, scoreCandidates } from './logic/scoreOrientation';
import { getProtectedMask } from './logic/protectedMask';
import type { AutoOrientGoals, OrientationMetrics } from './types';

const PLATFORM_CLEARANCE_MM = 0.001;

/** Yield a frame so the UI repaints between models on multi-model runs. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export interface AutoOrientProgress {
  done: number;
  total: number;
  /** Name of the model currently being evaluated, for UI feedback. */
  currentModelName?: string;
}

export interface AutoOrientResultEntry {
  id: string;
  transform: ModelTransform;
}

interface UseAutoOrientManagerArgs {
  models: LoadedModel[];
  selectedModelIds: string[];
  activeModelId: string | null;
  /** Apply the computed transforms (undoable, support-synced). */
  applyTransforms: (updates: AutoOrientResultEntry[]) => void;
}

/**
 * Compute the resting transform for a model given a chosen rotation: keep XY
 * position, apply the rotation, and drop the model onto the plate (lowest point
 * at Z≈0). Scale is preserved.
 */
function buildRestingTransform(
  model: LoadedModel,
  rotation: THREE.Euler,
): ModelTransform {
  const current = model.transform;
  const bounds = computePreciseModelWorldBounds(model.geometry, {
    position: new THREE.Vector3(0, 0, 0),
    rotation,
    scale: current.scale,
  });
  const restZ = PLATFORM_CLEARANCE_MM - bounds.min.z;
  return {
    position: new THREE.Vector3(current.position.x, current.position.y, restZ),
    rotation: rotation.clone(),
    scale: current.scale.clone(),
  };
}

export function useAutoOrientManager({
  models,
  selectedModelIds,
  activeModelId,
  applyTransforms,
}: UseAutoOrientManagerArgs) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<AutoOrientProgress | null>(null);
  const cancelRef = useRef(false);

  const targetIds = useMemo(
    () => (selectedModelIds.length > 0 ? selectedModelIds : activeModelId ? [activeModelId] : []),
    [selectedModelIds, activeModelId],
  );

  const run = useCallback(
    async (goals: AutoOrientGoals) => {
      const anyGoal =
        goals.minimizeIslands > 0 || goals.minimizeHeight > 0 || goals.minimizeFootprint > 0;
      if (!anyGoal || targetIds.length === 0 || running) return;

      const targets = targetIds
        .map((id) => models.find((m) => m.id === id))
        .filter((m): m is LoadedModel => Boolean(m));
      if (targets.length === 0) return;

      cancelRef.current = false;
      setRunning(true);

      const perModelCandidates = targets.map((m) => generateCandidates(m.transform.rotation));
      const total = targets.length;
      let done = 0;
      setProgress({ done, total, currentModelName: targets[0]?.name });

      const updates: AutoOrientResultEntry[] = [];

      try {
        for (let mi = 0; mi < targets.length; mi++) {
          if (cancelRef.current) return;
          const model = targets[mi];
          const candidates = perModelCandidates[mi];
          setProgress({ done, total, currentModelName: model.name });

          // Scoring is pure arithmetic over cached face data — fast enough to
          // evaluate every candidate for a model synchronously in one pass.
          const protectedMask = getProtectedMask(model.geometry.geometry);
          const metrics: OrientationMetrics[] = candidates.map((candidate) =>
            measureOrientation(model.geometry, candidate.rotation, goals, protectedMask),
          );

          const scored = scoreCandidates(candidates, metrics, goals);
          const best = scored[0];
          if (best) {
            updates.push({ id: model.id, transform: buildRestingTransform(model, best.rotation) });
          }

          done++;
          setProgress({ done, total, currentModelName: model.name });
          // Yield between models so progress repaints on large multi-model runs.
          if (mi < targets.length - 1) await yieldToBrowser();
        }

        if (!cancelRef.current && updates.length > 0) {
          applyTransforms(updates);
        }
      } finally {
        setRunning(false);
        setProgress(null);
      }
    },
    [applyTransforms, models, running, targetIds],
  );

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  return {
    run,
    cancel,
    running,
    progress,
    targetCount: targetIds.length,
  };
}

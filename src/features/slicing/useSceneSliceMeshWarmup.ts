import { useEffect, useMemo, useState } from 'react';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { plateSliceScope, type PlateFrame } from '@/features/scene/plates/plateLayout';
import {
  readSliceMeshWarmupContext,
  subscribeToSliceMeshWarmupContext,
  type SceneSliceMeshWarmupContext,
} from './sliceInputContext';
import { useSliceMeshWarmup } from './useSliceMeshWarmup';

export type SceneSliceMeshWarmupOptions = {
  models: LoadedModel[];
  plateFrames: readonly PlateFrame[];
  activePlateId: string;
  excludedModelIds: readonly string[];
  exportMode: boolean;
  ready: boolean;
  paused?: boolean;
};

/** The one scene-owned producer; entering/leaving export only changes its exact inputs. */
export function useSceneSliceMeshWarmup({
  models,
  plateFrames,
  activePlateId,
  excludedModelIds,
  exportMode,
  ready,
  paused = false,
}: SceneSliceMeshWarmupOptions): void {
  const [context, setContext] = useState<SceneSliceMeshWarmupContext | null>(null);
  useEffect(() => {
    const refresh = () => { setContext(readSliceMeshWarmupContext()); };
    const unsubscribe = subscribeToSliceMeshWarmupContext(refresh);
    refresh();
    return unsubscribe;
  }, []);

  const targetPlateId = (exportMode ? context?.targetPlateId : undefined) ?? activePlateId;
  const scope = useMemo(() => {
    const frame = plateFrames.find((plate) => plate.id === targetPlateId)
      ?? plateFrames.find((plate) => plate.id === activePlateId);
    return frame ? plateSliceScope(frame, models, plateFrames) : null;
  }, [activePlateId, models, plateFrames, targetPlateId]);
  const scopedModels = useMemo(() => {
    if (!scope) return models;
    const ids = new Set(scope.modelIds);
    return models.filter((model) => ids.has(model.id));
  }, [models, scope]);

  useSliceMeshWarmup(context ? {
    models: scopedModels,
    excludedModelIds,
    ...(scope ? {
      plateVolumeBoundsMm: scope.volumeBoundsMm,
      plateOffsetMm: scope.offsetMm,
    } : {}),
    printerProfile: context.printerProfile,
    materialProfile: context.materialProfile,
    antiAliasing: context.antiAliasing,
  } : null, exportMode && context?.imminentSlice === true, ready, paused);
}

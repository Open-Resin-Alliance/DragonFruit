import * as THREE from 'three';
import { plateFrameFor, plateSliceScope, type PlateFrame, type PlateMember } from '@/features/scene/plates/plateLayout';

/**
 * What the fast scrub preview draws while the layer slider is dragged: one plate,
 * moved to the origin the way its slice is taken.
 *
 * The preview is a top-down look at one bed's build volume around the origin, so
 * whatever it is handed as the scene stands shows the bed at the origin, plate 1.
 * Its models and its supports both have to be the plate's own and both have to
 * make the same move: the models alone was #867, where plate 1's supports were
 * drawn over the slice of plate 2 and plate 2's own were off to the side.
 */
export interface ScrubPreviewScope<M> {
  /** The plate's models, moved to the origin. A model that does not move keeps its object. */
  models: M[];
  /** The models whose supports and rafts stay out of the preview: every model on another plate. */
  supportExcludeModelIds: string[];
  /** The plate's offset; its supports are drawn moved back by it. */
  offsetMm: { dxMm: number; dyMm: number };
}

type ScrubModel = PlateMember & { id: string; transform: { position: THREE.Vector3 } };

/**
 * The scope of the scrub preview for the plate the slice is of. The plate is
 * judged by the slice's own rule, `plateSliceScope`, so the preview covers the
 * models the slice does. An unknown plate reads as the first.
 */
export function scrubPreviewScope<M extends ScrubModel>({
  models,
  frames,
  plateId,
}: {
  models: readonly M[];
  frames: readonly PlateFrame[];
  plateId: string;
}): ScrubPreviewScope<M> {
  const frame = plateFrameFor({ frames, plateId });
  if (!frame) return { models: [...models], supportExcludeModelIds: [], offsetMm: { dxMm: 0, dyMm: 0 } };

  const { modelIds, offsetMm } = plateSliceScope({ frame, models, frames });
  const onPlate = new Set(modelIds);
  const { dxMm, dyMm } = offsetMm;
  const moved = dxMm === 0 && dyMm === 0
    ? models.filter((model) => onPlate.has(model.id))
    : models.filter((model) => onPlate.has(model.id)).map((model) => ({
        ...model,
        transform: {
          ...model.transform,
          position: model.transform.position.clone().add(new THREE.Vector3(-dxMm, -dyMm, 0)),
        },
      }));

  return {
    models: moved,
    supportExcludeModelIds: models.filter((model) => !onPlate.has(model.id)).map((model) => model.id),
    offsetMm,
  };
}

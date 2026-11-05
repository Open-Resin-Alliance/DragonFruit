/**
 * Where the plates are, and which plate a model stands on.
 *
 * Pure: the scene manager, the slice scopes and the CLI's `scene slice` all ask
 * here, so the three cannot disagree about where a bed is (ADR-0045). Inputs are
 * the narrowest shapes the rules read, which the app's `LoadedModel` and the
 * file's `VoxlModelEntry` both satisfy.
 */

import { plateCascadeOffsetMm, type PlateOrdering } from './plateCascade';

/** Where a plate's origin sits: its centre, or its front-left corner. */
export type PlateOriginMode = 'center' | 'front_left';

/** The printer's build footprint and the origin convention plates are drawn with. */
export interface PlateFootprint {
  widthMm: number;
  depthMm: number;
  originMode: PlateOriginMode;
}

/** A rect in the XY plane, in millimetres. */
export interface PlateRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type PlateFrame = PlateRect & {
  id: string;
  /** Position in the cascade, which is also its display order. */
  index: number;
  /** World offset from the first plate's frame. */
  dxMm: number;
  dyMm: number;
};

/** What the plate rules read from a model. */
export interface PlateMember {
  transform: { position: { x: number; y: number } };
  plateId?: string;
}

/**
 * One plate's build volume in its own frame, before the cascade offset: centred
 * on the origin, or starting at it for a front-left origin.
 */
export function plateLocalRect({ widthMm, depthMm, originMode }: PlateFootprint): PlateRect & { centerX: number; centerY: number } {
  const minX = originMode === 'front_left' ? 0 : -widthMm * 0.5;
  const minY = originMode === 'front_left' ? 0 : -depthMm * 0.5;
  return {
    minX,
    minY,
    maxX: minX + widthMm,
    maxY: minY + depthMm,
    centerX: minX + widthMm * 0.5,
    centerY: minY + depthMm * 0.5,
  };
}

/** Every plate's world rect and cascade offset, in display order. */
export function computePlateFrames({
  plates,
  footprint,
  ordering,
}: {
  plates: readonly { id: string }[];
  footprint: PlateFootprint;
  ordering: PlateOrdering;
}): PlateFrame[] {
  const local = plateLocalRect(footprint);
  return plates.map((plate, index) => {
    const { dxMm, dyMm } = plateCascadeOffsetMm(index, footprint, plates.length, ordering);
    return {
      id: plate.id,
      index,
      dxMm,
      dyMm,
      minX: local.minX + dxMm,
      minY: local.minY + dyMm,
      maxX: local.maxX + dxMm,
      maxY: local.maxY + dyMm,
    };
  });
}

/**
 * The plate a model stands on.
 *
 * Where it stands is what counts: every plate is a valid build volume, and a
 * model dragged from one bed to the next belongs to the bed it landed on. A
 * stored membership is only a hint, and it goes stale the moment a model is
 * moved, which is how a model sitting on plate two came to be reported as
 * outside the volume for not being on plate one.
 *
 * The hint is the fallback for a model that stands outside every plate, where
 * position cannot answer; then the first plate.
 */
export function resolveModelPlateId({
  model,
  frames,
}: {
  model: PlateMember;
  frames: readonly PlateFrame[];
}): string {
  const { x, y } = model.transform.position;
  const containing = frames.find(
    (frame) => x >= frame.minX && x <= frame.maxX && y >= frame.minY && y <= frame.maxY,
  );
  if (containing) return containing.id;
  if (model.plateId && frames.some((frame) => frame.id === model.plateId)) return model.plateId;
  return frames[0]?.id ?? '';
}

/**
 * `model` stamped with the plate it now stands on, or with `landedPlateId` when the
 * gesture already knows where it put it. Membership follows the model; with no
 * plate to name (no frames yet) it keeps the one it had.
 */
export function withPlateMembership<M extends PlateMember>({
  model,
  frames,
  landedPlateId,
}: {
  model: M;
  frames: readonly PlateFrame[];
  landedPlateId?: string;
}): M {
  const plateId = landedPlateId ?? resolveModelPlateId({ model, frames });
  return plateId ? { ...model, plateId } : model;
}

/** The models standing on a plate, in their original order. */
export function modelsOnPlate<M extends PlateMember>({
  models,
  plateId,
  frames,
}: {
  models: readonly M[];
  plateId: string;
  frames: readonly PlateFrame[];
}): M[] {
  return models.filter((model) => resolveModelPlateId({ model, frames }) === plateId);
}

/** What a slice of one plate covers: its models, its volume, and the shift that brings it to the origin. */
export interface PlateSliceScope {
  plateId: string;
  modelIds: string[];
  volumeBoundsMm: PlateRect;
  offsetMm: { dxMm: number; dyMm: number };
}

/**
 * The scope of a slice of one plate. A slice covers one plate, is judged against
 * that plate's volume and is shifted to the origin for the rasterizer.
 */
export function plateSliceScope<M extends PlateMember & { id: string }>({
  frame,
  models,
  frames,
}: {
  frame: PlateFrame;
  models: readonly M[];
  frames: readonly PlateFrame[];
}): PlateSliceScope {
  return {
    plateId: frame.id,
    modelIds: modelsOnPlate({ models, plateId: frame.id, frames }).map((model) => model.id),
    volumeBoundsMm: { minX: frame.minX, minY: frame.minY, maxX: frame.maxX, maxY: frame.maxY },
    offsetMm: { dxMm: frame.dxMm, dyMm: frame.dyMm },
  };
}

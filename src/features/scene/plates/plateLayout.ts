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
export function resolveModelPlateId(model: PlateMember, frames: readonly PlateFrame[]): string {
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
export function withPlateMembership<M extends PlateMember>(
  model: M,
  frames: readonly PlateFrame[],
  landedPlateId?: string,
): M {
  const plateId = landedPlateId ?? resolveModelPlateId(model, frames);
  return plateId ? { ...model, plateId } : model;
}

/** The models standing on a plate, in their original order. */
export function modelsOnPlate<M extends PlateMember>(
  models: readonly M[],
  plateId: string,
  frames: readonly PlateFrame[],
): M[] {
  return models.filter((model) => resolveModelPlateId(model, frames) === plateId);
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
export function plateSliceScope<M extends PlateMember & { id: string }>(
  frame: PlateFrame,
  models: readonly M[],
  frames: readonly PlateFrame[],
): PlateSliceScope {
  return {
    plateId: frame.id,
    modelIds: modelsOnPlate(models, frame.id, frames).map((model) => model.id),
    volumeBoundsMm: { minX: frame.minX, minY: frame.minY, maxX: frame.maxX, maxY: frame.maxY },
    offsetMm: { dxMm: frame.dxMm, dyMm: frame.dyMm },
  };
}

/** How far one model moves in a relayout, in millimetres. */
export interface PlateShift {
  dxMm: number;
  dyMm: number;
}

/**
 * How far each model moves when the beds are re-laid, by model id. Models that stay
 * put are left out, so an empty map means nothing moves.
 *
 * Plates are numbered by position, so adding or removing one can shuffle the plates
 * already placed. A model left where its bed used to be would quietly belong to
 * whichever plate now covers that spot, so each one moves by exactly how far its own
 * plate moved, matched by id: a bed taken out of the middle moves every one after it
 * a slot down. A bed that is gone takes its models with it, so they do not move. A
 * model on no plate stays where it was put: it was dragged off a bed deliberately.
 *
 * The beds are spaced by their own footprint, so the same shift applies when the
 * build volume or the ordering changes under them. `laidOut` and `wasOrdering` are
 * what the beds were placed with then, which is what the models' positions are
 * still measured against; each defaults to the current one.
 */
export function relaidPlateShifts({
  before,
  after,
  models,
  footprint,
  ordering,
  laidOut = footprint,
  wasOrdering = ordering,
}: {
  before: readonly { id: string }[];
  after: readonly { id: string }[];
  models: readonly (PlateMember & { id: string })[];
  footprint: PlateFootprint;
  ordering: PlateOrdering;
  laidOut?: PlateFootprint;
  wasOrdering?: PlateOrdering;
}): Map<string, PlateShift> {
  const shifts = new Map<string, PlateShift>();
  if (after.length <= 1) return shifts;

  const wasFrames = computePlateFrames({ plates: before, footprint: laidOut, ordering: wasOrdering });
  const nowFrames = new Map(
    computePlateFrames({ plates: after, footprint, ordering }).map((frame) => [frame.id, frame]),
  );
  const plateShifts = new Map<string, PlateShift>();
  for (const was of wasFrames) {
    const now = nowFrames.get(was.id);
    if (!now || (now.dxMm === was.dxMm && now.dyMm === was.dyMm)) continue;
    plateShifts.set(was.id, { dxMm: now.dxMm - was.dxMm, dyMm: now.dyMm - was.dyMm });
  }
  if (plateShifts.size === 0) return shifts;

  for (const model of models) {
    const { x, y } = model.transform.position;
    const frame = wasFrames.find(
      (candidate) => x >= candidate.minX && x <= candidate.maxX && y >= candidate.minY && y <= candidate.maxY,
    );
    const shift = frame ? plateShifts.get(frame.id) : undefined;
    if (shift) shifts.set(model.id, shift);
  }
  return shifts;
}

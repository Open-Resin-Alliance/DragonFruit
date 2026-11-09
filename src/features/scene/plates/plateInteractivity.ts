/**
 * Where a model stands, relative to the plate being worked on.
 *
 * Only the active plate's models are live, and a model you have selected: a model on
 * another bed is scenery until you go there or pick it up. That matters twice over —
 *
 * - **Cost.** Every model that answers the pointer costs a raycast on every pointer
 *   move: ~0.12 ms each with its boundsTree, flat (see
 *   `docs/dev/performance-debugging.md`). A scene of full plates would otherwise pay
 *   for every plate on every move.
 * - **Legibility.** A model on a bed you are not working on is drawn dimmed, to match
 *   the plate under it, so what you can act on is obvious.
 *
 * A model on no plate at all stays live and stays bright: it is out of bounds, and
 * dragging it back is the only way to fix it. A selected model on another bed is the
 * same bargain: it can be dragged on, so it cannot be scenery.
 *
 * One plate is not scoped — there is nowhere else for a model to be — so the
 * single-plate path behaves exactly as it always did.
 */

export type PlatePointerFrame = {
  id: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/** `active` — on the plate being worked on. `other` — on another bed. `loose` — on none. */
export type PlateScope = 'active' | 'other' | 'loose';

export function modelPlateScope({
  position,
  frames,
  activePlateId,
  plateCount,
}: {
  position: { x: number; y: number };
  frames: readonly PlatePointerFrame[];
  activePlateId: string | undefined;
  /** How many plates the scene has, which decides whether scoping applies at all. */
  plateCount: number;
}): PlateScope {
  if (plateCount <= 1 || frames.length === 0) return 'active';

  const frame = frames.find(
    (candidate) => position.x >= candidate.minX && position.x <= candidate.maxX
      && position.y >= candidate.minY && position.y <= candidate.maxY,
  );

  if (!frame) return 'loose';
  return frame.id === activePlateId ? 'active' : 'other';
}

/**
 * Whether a model answers the pointer.
 *
 * Every model but another bed's answers. The exception is a *selected* model: a drag
 * that lands on a bed which does not become the one being worked on — following the
 * landed plate is a setting, and it can be off — leaves the model selected and
 * standing on a bed that is now inactive, and a model that stops answering the
 * pointer cannot be dragged any further. The selection is what keeps the cost of the
 * exception bounded: one model answering, not every model on that bed.
 */
export function modelAnswersPointer(scope: PlateScope, selected: boolean): boolean {
  return scope !== 'other' || selected;
}

/**
 * Which bed a move should make the one being worked on, if any.
 *
 * A move that lands wholly on one plate is a drag onto that bed, so the view follows it.
 * A move spreading its models over several plates says nothing about which to work on,
 * and neither does one that put nothing on a bed at all, so both leave the active plate
 * where it was. `followLandedPlate` is the Multi-Plate setting that turns the following
 * itself off, for anyone who would rather a drop never move them.
 *
 * `explicitPlateId` is for a caller that made the landing itself, in the same step: the
 * plate list its render still holds does not include a bed created moments ago.
 */
export function followedPlateIdForMove({
  followLandedPlate,
  explicitPlateId,
  landedPlateIds,
}: {
  followLandedPlate: boolean;
  explicitPlateId?: string | null;
  landedPlateIds: ReadonlySet<string>;
}): string | null {
  if (!followLandedPlate) return null;
  if (explicitPlateId) return explicitPlateId;
  if (landedPlateIds.size !== 1) return null;
  return [...landedPlateIds][0] ?? null;
}

/**
 * How far a model on another bed — and the supports and raft under it — is dimmed from
 * its own colour. Multiplied into the colour rather than made translucent, so a dimmed
 * model still reads as solid and does not sort against the ones behind it.
 */
export const SCENERY_DIM = 0.4;

/**
 * The models the scene draws as scenery: on another bed, and not selected.
 *
 * One set covers both halves of the rule, because a model here is dimmed *and* answers no
 * pointer, and the selected exception applies to both: a drag that lands on a bed which
 * does not become the one being worked on leaves the model selected there, and a model
 * that stopped answering the pointer could not be dragged any further. Supports and rafts
 * ask the same question through [`supportAnswersPointer`], so a model's scaffolding is
 * scoped wherever the model itself is.
 */
export function sceneryModelIds({
  models,
  frames,
  activePlateId,
  plateCount,
  selectedModelIds,
}: {
  models: readonly { id: string; transform: { position: { x: number; y: number } } }[];
  frames: readonly PlatePointerFrame[];
  activePlateId: string | undefined;
  plateCount: number;
  selectedModelIds: readonly string[];
}): ReadonlySet<string> {
  if (plateCount <= 1 || frames.length === 0) return EMPTY_MODEL_IDS;
  const selected = new Set(selectedModelIds);
  const scenery = new Set<string>();
  for (const model of models) {
    if (selected.has(model.id)) continue;
    const scope = modelPlateScope({
      position: model.transform.position,
      frames,
      activePlateId,
      plateCount,
    });
    if (scope === 'other') scenery.add(model.id);
  }
  return scenery.size > 0 ? scenery : EMPTY_MODEL_IDS;
}

/** One shared empty set, so a single-plate scene allocates nothing per render. */
const EMPTY_MODEL_IDS: ReadonlySet<string> = new Set<string>();

/**
 * Whether a support primitive answers the pointer, given the model it belongs to.
 *
 * A support with no model — a loose one, or a preview being placed — stays live, the way a
 * model standing on no bed does.
 */
export function supportAnswersPointer(
  modelId: string | undefined,
  scenery: ReadonlySet<string> | undefined,
): boolean {
  if (modelId === undefined || !scenery || scenery.size === 0) return true;
  return !scenery.has(modelId);
}

/** An axis-aligned rect in world XY: a bed's build volume, or a footprint on it. */
export type PlateRect = { minX: number; minY: number; maxX: number; maxY: number };

/**
 * Whether a footprint stands on one of the beds, which is what "on a plate" means.
 *
 * A model between two beds, or beyond the last one, stands on none of them. Asking the bed
 * being worked on instead reads every model on any other bed as off-plate, and in a
 * multi-plate scene that is every model sitting exactly where the file put it. Touching a
 * bed's edge counts, matching the plate frames the rest of the scene uses.
 */
export function rectStandsOnAnyBed(rect: PlateRect, beds: readonly PlateRect[]): boolean {
  return beds.some((bed) => (
    rect.minX >= bed.minX
    && rect.maxX <= bed.maxX
    && rect.minY >= bed.minY
    && rect.maxY <= bed.maxY
  ));
}

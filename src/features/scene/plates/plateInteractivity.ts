/**
 * Where a model stands, relative to the plate being worked on.
 *
 * Only the active plate's models are live: a model on another bed is scenery until
 * you go there. That matters twice over —
 *
 * - **Cost.** Every model that answers the pointer costs a raycast on every pointer
 *   move: ~0.12 ms each with its boundsTree, flat (see
 *   `docs/dev/performance-debugging.md`). A scene of full plates would otherwise pay
 *   for every plate on every move.
 * - **Legibility.** A model on a bed you are not working on is drawn dimmed, to match
 *   the plate under it, so what you can act on is obvious.
 *
 * A model on no plate at all stays live and stays bright: it is out of bounds, and
 * dragging it back is the only way to fix it.
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

/** Whether a model answers the pointer: everything except another bed's models. */
export function modelAnswersPointer(args: Parameters<typeof modelPlateScope>[0]): boolean {
  return modelPlateScope(args) !== 'other';
}

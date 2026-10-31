/**
 * The offset a `FollowModelMove` group applies, and the handoff that keeps it
 * from snapping when a drag ends.
 *
 * A drag moves the model's Object3D imperatively and publishes the live
 * transform; the React prop (`base`) stays at the pre-drag transform until the
 * gesture's commit lands. On release the live transform disappears immediately,
 * so a plain "offset = live − base" drops to zero for the frame(s) before the
 * commit re-renders the base — the outline jumps back to where the drag began
 * and then forward again.
 *
 * The handoff keeps the last live position until `base` has caught up with it.
 * It is bounded by frames because a cancelled gesture never updates `base`: at
 * that point the model itself is back at the old transform, and the helper must
 * let go rather than leave the helper stuck at the abandoned position forever.
 */

export type FollowXY = { x: number; y: number };

export type FollowHandoffState = {
  /** Last position the imperative drag reported; null when no handoff is pending. */
  tracked: FollowXY | null;
  /** Frames since the live transform disappeared. */
  framesSinceRelease: number;
};

/** How long a released drag may outlive the live map while the commit lands. */
export const FOLLOW_HANDOFF_MAX_FRAMES = 8;

/** Positions closer than this are the same place (mm). */
const SAME_POINT_MM = 1e-4;

export function stepFollowHandoff(
  live: FollowXY | null,
  base: FollowXY,
  state: FollowHandoffState,
): { state: FollowHandoffState; offset: FollowXY } {
  const tracked = live ?? state.tracked;
  if (!tracked) {
    return { state: { tracked: null, framesSinceRelease: 0 }, offset: { x: 0, y: 0 } };
  }

  const offset = { x: tracked.x - base.x, y: tracked.y - base.y };
  if (live) {
    return { state: { tracked, framesSinceRelease: 0 }, offset };
  }

  const caughtUp = Math.abs(offset.x) < SAME_POINT_MM && Math.abs(offset.y) < SAME_POINT_MM;
  const framesSinceRelease = state.framesSinceRelease + 1;
  if (caughtUp || framesSinceRelease > FOLLOW_HANDOFF_MAX_FRAMES) {
    return { state: { tracked: null, framesSinceRelease: 0 }, offset: { x: 0, y: 0 } };
  }
  return { state: { tracked, framesSinceRelease }, offset };
}

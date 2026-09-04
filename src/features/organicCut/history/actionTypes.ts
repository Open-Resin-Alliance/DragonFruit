import type { OrganicCutLoopPoint } from '../types';
import type { CutSettings, LoopTenonSettings } from '../useOrganicCutSession';

export const ORGANIC_CUT_EDIT = 'organic-cut:edit' as const;

/**
 * One loop as the history stores it: the editable waypoints plus that loop's tenon
 * settings. The cached dense seam polyline is deliberately NOT kept — it is
 * derived from the points and recomputed on restore, so storing it would bloat
 * every entry with a Float32Array for no gain.
 */
export type OrganicCutLoopSnapshot = {
  points: OrganicCutLoopPoint[];
  tenon: LoopTenonSettings;
};

/**
 * Every Cut-tool edit is one action type carrying a before/after snapshot of the
 * whole loop set.
 *
 * A snapshot rather than a per-action delta because the tool has many small
 * mutations — place, move, delete, lock, snap-to-edges, add/remove loop, retarget
 * the tenon — and each one needs its own inverse. Wiring them individually is how
 * they came to be missing from undo one at a time. With a snapshot the inverse is
 * the same code for all of them, and an edit added later is covered by
 * construction rather than by remembering.
 */
export type OrganicCutEditPayload = {
  /** Model the edit belongs to; an edit never applies to a different model. */
  modelId: string;
  before: OrganicCutLoopSnapshot[];
  beforeActive: number;
  after: OrganicCutLoopSnapshot[];
  afterActive: number;
  /**
   * The cut-wide settings (mode, thickness, smoothing, resolution) as they were
   * on each side of the edit. They live beside the loops for the same reason the
   * loops are snapshotted whole: they shape the cut just as much as the seam
   * does, and wiring them one at a time is what left thickness out of undo.
   */
  beforeSettings: CutSettings;
  afterSettings: CutSettings;
};

/** Action→payload map for the organic-cut history domain. */
export type OrganicCutHistoryPayloadMap = {
  [ORGANIC_CUT_EDIT]: OrganicCutEditPayload;
};

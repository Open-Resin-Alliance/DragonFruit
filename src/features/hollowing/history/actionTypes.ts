export const HOLLOWING_BLOCKERS_EDIT = 'hollowing:blockers-edit' as const;

/**
 * One blocker edit — a click, a lasso, an Alt+lasso or Clear — as the model's
 * sorted blocked-voxel indices before and after it.
 */
export type HollowingBlockersEditPayload = {
  modelId: string;
  before: number[];
  after: number[];
};

/** Action→payload map for the hollowing history domain. */
export type HollowingHistoryPayloadMap = {
  [HOLLOWING_BLOCKERS_EDIT]: HollowingBlockersEditPayload;
};

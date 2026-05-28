export const PAINT_ROI_ADD = 'PAINT_ROI_ADD' as const;
export const PAINT_ROI_REMOVE = 'PAINT_ROI_REMOVE' as const;
export const PAINT_ROI_STRIP = 'PAINT_ROI_STRIP' as const;

export type PaintRoiHistoryActionType =
  | typeof PAINT_ROI_ADD
  | typeof PAINT_ROI_REMOVE
  | typeof PAINT_ROI_STRIP;


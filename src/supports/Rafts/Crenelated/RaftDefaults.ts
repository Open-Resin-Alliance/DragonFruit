import { RaftSettings } from './RaftTypes';

export const DEFAULT_RAFT_SETTINGS: RaftSettings = {
  bottomMode: 'solid',
  wallEnabled: true,
  thickness: 0.5,           // 0.5mm default
  chamferAngle: 45,         // 45 degrees default
  wallHeight: 0.35,         // 0.35mm default
  wallThickness: 0.5,       // 0.5mm default
  crenulationGapWidth: 1.5, // 1.5mm (not used in UI, kept for compatibility)
  crenulationSpacing: 5.0,  // 5.0mm (not used in UI, kept for compatibility)
  lineWidthMm: 1.5,
  lineHeightMm: 0.6,
  showFootprintBorder: true, // Show footprint border by default
  footprintBorderMargin: 0.5, // max 0.05mm margin beyond raft/model edge
};

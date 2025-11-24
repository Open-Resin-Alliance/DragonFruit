import { RaftSettings } from './RaftTypes';

export const DEFAULT_RAFT_SETTINGS: RaftSettings = {
  enabled: true,
  thickness: 0.5,           // 0.5mm default
  chamferAngle: 45,         // 45 degrees default
  wallHeight: 0.35,         // 0.35mm default
  wallThickness: 0.5,       // 0.5mm default
  crenulationGapWidth: 1.5, // 1.5mm (not used in UI, kept for compatibility)
  crenulationSpacing: 5.0,  // 5.0mm (not used in UI, kept for compatibility)
  showFootprintBorder: true, // Show footprint border by default
  footprintBorderMargin: 1.0, // 1.0mm margin beyond raft/model edge
};

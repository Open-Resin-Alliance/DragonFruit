export type {
  CandidatePoint,
  AutoPlaceResult,
  AutoPlaceAnalytics,
  SizingDebugInfo,
  RejectReason,
  ForestReport,
  ForestTree,
  ForestLedgerEntry,
} from "./types";

export {
  AUTO_SUPPORT_CONSTRAINTS,
  createDefaultAutoSupportSettings,
  normalizeAutoSupportSettings,
  applyAutoSupportSettingsPatch,
} from "./settings";
export type { AutoSupportSettings } from "./settings";

export {
  generateCandidates,
  deduplicateCandidates,
  candidateFromIsland,
} from "./candidateGeneration";

export { sizeParameters } from "./parameterSizing";
export type { SizeOverrides } from "./parameterSizing";

export { runAutoPlace, forestReportToText } from "./autoPlace";
export { setModelMesh, getModelMesh } from "./meshStore";

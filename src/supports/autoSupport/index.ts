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
export type { AutoSupportSettings, NumericConstraint, NumericAutoSupportSettingKey } from "./settings";

export {
  generateCandidates,
  deduplicateCandidates,
  candidateFromIsland,
  candidatesFromIsland,
} from "./candidateGeneration";

export { sizeParameters } from "./parameterSizing";
export type { SizeOverrides } from "./parameterSizing";

export { runAutoPlace, commitAutoPlacePlan, forestReportToText } from "./autoPlace";
export { runAutoPlaceInWorker } from "./autoPlaceWorkerClient";
export { setModelMesh, getModelMesh } from "./meshStore";

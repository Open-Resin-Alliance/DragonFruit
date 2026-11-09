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
  SIZING_BANDS,
  DIAGNOSTIC_AUTO_SUPPORT_KEYS,
  createDefaultAutoSupportSettings,
  normalizeAutoSupportSettings,
  applyAutoSupportSettingsPatch,
  migrateLegacySizingPreset,
} from "./settings";
export type {
  AutoSupportSettings,
  AutoSupportDiagnosticKey,
  NumericConstraint,
  NumericAutoSupportSettingKey,
  SizingBand,
  SizingPreset,
} from "./settings";

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

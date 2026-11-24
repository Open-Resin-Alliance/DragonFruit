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

export { runAutoPlace, commitAutoPlacePlan, forestReportToText, syncContactConeDiameters } from "./autoPlace";
export { runAutoPlaceInWorker } from "./autoPlaceWorkerClient";
export { setModelMesh, getModelMesh, subscribeModelMesh } from "./meshStore";
export { extractRepresentativeLayers } from "./tractionOptimization";
export type { RepresentativeLayer, RepresentativeLayerProfile } from "./tractionOptimization";
export type { LayerAreaSample, LayerGrowth, LayerGrowthGrid } from "./tractionOptimization";
export {
  buildSupportGraph,
  solveSupportFrameStress,
  reinforceOverloadedFrameMembers,
  computePeelLayerSamples,
  GREEN_RESIN_UTS_MPA,
  type PeelLayerSample,
  type ReinforceFrameMembersResult,
  type SupportFrameStressReport,
  type FrameStressHotspot,
  type LayerPeelPoint,
  type StressSegment,
  type StressTipPoint,
} from "./supportGraphStress";
export {
  getFrameStressSnapshot,
  subscribeFrameStress,
  setModelFrameStress,
  setModelPrintability,
  setModelToppleRisk,
  clearModelToppleRisk,
  clearModelFrameStress,
  clearModelPrintability,
  getStressOverlayEnabled,
  setStressOverlayEnabled,
  getHoveredStressLayerZ,
  setHoveredStressLayerZ,
  subscribeHoveredStressLayerZ,
  getCachedRepresentativeLayers,
  type FrameStressStoreSnapshot,
} from "./frameStressState";
export {
  evaluateToppleRisk,
  classifyToppleRisk,
  toppleRiskNeedsCoverage,
  ROCKING_THRESHOLD_MM,
  TOPPLE_ADHESION_THRESHOLD_MPA,
  type ToppleEdge,
  type ToppleOutcome,
  type ToppleRiskInput,
  type ToppleRiskReport,
} from "./toppleRisk";
export {
  evaluatePrintability,
  MAX_FREE_SPAN_MM,
  HIGH_LEVERAGE_SPAN_MM,
  type PeelOverlay,
  type PrintabilityInput,
  type PrintabilityRegion,
  type PrintabilityReport,
  type PrintabilitySeverity,
  type PrintabilityVerdict,
} from "./printability";
export {
  FLOATING_Z_THRESHOLD_MM,
  summarizeSupportStress,
  supportStressReportToText,
  type SupportStressPrimaryIssue,
  type SupportStressReportInput,
  type SupportStressStatusLevel,
  type SupportStressSummary,
} from "./supportStressReport";

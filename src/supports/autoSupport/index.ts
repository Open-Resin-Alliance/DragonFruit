export type {
  CandidatePoint,
  TreeCluster,
  SupportPlan,
  AutoPlaceResult,
} from "./types";

export {
  AUTO_SUPPORT_CONSTRAINTS,
  AUTO_SUPPORT_HARD_RULES,
  createDefaultAutoSupportSettings,
  normalizeAutoSupportSettings,
  applyAutoSupportSettingsPatch,
} from "./settings";
export type { AutoSupportSettings } from "./settings";

export {
  generateCandidates,
  deduplicateCandidates,
  candidateFromIsland,
  estimateOverhangAngle,
} from "./candidateGeneration";

export {
  planSupportTree,
  clusterCandidates,
  selectCoreCandidate,
  computeCandidateDistance,
} from "./treeFanOut";

export { sizeParameters } from "./parameterSizing";
export type { SizeOverrides } from "./parameterSizing";

export { runAutoPlace } from "./autoPlace";
export { AutoSupportSettingsCard } from "./AutoSupportSettingsCard";

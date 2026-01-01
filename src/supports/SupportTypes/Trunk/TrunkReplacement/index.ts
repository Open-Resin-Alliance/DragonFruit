import type { PlanTrunkReplacementArgs, TrunkReplacementPlannerResult } from './types';

export type {
    PlanTrunkReplacementArgs,
    TrunkReplacementMode,
    TrunkReplacementCandidate,
    TrunkReplacementPlannerResult,
    TrunkReplacementPlan,
    TrunkReplacementPlanMeta,
} from './types';

export { planTrunkReplacement } from './planTrunkReplacement';

export { applyTrunkReplacement } from './applyTrunkReplacement';

export { applyDiameterToTrunk, computeAndApplyTrunkDiameterProfile, computeMaxConnectedDiameterFromTrunk } from './maxConnectedDiameter';

export type PlanTrunkReplacement = (args: PlanTrunkReplacementArgs) => TrunkReplacementPlannerResult | null;

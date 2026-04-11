export { SDFCache } from './SDFCache';
export type { SDFCacheOptions, SDFQuery } from './SDFCache';

export { SupportOccupancy } from './SupportOccupancy';
export type { OccupancyOptions } from './SupportOccupancy';

export { gridAStar } from './GridAStar';
export type { GridAStarOptions, GridAStarResult, WarmStartState } from './GridAStar';

export {
    calculateSmartPlacementV2,
    getOrCreateSDFCache,
    clearSDFCacheForMesh,
    clearAllSDFCaches,
    clearWarmStart,
    clearAllWarmStarts,
    clearStagnationCache,
} from './SmartPlacementV2';
export type { SmartPlacementV2Input, SmartPlacementV2Context } from './SmartPlacementV2';

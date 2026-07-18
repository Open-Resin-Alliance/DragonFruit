import type { AutoSupportPlannerSettings, AutoSupportPreset } from './types';

export const AUTO_SUPPORT_PRESETS: Record<AutoSupportPreset, AutoSupportPlannerSettings> = {
  light: {
    contactSpacingMm: 9,
    minBaseAreaMm2: 0.12,
    minVolumeMm3: 2.5,
    minHeightMm: 0.5,
    maxContactsPerVolume: 3,
    maxTotalContacts: 55,
    surfaceSearchRadiusMm: 1.2,
    routeAttemptsPerContact: 5,
  },
  normal: {
    contactSpacingMm: 7,
    minBaseAreaMm2: 0.06,
    minVolumeMm3: 1,
    minHeightMm: 0.3,
    maxContactsPerVolume: 5,
    maxTotalContacts: 90,
    surfaceSearchRadiusMm: 1.5,
    routeAttemptsPerContact: 7,
  },
  heavy: {
    contactSpacingMm: 5,
    minBaseAreaMm2: 0.025,
    minVolumeMm3: 0.35,
    minHeightMm: 0.15,
    maxContactsPerVolume: 8,
    maxTotalContacts: 150,
    surfaceSearchRadiusMm: 2,
    routeAttemptsPerContact: 9,
  },
};

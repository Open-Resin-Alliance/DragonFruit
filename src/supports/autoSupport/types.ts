import type { LimitationCode, Roots, Stick, Trunk } from '@/supports/types';
import type { SupportData } from '@/supports/rendering/SupportBuilder';

export type AutoSupportPreset = 'light' | 'normal' | 'heavy';

export interface AutoSupportPlannerSettings {
  contactSpacingMm: number;
  minBaseAreaMm2: number;
  minVolumeMm3: number;
  minHeightMm: number;
  maxContactsPerVolume: number;
  maxTotalContacts: number;
  surfaceSearchRadiusMm: number;
  routeAttemptsPerContact: number;
  /** Faces with world normal z at or below this get surface-fill supports. */
  overhangNormalZMax: number;
  maxSurfaceContacts: number;
}

export interface UnsupportedVolume {
  id: number;
  firstLayer: number;
  lastLayer: number;
  heightMm: number;
  baseAreaMm2: number;
  volumeMm3: number;
  basePixels: Array<{ x: number; y: number }>;
}

export interface AutoSupportContactCandidate {
  id: string;
  volumeId: number;
  position: { x: number; y: number; z: number };
}

export interface AutoSupportExclusion {
  x: number;
  y: number;
  z: number;
  radiusMm: number;
}

export interface AutoSupportContactPlan {
  volumes: UnsupportedVolume[];
  contacts: AutoSupportContactCandidate[];
  ignoredVolumeIds: number[];
  limitedVolumeIds: number[];
  coveredVolumeIds: number[];
}

export type PlannedAutoSupport =
  | {
    kind: 'trunk';
    contact: AutoSupportContactCandidate;
    root: Roots;
    trunk: Trunk;
    supportData: SupportData;
  }
  | {
    kind: 'stick';
    contact: AutoSupportContactCandidate;
    stick: Stick;
    supportData: SupportData;
  };

export type AutoSupportRouteFailureReason = 'no_surface' | 'tip_spacing' | LimitationCode;

export interface AutoSupportRouteFailure {
  contactId: string;
  volumeId: number;
  reason: AutoSupportRouteFailureReason;
}

export interface AutoSupportPlanPreview {
  preset: AutoSupportPreset;
  supports: PlannedAutoSupport[];
  eligibleVolumeCount: number;
  ignoredVolumeCount: number;
  coveredVolumeCount: number;
  unresolvedVolumeIds: number[];
  attemptedContactCount: number;
  failureReasonCounts: Partial<Record<AutoSupportRouteFailureReason, number>>;
}

export interface AutoSupportProgress {
  phase: 'scan' | 'plan' | 'route' | 'verify';
  completed: number;
  total: number;
}

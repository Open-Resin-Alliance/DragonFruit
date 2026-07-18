import * as THREE from 'three';
import type { ScanResults } from '@/volumeAnalysis/IslandScan/ScanOrchestrator';
import { buildVolumeHierarchy } from '@/volumeAnalysis/IslandVolumes/buildVolumeHierarchy';
import type { BuildVolumeHierarchyResult } from '@/volumeAnalysis/IslandVolumes/types';
import { planAutoSupportContacts } from './contactPlanner';
import { AUTO_SUPPORT_PRESETS } from './presets';
import { routeAutoSupportContacts } from './routePlanner';
import type {
  AutoSupportExclusion,
  AutoSupportPlanPreview,
  AutoSupportPlannerSettings,
  AutoSupportPreset,
  AutoSupportProgress,
  AutoSupportRouteFailure,
  PlannedAutoSupport,
} from './types';

type Point = { x: number; y: number; z: number };

export interface AutoSupportRunArgs {
  scan: ScanResults;
  scanMinZ: number;
  layerHeightMm: number;
  preset: AutoSupportPreset;
  modelId: string;
  mesh: THREE.Mesh;
  settings?: AutoSupportPlannerSettings;
  hierarchy?: BuildVolumeHierarchyResult;
  existingTipPoints?: Point[];
  signal?: AbortSignal;
  onProgress?: (progress: AutoSupportProgress) => void;
  routeContacts?: typeof routeAutoSupportContacts;
}

function plannedTipPoint(support: PlannedAutoSupport): Point | null {
  const pos = support.trunk.contactCone?.pos;
  return pos ? { x: pos.x, y: pos.y, z: pos.z } : null;
}

function toExclusions(points: Point[], radiusMm: number): AutoSupportExclusion[] {
  return points.map((point) => ({ ...point, radiusMm }));
}

function countFailureReasons(failures: AutoSupportRouteFailure[]): AutoSupportPlanPreview['failureReasonCounts'] {
  const counts: AutoSupportPlanPreview['failureReasonCounts'] = {};
  for (const failure of failures) counts[failure.reason] = (counts[failure.reason] ?? 0) + 1;
  return counts;
}

export async function runAutoSupportPlan(args: AutoSupportRunArgs): Promise<AutoSupportPlanPreview> {
  const settings = args.settings ?? AUTO_SUPPORT_PRESETS[args.preset];
  const routeContacts = args.routeContacts ?? routeAutoSupportContacts;
  const existingTips = args.existingTipPoints ?? [];
  const hierarchy = args.hierarchy ?? buildVolumeHierarchy(args.scan);

  args.onProgress?.({ phase: 'plan', completed: 0, total: 1 });
  const plan = planAutoSupportContacts({
    scan: args.scan,
    scanMinZ: args.scanMinZ,
    layerHeightMm: args.layerHeightMm,
    settings,
    hierarchy,
    exclusions: toExclusions(existingTips, settings.contactSpacingMm),
  });
  args.onProgress?.({ phase: 'plan', completed: 1, total: 1 });

  const existingTipVectors = existingTips.map((point) => new THREE.Vector3(point.x, point.y, point.z));
  const firstWave = await routeContacts({
    contacts: plan.contacts,
    settings,
    modelId: args.modelId,
    mesh: args.mesh,
    existingTipPoints: existingTipVectors,
    signal: args.signal,
    onProgress: args.onProgress,
    progressPhase: 'route',
  });

  const supports = [...firstWave.supports];
  const failures = [...firstWave.failures];
  let attemptedContactCount = plan.contacts.length;

  const routedVolumeIds = new Set(supports.map((support) => support.contact.volumeId));
  const coveredVolumeIds = new Set(plan.coveredVolumeIds);
  const eligibleVolumeIds = plan.volumes
    .map((volume) => volume.id)
    .filter((id) => !plan.ignoredVolumeIds.includes(id) && !coveredVolumeIds.has(id));
  const unresolvedAfterFirstWave = new Set(eligibleVolumeIds.filter((id) => !routedVolumeIds.has(id)));
  const remainingContactBudget = settings.maxTotalContacts - plan.contacts.length;

  if (unresolvedAfterFirstWave.size > 0 && remainingContactBudget > 0) {
    const routedTips = supports
      .map(plannedTipPoint)
      .filter((point): point is Point => point !== null);
    const retryPlan = planAutoSupportContacts({
      scan: args.scan,
      scanMinZ: args.scanMinZ,
      layerHeightMm: args.layerHeightMm,
      settings: { ...settings, maxTotalContacts: remainingContactBudget },
      hierarchy,
      exclusions: [
        ...toExclusions(existingTips, settings.contactSpacingMm),
        ...toExclusions(routedTips, settings.contactSpacingMm),
        ...plan.contacts
          .filter((contact) => unresolvedAfterFirstWave.has(contact.volumeId))
          .map((contact) => ({ ...contact.position, radiusMm: settings.contactSpacingMm * 0.5 })),
      ],
      volumeIdFilter: unresolvedAfterFirstWave,
      contactIdSuffix: ':retry',
    });

    if (retryPlan.contacts.length > 0) {
      const secondWave = await routeContacts({
        contacts: retryPlan.contacts,
        settings,
        modelId: args.modelId,
        mesh: args.mesh,
        existingTipPoints: [
          ...existingTipVectors,
          ...routedTips.map((point) => new THREE.Vector3(point.x, point.y, point.z)),
        ],
        signal: args.signal,
        onProgress: args.onProgress,
        progressPhase: 'verify',
      });
      supports.push(...secondWave.supports);
      failures.push(...secondWave.failures);
      attemptedContactCount += retryPlan.contacts.length;
      for (const support of secondWave.supports) routedVolumeIds.add(support.contact.volumeId);
    }
  }

  const unresolvedVolumeIds = eligibleVolumeIds
    .filter((id) => !routedVolumeIds.has(id))
    .sort((left, right) => left - right);

  return {
    preset: args.preset,
    supports,
    eligibleVolumeCount: eligibleVolumeIds.length,
    ignoredVolumeCount: plan.ignoredVolumeIds.length,
    coveredVolumeCount: plan.coveredVolumeIds.length,
    unresolvedVolumeIds,
    attemptedContactCount,
    failureReasonCounts: countFailureReasons(failures),
  };
}

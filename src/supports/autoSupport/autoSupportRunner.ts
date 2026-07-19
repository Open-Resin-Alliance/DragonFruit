import * as THREE from 'three';
import { getSettings as getSupportSettings } from '@/supports/Settings/state';
import type { ScanResults } from '@/volumeAnalysis/IslandScan/ScanOrchestrator';
import { buildVolumeHierarchy } from '@/volumeAnalysis/IslandVolumes/buildVolumeHierarchy';
import type { BuildVolumeHierarchyResult } from '@/volumeAnalysis/IslandVolumes/types';
import { planAutoSupportContacts } from './contactPlanner';
import { AUTO_SUPPORT_PRESETS } from './presets';
import { routeAutoSupportContacts } from './routePlanner';
import { sampleOverhangContacts } from './overhangSampler';
import { routeStickFallback } from './stickFallback';
import type {
  AutoSupportContactCandidate,
  AutoSupportExclusion,
  AutoSupportPlanPreview,
  AutoSupportPlannerSettings,
  AutoSupportPreset,
  AutoSupportProgress,
  AutoSupportRouteFailure,
  PlannedAutoSupport,
} from './types';

type Point = { x: number; y: number; z: number };

const RETRY_MAX_EXPANSIONS = 8000;

// Slimmed support geometry for tiny detail features (claw tips, spikes) in
// spots where full-size shafts and contact cones cannot clear the model.
const DETAIL_OVERRIDES = {
  shaftDiameterMm: 0.6,
  rootsDiameterMm: 2,
  tipContactDiameterMm: 0.2,
  tipBodyDiameterMm: 0.6,
  tipLengthMm: 1.2,
};

// Heavy volumes (a gun, a torso overhang) load their supports far more than a
// claw tip does; scale up from the user's configured sizes rather than
// replacing them.
function structuralOverrides() {
  const settings = getSupportSettings();
  return {
    shaftDiameterMm: settings.shaft.diameterMm * 1.5,
    rootsDiameterMm: settings.roots.diameterMm * 1.25,
    tipContactDiameterMm: settings.tip.contactDiameterMm * 1.5,
    tipBodyDiameterMm: settings.tip.bodyDiameterMm * 1.25,
  };
}

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
  routeSticks?: typeof routeStickFallback;
  sampleSurface?: typeof sampleOverhangContacts;
}

function plannedTipPoints(support: PlannedAutoSupport): Point[] {
  const positions = support.kind === 'trunk'
    ? [support.trunk.contactCone?.pos]
    : [support.stick.contactConeA.pos, support.stick.contactConeB.pos];
  return positions
    .filter((pos): pos is NonNullable<typeof pos> => pos !== undefined)
    .map((pos) => ({ x: pos.x, y: pos.y, z: pos.z }));
}

function toExclusions(points: Point[], radiusMm: number): AutoSupportExclusion[] {
  return points.map((point) => ({ ...point, radiusMm }));
}

function countFailureReasons(failures: AutoSupportRouteFailure[]): AutoSupportPlanPreview['failureReasonCounts'] {
  const counts: AutoSupportPlanPreview['failureReasonCounts'] = {};
  for (const failure of failures) counts[failure.reason] = (counts[failure.reason] ?? 0) + 1;
  return counts;
}

/**
 * Route a fixed contact set through the full rescue ladder: plate trunks,
 * on-model sticks, then both again at detail size. Used for verification
 * repair rounds, where contacts come from a re-scan rather than volumes.
 */
export async function routeRepairSupports(args: {
  contacts: AutoSupportContactCandidate[];
  settings: AutoSupportPlannerSettings;
  modelId: string;
  mesh: THREE.Mesh;
  existingTipPoints?: Point[];
  signal?: AbortSignal;
  onProgress?: (progress: AutoSupportProgress) => void;
  routeContacts?: typeof routeAutoSupportContacts;
  routeSticks?: typeof routeStickFallback;
}): Promise<PlannedAutoSupport[]> {
  const routeContacts = args.routeContacts ?? routeAutoSupportContacts;
  const routeSticks = args.routeSticks ?? routeStickFallback;
  const supports: PlannedAutoSupport[] = [];
  let pending = args.contacts;
  // Verification has already proven nearby tips are not covering these
  // regions, so repair routes with a much tighter spacing floor than the
  // preset's aesthetic spacing, and casts a wider net for usable surface.
  const settings = {
    ...args.settings,
    contactSpacingMm: Math.min(args.settings.contactSpacingMm, 2),
    surfaceSearchRadiusMm: args.settings.surfaceSearchRadiusMm * 2,
  };
  const tipVectors = () => [
    ...(args.existingTipPoints ?? []),
    ...supports.flatMap(plannedTipPoints),
  ].map((point) => new THREE.Vector3(point.x, point.y, point.z));
  const stages: Array<(contacts: AutoSupportContactCandidate[]) => Promise<{ supports: PlannedAutoSupport[]; failures: AutoSupportRouteFailure[] }>> = [
    (contacts) => routeContacts({
      contacts, settings, modelId: args.modelId, mesh: args.mesh,
      existingTipPoints: tipVectors(), signal: args.signal, onProgress: args.onProgress,
      progressPhase: 'verify', maxExpansions: RETRY_MAX_EXPANSIONS,
    }),
    (contacts) => routeSticks({
      contacts, settings, modelId: args.modelId, mesh: args.mesh,
      existingTipPoints: tipVectors(), signal: args.signal, onProgress: args.onProgress,
    }),
    (contacts) => routeContacts({
      contacts, settings, modelId: args.modelId, mesh: args.mesh,
      existingTipPoints: tipVectors(), signal: args.signal, onProgress: args.onProgress,
      progressPhase: 'verify', maxExpansions: RETRY_MAX_EXPANSIONS, overrides: DETAIL_OVERRIDES,
    }),
    (contacts) => routeSticks({
      contacts, settings, modelId: args.modelId, mesh: args.mesh,
      existingTipPoints: tipVectors(), signal: args.signal, onProgress: args.onProgress,
      overrides: DETAIL_OVERRIDES,
    }),
  ];
  for (const stage of stages) {
    if (pending.length === 0) break;
    const wave = await stage(pending);
    supports.push(...wave.supports);
    const failedIds = new Set(wave.failures
      .filter((failure) => failure.reason !== 'tip_spacing')
      .map((failure) => failure.contactId));
    pending = pending.filter((contact) => failedIds.has(contact.id));
  }
  return supports;
}

export async function runAutoSupportPlan(args: AutoSupportRunArgs): Promise<AutoSupportPlanPreview> {
  const settings = args.settings ?? AUTO_SUPPORT_PRESETS[args.preset];
  const routeContacts = args.routeContacts ?? routeAutoSupportContacts;
  const routeSticks = args.routeSticks ?? routeStickFallback;
  const sampleSurface = args.sampleSurface ?? sampleOverhangContacts;
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
  const structuralVolumeIds = new Set(plan.volumes
    .filter((volume) => volume.volumeMm3 >= settings.structuralVolumeMm3)
    .map((volume) => volume.id));
  const standardContacts = plan.contacts.filter((contact) => !structuralVolumeIds.has(contact.volumeId));
  const structuralContacts = plan.contacts.filter((contact) => structuralVolumeIds.has(contact.volumeId));

  const firstWave = await routeContacts({
    contacts: standardContacts,
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

  if (structuralContacts.length > 0) {
    const structuralWave = await routeContacts({
      contacts: structuralContacts,
      settings,
      modelId: args.modelId,
      mesh: args.mesh,
      existingTipPoints: [...existingTipVectors, ...supports.flatMap(plannedTipPoints)
        .map((point) => new THREE.Vector3(point.x, point.y, point.z))],
      signal: args.signal,
      onProgress: args.onProgress,
      progressPhase: 'route',
      overrides: structuralOverrides(),
    });
    supports.push(...structuralWave.supports);
    failures.push(...structuralWave.failures);
  }
  let attemptedContactCount = plan.contacts.length;

  const routedVolumeIds = new Set(supports.map((support) => support.contact.volumeId));
  const coveredVolumeIds = new Set(plan.coveredVolumeIds);
  const eligibleVolumeIds = plan.volumes
    .map((volume) => volume.id)
    .filter((id) => !plan.ignoredVolumeIds.includes(id) && !coveredVolumeIds.has(id));
  const unresolvedAfterFirstWave = new Set(eligibleVolumeIds.filter((id) => !routedVolumeIds.has(id)));
  const remainingContactBudget = settings.maxTotalContacts - plan.contacts.length;

  let retryContacts: typeof plan.contacts = [];
  if (unresolvedAfterFirstWave.size > 0 && remainingContactBudget > 0) {
    const routedTips = supports.flatMap(plannedTipPoints);
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
        settings: { ...settings, surfaceSearchRadiusMm: settings.surfaceSearchRadiusMm * 2 },
        maxExpansions: RETRY_MAX_EXPANSIONS,
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
      retryContacts = retryPlan.contacts;
      for (const support of secondWave.supports) routedVolumeIds.add(support.contact.volumeId);
    }
  }

  const allContacts = [...plan.contacts, ...retryContacts];
  const rescueTipPoints = () => [...existingTips, ...supports.flatMap(plannedTipPoints)]
    .map((point) => new THREE.Vector3(point.x, point.y, point.z));
  const rescueContacts = () => {
    const unresolved = new Set(eligibleVolumeIds.filter((id) => !routedVolumeIds.has(id)));
    return allContacts.filter((contact) => unresolved.has(contact.volumeId));
  };
  const absorbWave = (wave: { supports: PlannedAutoSupport[]; failures: AutoSupportRouteFailure[] }) => {
    supports.push(...wave.supports);
    failures.push(...wave.failures);
    for (const support of wave.supports) routedVolumeIds.add(support.contact.volumeId);
  };

  // Rescue stages for volumes both trunk waves failed: full-size on-model
  // sticks, then detail-size trunks, then detail-size sticks. Each stage only
  // touches volumes every earlier stage failed, so the extra cost stays tiny.
  const stickContacts = rescueContacts();
  if (stickContacts.length > 0) {
    absorbWave(await routeSticks({
      contacts: stickContacts,
      settings,
      modelId: args.modelId,
      mesh: args.mesh,
      existingTipPoints: rescueTipPoints(),
      signal: args.signal,
      onProgress: args.onProgress,
    }));
  }

  const detailTrunkContacts = rescueContacts();
  if (detailTrunkContacts.length > 0) {
    absorbWave(await routeContacts({
      contacts: detailTrunkContacts,
      settings,
      modelId: args.modelId,
      mesh: args.mesh,
      existingTipPoints: rescueTipPoints(),
      signal: args.signal,
      onProgress: args.onProgress,
      progressPhase: 'verify',
      maxExpansions: RETRY_MAX_EXPANSIONS,
      overrides: DETAIL_OVERRIDES,
    }));
  }

  const detailStickContacts = rescueContacts();
  if (detailStickContacts.length > 0) {
    absorbWave(await routeSticks({
      contacts: detailStickContacts,
      settings,
      modelId: args.modelId,
      mesh: args.mesh,
      existingTipPoints: rescueTipPoints(),
      signal: args.signal,
      onProgress: args.onProgress,
      overrides: DETAIL_OVERRIDES,
    }));
  }

  // Surface fill: islands catch geometry that appears in mid-air, but large
  // connected overhangs droop and peel without intermediate supports. Sample
  // the downward-facing surface on the spacing grid and route best-effort —
  // a failed fill sample leans on its neighbors, so failures are not
  // reported as unresolved regions.
  const surfaceContacts = sampleSurface({
    mesh: args.mesh,
    spacingMm: settings.contactSpacingMm,
    maxDownNormalZ: settings.overhangNormalZMax,
    minZ: args.scanMinZ + args.layerHeightMm * 1.5,
    exclusions: toExclusions([...existingTips, ...supports.flatMap(plannedTipPoints)], settings.contactSpacingMm),
    maxSamples: settings.maxSurfaceContacts,
  });
  if (surfaceContacts.length > 0 && !args.signal?.aborted) {
    const surfaceWave = await routeContacts({
      contacts: surfaceContacts,
      settings,
      modelId: args.modelId,
      mesh: args.mesh,
      existingTipPoints: rescueTipPoints(),
      signal: args.signal,
      onProgress: args.onProgress,
      progressPhase: 'route',
    });
    supports.push(...surfaceWave.supports);
    attemptedContactCount += surfaceContacts.length;
    const stickRescueContacts = surfaceWave.failures
      .filter((failure) => failure.reason !== 'tip_spacing')
      .map((failure) => surfaceContacts.find((contact) => contact.id === failure.contactId))
      .filter((contact): contact is AutoSupportContactCandidate => contact !== undefined);
    if (stickRescueContacts.length > 0) {
      const surfaceStickWave = await routeSticks({
        contacts: stickRescueContacts,
        settings,
        modelId: args.modelId,
        mesh: args.mesh,
        existingTipPoints: rescueTipPoints(),
        signal: args.signal,
        onProgress: args.onProgress,
      });
      supports.push(...surfaceStickWave.supports);
    }
  }

  // A volume whose every attempt failed on tip spacing is blanketed by
  // neighboring tips — that's adjacent coverage, not a region needing work.
  const crowdedVolumeIds = eligibleVolumeIds.filter((id) => {
    if (routedVolumeIds.has(id)) return false;
    const volumeFailures = failures.filter((failure) => failure.volumeId === id);
    return volumeFailures.length > 0 && volumeFailures.every((failure) => failure.reason === 'tip_spacing');
  });
  const crowdedSet = new Set(crowdedVolumeIds);

  const unresolvedVolumeIds = eligibleVolumeIds
    .filter((id) => !routedVolumeIds.has(id) && !crowdedSet.has(id))
    .sort((left, right) => left - right);
  const unresolvedSet = new Set(unresolvedVolumeIds);

  return {
    preset: args.preset,
    supports,
    eligibleVolumeCount: eligibleVolumeIds.length,
    ignoredVolumeCount: plan.ignoredVolumeIds.length,
    coveredVolumeCount: plan.coveredVolumeIds.length + crowdedVolumeIds.length,
    unresolvedVolumeIds,
    attemptedContactCount,
    failureReasonCounts: countFailureReasons(failures.filter((failure) => unresolvedSet.has(failure.volumeId))),
  };
}

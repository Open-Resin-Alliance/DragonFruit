import * as THREE from 'three';
import { getSettings as getSupportSettings } from '@/supports/Settings/state';
import { buildTrunkData, type TrunkBuildInput } from '@/supports/SupportTypes/Trunk/trunkBuilder';
import { resolveIslandSupportSurface } from './islandSupportSurface';
import type {
  AutoSupportContactCandidate,
  AutoSupportPlannerSettings,
  AutoSupportProgress,
  AutoSupportRouteFailure,
  AutoSupportRouteFailureReason,
  PlannedAutoSupport,
} from './types';

export function buildSearchTargets(
  contact: AutoSupportContactCandidate,
  settings: AutoSupportPlannerSettings,
): THREE.Vector3[] {
  const center = new THREE.Vector3(contact.position.x, contact.position.y, contact.position.z);
  const targets = [center];
  const remaining = Math.max(0, settings.routeAttemptsPerContact - 1);
  for (let index = 0; index < remaining; index++) {
    const ring = Math.floor(index / 6) + 1;
    const angle = (index % 6) * Math.PI / 3;
    const radius = settings.surfaceSearchRadiusMm * ring / Math.max(1, Math.ceil(remaining / 6));
    targets.push(center.clone().add(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0)));
  }
  return targets;
}

export interface RouteAutoSupportResult {
  supports: PlannedAutoSupport[];
  failures: AutoSupportRouteFailure[];
}

export async function routeAutoSupportContacts(args: {
  contacts: AutoSupportContactCandidate[];
  settings: AutoSupportPlannerSettings;
  modelId: string;
  mesh: THREE.Mesh;
  existingTipPoints?: THREE.Vector3[];
  signal?: AbortSignal;
  onProgress?: (progress: AutoSupportProgress) => void;
  progressPhase?: AutoSupportProgress['phase'];
  maxExpansions?: number;
  overrides?: TrunkBuildInput['overrides'];
}): Promise<RouteAutoSupportResult> {
  const supports: PlannedAutoSupport[] = [];
  const failures: AutoSupportRouteFailure[] = [];
  const usedSurfacePoints = (args.existingTipPoints ?? []).map((point) => point.clone());
  const minimumSpacingSq = Math.max(0.5, args.settings.contactSpacingMm * 0.45) ** 2;
  const phase = args.progressPhase ?? 'route';

  // A tip below the root's own height would produce a degenerate support:
  // all root, no shaft, contact buried inside the cone. Shrink the root for
  // low tips; below the absolute minimum, skip — the raft holds that zone.
  const rootSettings = getSupportSettings().roots;
  const tipClearanceMm = 0.4;
  const minRootMm = { disk: 0.3, cone: 0.2 };
  const absoluteMinTipZ = minRootMm.disk + minRootMm.cone + tipClearanceMm;
  const lowTipOverrides = (tipZ: number): TrunkBuildInput['overrides'] | undefined => {
    const defaultRootsTop = (args.overrides?.rootsDiskHeightMm ?? rootSettings.diskHeightMm)
      + (args.overrides?.rootsConeHeightMm ?? rootSettings.coneHeightMm);
    if (tipZ >= defaultRootsTop + tipClearanceMm) return args.overrides;
    const budget = tipZ - tipClearanceMm;
    const disk = Math.max(minRootMm.disk, Math.min(rootSettings.diskHeightMm, budget * 0.4));
    const cone = Math.max(minRootMm.cone, budget - disk);
    return { ...args.overrides, rootsDiskHeightMm: disk, rootsConeHeightMm: cone };
  };

  for (let contactIndex = 0; contactIndex < args.contacts.length; contactIndex++) {
    if (args.signal?.aborted) throw new DOMException('Auto support routing aborted', 'AbortError');
    const contact = args.contacts[contactIndex];
    let planned: PlannedAutoSupport | null = null;
    let failureReason: AutoSupportRouteFailureReason = 'no_surface';

    for (const target of buildSearchTargets(contact, args.settings)) {
      const surface = resolveIslandSupportSurface(args.mesh, target, args.settings.surfaceSearchRadiusMm + 1);
      if (!surface) continue;
      if (surface.point.z < absoluteMinTipZ) {
        failureReason = 'OUT_OF_BOUNDS';
        continue;
      }
      if (usedSurfacePoints.some((point) => point.distanceToSquared(surface.point) < minimumSpacingSq)) {
        failureReason = 'tip_spacing';
        continue;
      }
      const built = buildTrunkData({
        tipPos: surface.point,
        tipNormal: surface.normal,
        modelId: args.modelId,
        mesh: args.mesh,
        maxExpansions: args.maxExpansions,
        overrides: lowTipOverrides(surface.point.z),
      });
      if (built.error) {
        failureReason = built.error;
        continue;
      }
      planned = {
        kind: 'trunk',
        contact,
        root: built.root,
        trunk: built.trunk,
        supportData: built.supportData,
      };
      usedSurfacePoints.push(surface.point.clone());
      break;
    }

    if (planned) supports.push(planned);
    else failures.push({ contactId: contact.id, volumeId: contact.volumeId, reason: failureReason });
    args.onProgress?.({ phase, completed: contactIndex + 1, total: args.contacts.length });
    // Every A* attempt can block for tens to hundreds of milliseconds on
    // dense meshes; yield after each contact so the viewport stays usable.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  return { supports, failures };
}

import * as THREE from 'three';
import { buildTrunkData } from '@/supports/SupportTypes/Trunk/trunkBuilder';
import { resolveIslandSupportSurface } from './islandSupportSurface';
import type {
  AutoSupportContactCandidate,
  AutoSupportPlannerSettings,
  AutoSupportProgress,
  AutoSupportRouteFailure,
  AutoSupportRouteFailureReason,
  PlannedAutoSupport,
} from './types';

function buildSearchTargets(
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
}): Promise<RouteAutoSupportResult> {
  const supports: PlannedAutoSupport[] = [];
  const failures: AutoSupportRouteFailure[] = [];
  const usedSurfacePoints = (args.existingTipPoints ?? []).map((point) => point.clone());
  const minimumSpacingSq = Math.max(0.5, args.settings.contactSpacingMm * 0.45) ** 2;
  const phase = args.progressPhase ?? 'route';

  for (let contactIndex = 0; contactIndex < args.contacts.length; contactIndex++) {
    if (args.signal?.aborted) throw new DOMException('Auto support routing aborted', 'AbortError');
    const contact = args.contacts[contactIndex];
    let planned: PlannedAutoSupport | null = null;
    let failureReason: AutoSupportRouteFailureReason = 'no_surface';

    for (const target of buildSearchTargets(contact, args.settings)) {
      const surface = resolveIslandSupportSurface(args.mesh, target, args.settings.surfaceSearchRadiusMm + 1);
      if (!surface) continue;
      if (usedSurfacePoints.some((point) => point.distanceToSquared(surface.point) < minimumSpacingSq)) {
        failureReason = 'tip_spacing';
        continue;
      }
      const built = buildTrunkData({
        tipPos: surface.point,
        tipNormal: surface.normal,
        modelId: args.modelId,
        mesh: args.mesh,
      });
      if (built.error) {
        failureReason = built.error;
        continue;
      }
      planned = {
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
    if (contactIndex % 4 === 3) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  return { supports, failures };
}

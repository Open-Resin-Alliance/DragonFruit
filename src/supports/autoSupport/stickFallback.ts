import * as THREE from 'three';
import { buildStick, type StickBuildInput } from '@/supports/SupportTypes/Stick/stickBuilder';
import type { Stick } from '@/supports/types';
import type { SupportData } from '@/supports/rendering/SupportBuilder';
import { resolveAnchorSurfaceAlong, resolveIslandSupportSurface } from './islandSupportSurface';
import { buildSearchTargets } from './routePlanner';
import type {
  AutoSupportContactCandidate,
  AutoSupportPlannerSettings,
  AutoSupportProgress,
  AutoSupportRouteFailure,
  AutoSupportRouteFailureReason,
  PlannedAutoSupport,
} from './types';

const MAX_STICK_LENGTH_MM = 35;
// Tilted struts get a much shorter reach: long diagonals read as bridges
// between unrelated parts of the model and are ugly to clean up.
const MAX_TILTED_STICK_LENGTH_MM = 12;

// Vertical first, then rings of gently tilted directions. A strut anchored at
// both ends prints fine slightly off-vertical, and a tilt often reaches a flat
// anchor when the surface straight below is too steep to seat a cone on.
const ANCHOR_DIRECTIONS: Array<{ direction: THREE.Vector3; maxLengthMm: number }> = [
  { direction: new THREE.Vector3(0, 0, -1), maxLengthMm: MAX_STICK_LENGTH_MM },
  ...[15, 30].flatMap((tiltDeg) => {
    const tilt = (tiltDeg * Math.PI) / 180;
    return Array.from({ length: 12 }, (_, index) => {
      const azimuth = (index * Math.PI) / 6;
      return {
        direction: new THREE.Vector3(
          Math.cos(azimuth) * Math.sin(tilt),
          Math.sin(azimuth) * Math.sin(tilt),
          -Math.cos(tilt),
        ),
        maxLengthMm: MAX_TILTED_STICK_LENGTH_MM,
      };
    });
  }),
];

export function stickSupportData(stick: Stick): SupportData {
  return {
    id: stick.id,
    segments: stick.segments,
    contactCones: [stick.contactConeA, stick.contactConeB],
  };
}

export async function routeStickFallback(args: {
  contacts: AutoSupportContactCandidate[];
  settings: AutoSupportPlannerSettings;
  modelId: string;
  mesh: THREE.Mesh;
  existingTipPoints?: THREE.Vector3[];
  signal?: AbortSignal;
  onProgress?: (progress: AutoSupportProgress) => void;
  overrides?: StickBuildInput['overrides'];
}): Promise<{ supports: PlannedAutoSupport[]; failures: AutoSupportRouteFailure[] }> {
  if (!args.settings.allowOnModelStruts) {
    return {
      supports: [],
      failures: args.contacts.map((contact) => ({
        contactId: contact.id,
        volumeId: contact.volumeId,
        reason: 'no_surface' as const,
      })),
    };
  }
  const supports: PlannedAutoSupport[] = [];
  const failures: AutoSupportRouteFailure[] = [];
  const usedSurfacePoints = (args.existingTipPoints ?? []).map((point) => point.clone());
  const minimumSpacingSq = Math.max(0.5, args.settings.contactSpacingMm * 0.45) ** 2;

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
      for (const { direction, maxLengthMm } of ANCHOR_DIRECTIONS) {
        const below = resolveAnchorSurfaceAlong(args.mesh, surface.point, direction, maxLengthMm);
        if (!below) continue;
        const built = buildStick({
          modelId: args.modelId,
          aPos: { x: surface.point.x, y: surface.point.y, z: surface.point.z },
          aNormal: { x: surface.normal.x, y: surface.normal.y, z: surface.normal.z },
          bPos: { x: below.point.x, y: below.point.y, z: below.point.z },
          bNormal: { x: below.normal.x, y: below.normal.y, z: below.normal.z },
          mesh: args.mesh,
          overrides: args.overrides,
        });
        if (built.error) {
          failureReason = built.error;
          continue;
        }
        planned = {
          kind: 'stick',
          contact,
          stick: built.stick,
          supportData: stickSupportData(built.stick),
        };
        usedSurfacePoints.push(surface.point.clone());
        break;
      }
      if (planned) break;
    }

    if (planned) supports.push(planned);
    else failures.push({ contactId: contact.id, volumeId: contact.volumeId, reason: failureReason });
    args.onProgress?.({ phase: 'verify', completed: contactIndex + 1, total: args.contacts.length });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  return { supports, failures };
}

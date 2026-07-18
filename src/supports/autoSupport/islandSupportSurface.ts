import * as THREE from 'three';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { calculateSmoothedNormal } from '@/supports/PlacementLogic/PlacementUtils';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';

const DEFAULT_SEARCH_DISTANCE_MM = 3;
const DEFAULT_MAX_SURFACE_CANDIDATES = 10;
const SURFACE_DEDUPE_DISTANCE_MM = 0.15;
const MIN_UNDERSIDE_NORMAL_Z = -0.05;
const RAY_OFFSETS_MM = [
  [0, 0],
  [0.05, 0],
  [-0.05, 0],
  [0, 0.05],
  [0, -0.05],
  [0.1, 0.1],
  [-0.1, 0.1],
  [0.1, -0.1],
  [-0.1, -0.1],
] as const;
const FALLBACK_SEARCH_OFFSETS_MM = [
  [0.35, 0],
  [0.7, 0],
  [-0.35, 0],
  [-0.7, 0],
  [0, 0.35],
  [0, 0.7],
  [0, -0.35],
  [0, -0.7],
  [0.25, 0.25],
  [-0.25, 0.25],
  [0.25, -0.25],
  [-0.25, -0.25],
] as const;

export type IslandSupportSurface = {
  mesh: THREE.Mesh;
  point: THREE.Vector3;
  normal: THREE.Vector3;
};

export function createIslandSupportMesh(
  geom: GeometryWithBounds,
  transform: ModelTransform,
  modelId: string,
): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geom.geometry, material);
  const center = geom.bbox.getCenter(new THREE.Vector3());
  const modelMatrix = new THREE.Matrix4().compose(
    transform.position,
    quaternionFromGlobalEuler(transform.rotation),
    transform.scale,
  );
  const centerOffset = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);

  mesh.matrixAutoUpdate = false;
  mesh.matrixWorld.multiplyMatrices(modelMatrix, centerOffset);
  mesh.userData.modelId = modelId;
  return mesh;
}

export function disposeIslandSupportMesh(mesh: THREE.Mesh): void {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) material.dispose();
}

export function resolveIslandSupportSurface(
  mesh: THREE.Mesh,
  contact: THREE.Vector3,
  searchDistanceMm = DEFAULT_SEARCH_DISTANCE_MM,
): IslandSupportSurface | null {
  const raycaster = new THREE.Raycaster();
  raycaster.near = 0;
  raycaster.far = searchDistanceMm * 2;
  const direction = new THREE.Vector3(0, 0, 1);
  const origin = new THREE.Vector3();
  let best: IslandSupportSurface | null = null;
  let bestDistanceSq = Number.POSITIVE_INFINITY;

  for (const [offsetX, offsetY] of RAY_OFFSETS_MM) {
    origin.set(
      contact.x + offsetX,
      contact.y + offsetY,
      contact.z - searchDistanceMm,
    );
    raycaster.set(origin, direction);

    for (const hit of raycaster.intersectObject(mesh, false)) {
      if (!hit.face) continue;
      const normalLike = calculateSmoothedNormal(hit);
      const normal = new THREE.Vector3(normalLike.x, normalLike.y, normalLike.z).normalize();
      if (normal.z > MIN_UNDERSIDE_NORMAL_Z) continue;

      const distanceSq = hit.point.distanceToSquared(contact);
      if (distanceSq >= bestDistanceSq) continue;
      bestDistanceSq = distanceSq;
      best = {
        mesh,
        point: hit.point.clone(),
        normal,
      };
    }
  }

  return best;
}

// Steeper landings than this make the anchor cone dive into the surface.
const MIN_ANCHOR_NORMAL_Z = 0.25;
const SURFACE_BELOW_CLEARANCE_MM = 0.2;

export function resolveAnchorSurfaceAlong(
  mesh: THREE.Mesh,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  maxDistanceMm: number,
): IslandSupportSurface | null {
  const raycaster = new THREE.Raycaster();
  raycaster.near = SURFACE_BELOW_CLEARANCE_MM;
  raycaster.far = maxDistanceMm;
  raycaster.set(
    origin.clone().addScaledVector(direction, SURFACE_BELOW_CLEARANCE_MM),
    direction,
  );

  for (const hit of raycaster.intersectObject(mesh, false)) {
    if (!hit.face) continue;
    const normalLike = calculateSmoothedNormal(hit);
    const normal = new THREE.Vector3(normalLike.x, normalLike.y, normalLike.z).normalize();
    if (normal.z < MIN_ANCHOR_NORMAL_Z) continue;
    return { mesh, point: hit.point.clone(), normal };
  }

  return null;
}

export function resolveSurfaceBelow(
  mesh: THREE.Mesh,
  origin: THREE.Vector3,
  maxDistanceMm: number,
): IslandSupportSurface | null {
  return resolveAnchorSurfaceAlong(mesh, origin, new THREE.Vector3(0, 0, -1), maxDistanceMm);
}

export function resolveIslandSupportSurfaces(
  mesh: THREE.Mesh,
  island: DetectedIsland,
  maxCandidates = DEFAULT_MAX_SURFACE_CANDIDATES,
): IslandSupportSurface[] {
  const searchContacts = buildIslandSearchContacts(island, maxCandidates);
  const surfaces: IslandSupportSurface[] = [];
  const dedupeDistanceSq = SURFACE_DEDUPE_DISTANCE_MM * SURFACE_DEDUPE_DISTANCE_MM;

  for (const contact of searchContacts) {
    const surface = resolveIslandSupportSurface(mesh, contact);
    if (!surface) continue;
    if (surfaces.some((candidate) => candidate.point.distanceToSquared(surface.point) < dedupeDistanceSq)) continue;
    surfaces.push(surface);
    if (surfaces.length >= maxCandidates) break;
  }

  return surfaces;
}

function buildIslandSearchContacts(island: DetectedIsland, maxCandidates: number): THREE.Vector3[] {
  const contacts = [island.contact.clone()];
  const voxels = island.contactVoxels;
  if (maxCandidates <= 1) return contacts;

  if (voxels && voxels.length > 0) {
    const extrema = [
      voxels.reduce((best, voxel) => voxel.x < best.x ? voxel : best),
      voxels.reduce((best, voxel) => voxel.x > best.x ? voxel : best),
      voxels.reduce((best, voxel) => voxel.y < best.y ? voxel : best),
      voxels.reduce((best, voxel) => voxel.y > best.y ? voxel : best),
      voxels.reduce((best, voxel) => {
        const bestDistance = (best.x - island.contact.x) ** 2 + (best.y - island.contact.y) ** 2;
        const voxelDistance = (voxel.x - island.contact.x) ** 2 + (voxel.y - island.contact.y) ** 2;
        return voxelDistance > bestDistance ? voxel : best;
      }),
    ];

    for (const voxel of extrema) {
      addUniqueSearchContact(contacts, voxel.x, voxel.y, island.contact.z);
      if (contacts.length >= maxCandidates) return contacts;
    }
  }

  for (const [offsetX, offsetY] of FALLBACK_SEARCH_OFFSETS_MM) {
    addUniqueSearchContact(
      contacts,
      island.contact.x + offsetX,
      island.contact.y + offsetY,
      island.contact.z,
    );
    if (contacts.length >= maxCandidates) break;
  }

  return contacts;
}

function addUniqueSearchContact(contacts: THREE.Vector3[], x: number, y: number, z: number): void {
  if (contacts.some((contact) => Math.abs(contact.x - x) < 1e-4 && Math.abs(contact.y - y) < 1e-4)) return;
  contacts.push(new THREE.Vector3(x, y, z));
}

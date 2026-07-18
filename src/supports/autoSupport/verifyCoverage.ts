import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SupportGeometryGenerator } from '@/features/export/logic/SupportGeometryGenerator';
import type { ScanResults } from '@/volumeAnalysis/IslandScan/ScanOrchestrator';
import { planAutoSupportContacts } from './contactPlanner';
import type {
  AutoSupportContactCandidate,
  AutoSupportPlannerSettings,
  PlannedAutoSupport,
} from './types';

export interface CoverageVerification {
  remainingVolumeCount: number;
  remainingVolumeIds: number[];
  /** Planner contacts for the remaining volumes, usable for a repair round. */
  repairContacts: AutoSupportContactCandidate[];
}

/**
 * Geometry for a planned support. Trunks reuse the export generator; sticks
 * need explicit assembly — the generator's SupportData path assumes a single
 * contact cone and a roots/startPos anchor, neither of which sticks have.
 */
export function plannedSupportGroup(support: PlannedAutoSupport): THREE.Group {
  if (support.kind === 'trunk') {
    return SupportGeometryGenerator.generateSupportGroup(support.supportData);
  }
  const group = new THREE.Group();
  for (const segment of support.stick.segments) {
    if (!segment.bottomJoint || !segment.topJoint) continue;
    const shaft = SupportGeometryGenerator.generateShaftMesh(
      new THREE.Vector3(segment.bottomJoint.pos.x, segment.bottomJoint.pos.y, segment.bottomJoint.pos.z),
      new THREE.Vector3(segment.topJoint.pos.x, segment.topJoint.pos.y, segment.topJoint.pos.z),
      segment.diameter,
    );
    if (shaft) group.add(shaft);
  }
  for (const cone of [support.stick.contactConeA, support.stick.contactConeB]) {
    group.add(SupportGeometryGenerator.generateConeMesh(cone));
    group.add(SupportGeometryGenerator.generateContactDiskMesh(cone));
  }
  return group;
}

const WELD_RADIUS_MM = 0.45;

/**
 * Small spheres at support contact points for the verification scan. Printed
 * tips penetrate and fuse with the surface; without an explicit weld the
 * sub-pixel contact often fails the scan's minimum layer overlap and a
 * physically supported region reads as an island.
 */
export function contactWeldGroup(points: Array<{ x: number; y: number; z: number }>): THREE.Group {
  const group = new THREE.Group();
  for (const point of points) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(WELD_RADIUS_MM, 8, 6));
    mesh.position.set(point.x, point.y, point.z);
    group.add(mesh);
  }
  return group;
}

export function plannedContactPoints(supports: PlannedAutoSupport[]): Array<{ x: number; y: number; z: number }> {
  return supports.flatMap((support) => {
    const positions = support.kind === 'trunk'
      ? [support.trunk.contactCone?.pos]
      : [support.stick.contactConeA.pos, support.stick.contactConeB.pos];
    return positions
      .filter((pos): pos is NonNullable<typeof pos> => pos !== undefined)
      .map((pos) => ({ x: pos.x, y: pos.y, z: pos.z }));
  });
}

/**
 * Flatten support groups into one position-only, world-space geometry that can
 * be merged with the model for a verification scan.
 */
export function collectSupportGeometry(groups: THREE.Group[]): THREE.BufferGeometry | null {
  const geometries: THREE.BufferGeometry[] = [];
  for (const group of groups) {
    group.updateMatrixWorld(true);
    group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const source = object.geometry as THREE.BufferGeometry;
      if (!source.getAttribute('position')) return;
      let flattened = source.index ? source.toNonIndexed() : source.clone();
      flattened = flattened.applyMatrix4(object.matrixWorld);
      for (const name of Object.keys(flattened.attributes)) {
        if (name !== 'position') flattened.deleteAttribute(name);
      }
      flattened.morphAttributes = {};
      geometries.push(flattened);
    });
  }
  if (geometries.length === 0) return null;
  const merged = mergeGeometries(geometries, false);
  for (const geometry of geometries) geometry.dispose();
  return merged;
}

/**
 * Evaluate a scan of model-plus-supports: any volume that still passes the
 * planner's significance thresholds is genuinely unsupported.
 */
export function evaluateCoverageScan(args: {
  scan: ScanResults;
  scanMinZ: number;
  layerHeightMm: number;
  settings: AutoSupportPlannerSettings;
}): CoverageVerification {
  const plan = planAutoSupportContacts({
    scan: args.scan,
    scanMinZ: args.scanMinZ,
    layerHeightMm: args.layerHeightMm,
    settings: args.settings,
  });
  const eligibleIds = new Set(plan.contacts.map((contact) => contact.volumeId));
  for (const volumeId of plan.limitedVolumeIds) eligibleIds.add(volumeId);
  const remainingVolumeIds = Array.from(eligibleIds).sort((left, right) => left - right);
  return {
    remainingVolumeCount: remainingVolumeIds.length,
    remainingVolumeIds,
    repairContacts: plan.contacts.map((contact) => ({ ...contact, id: `repair:${contact.id}` })),
  };
}

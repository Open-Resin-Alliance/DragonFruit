import * as THREE from 'three';
import { v4 as uuidv4 } from 'uuid';
import { ContactCone } from '../../../supports/SupportPrimitives/ContactCone/types';
import { Joint, Vec3 } from '../../../supports/types';
import { getJointDiameter } from '../../../supports/constants';
import { calculateSmoothedNormal } from '../../../supports/PlacementLogic/PlacementUtils';
import { calculateDiskThickness } from '../../../supports/SupportPrimitives/ContactDisk/contactDiskUtils';
import { LycheeSupport } from './types';

export function createContactAssembly(
  s: LycheeSupport,
  tipWorld: THREE.Vector3,
  startPos: Vec3,
  tipSettings: any,
  tipDefaults: any,
  mesh?: THREE.Mesh,
  preferLycheeTipNormal: boolean = false,
  strictLycheeCoordinates: boolean = false,
  transformedTipNormal?: THREE.Vector3 | null,
  enforceSocketBelowTip: boolean = true
): { socketJoint: Joint; contactCone: ContactCone } {
  const tipLen = tipSettings?.length || tipDefaults.lengthMm;
  const tipBodyDiameter = tipSettings?.diameter || tipDefaults.bodyDiameterMm;

  const dx = tipWorld.x - startPos.x;
  const dy = tipWorld.y - startPos.y;
  const hDistSq = dx * dx + dy * dy;
  const tipLenSq = tipLen * tipLen;

  let socketPosVec: THREE.Vector3;
  let coneAxis: THREE.Vector3 | null = null;

  const lycheeTipNormal = transformedTipNormal
    ? transformedTipNormal.clone()
    : s.tipNormal
      ? new THREE.Vector3(s.tipNormal.x, s.tipNormal.y, s.tipNormal.z)
      : null;

  if (preferLycheeTipNormal && lycheeTipNormal && lycheeTipNormal.lengthSq() > 1e-8) {
    const normalized = lycheeTipNormal.clone().normalize();
    const axisA = normalized.clone();
    const axisB = normalized.clone().multiplyScalar(-1);
    const socketA = axisA.clone().multiplyScalar(tipLen).add(tipWorld);
    const socketB = axisB.clone().multiplyScalar(tipLen).add(tipWorld);
    const startPosVec = new THREE.Vector3(startPos.x, startPos.y, startPos.z);
    const epsilon = 1e-6;
    const socketAIsBelowTip = socketA.z <= tipWorld.z + epsilon;
    const socketBIsBelowTip = socketB.z <= tipWorld.z + epsilon;

    if (enforceSocketBelowTip && socketAIsBelowTip !== socketBIsBelowTip) {
      if (socketAIsBelowTip) {
        coneAxis = axisA;
        socketPosVec = socketA;
      } else {
        coneAxis = axisB;
        socketPosVec = socketB;
      }
    } else {
      if (socketA.distanceTo(startPosVec) <= socketB.distanceTo(startPosVec)) {
        coneAxis = axisA;
        socketPosVec = socketA;
      } else {
        coneAxis = axisB;
        socketPosVec = socketB;
      }
    }
  } else if (hDistSq <= tipLenSq) {
    const vOffset = Math.sqrt(tipLenSq - hDistSq);
    socketPosVec = new THREE.Vector3(
      startPos.x,
      startPos.y,
      tipWorld.z - vOffset
    );
    if (socketPosVec.z < startPos.z) {
      const toStart = new THREE.Vector3(
        startPos.x - tipWorld.x,
        startPos.y - tipWorld.y,
        startPos.z - tipWorld.z
      );
      socketPosVec = toStart.normalize().multiplyScalar(tipLen).add(tipWorld);
    }
  } else {
    const toStart = new THREE.Vector3(
      startPos.x - tipWorld.x,
      startPos.y - tipWorld.y,
      startPos.z - tipWorld.z
    );
    socketPosVec = toStart.normalize().multiplyScalar(tipLen).add(tipWorld);
  }

  const socketJoint: Joint = {
    id: uuidv4(),
    pos: { x: socketPosVec.x, y: socketPosVec.y, z: socketPosVec.z },
    diameter: getJointDiameter(tipBodyDiameter)
  };

  if (!coneAxis) {
    coneAxis = socketPosVec.clone().sub(tipWorld).normalize();
  }

  let finalTipPos = { x: tipWorld.x, y: tipWorld.y, z: tipWorld.z };
  let surfaceNormal: Vec3 | undefined = undefined;
  const hasLycheeTipNormal = !!(lycheeTipNormal && lycheeTipNormal.lengthSq() > 1e-8);

  if (hasLycheeTipNormal && lycheeTipNormal) {
    const n = lycheeTipNormal.clone().normalize();
    surfaceNormal = { x: n.x, y: n.y, z: n.z };
  } else if (!strictLycheeCoordinates && mesh) {
    const raycaster = new THREE.Raycaster();
    const rayOrigin = socketPosVec.clone();
    const rayDir = tipWorld.clone().sub(socketPosVec).normalize();
    raycaster.set(rayOrigin, rayDir);
    const intersects = raycaster.intersectObject(mesh, false);

    if (intersects.length > 0) {
      const hit = intersects[0];
      finalTipPos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
      const smoothed = calculateSmoothedNormal(hit);
      surfaceNormal = { x: smoothed.x, y: smoothed.y, z: smoothed.z };
    }
  }

  const coneProfile = {
    type: 'disk' as const,
    lengthMm: tipLen,
    contactDiameterMm: tipSettings?.pointDiameter || tipDefaults.contactDiameterMm,
    bodyDiameterMm: tipBodyDiameter,
    diskThicknessMm: tipDefaults.diskThicknessMm ?? 0.1,
    maxStandoffMm: tipDefaults.maxStandoffMm ?? 0.25,
    standoffAngleThreshold: tipDefaults.standoffAngleThreshold ?? Math.PI / 4,
    penetrationMm: tipDefaults.penetrationMm
  };

  const effectiveSurfaceNormal = surfaceNormal || { x: coneAxis.x, y: coneAxis.y, z: coneAxis.z };
  const diskOffset = strictLycheeCoordinates
    ? 0
    : calculateDiskThickness(effectiveSurfaceNormal, { x: coneAxis.x, y: coneAxis.y, z: coneAxis.z }, coneProfile);

  const coneStartPos = {
    x: finalTipPos.x + effectiveSurfaceNormal.x * diskOffset,
    y: finalTipPos.y + effectiveSurfaceNormal.y * diskOffset,
    z: finalTipPos.z + effectiveSurfaceNormal.z * diskOffset
  };

  const alignedSocketPos = {
    x: coneStartPos.x + coneAxis.x * tipLen,
    y: coneStartPos.y + coneAxis.y * tipLen,
    z: coneStartPos.z + coneAxis.z * tipLen
  };

  socketJoint.pos = alignedSocketPos;

  const contactCone: ContactCone = {
    id: uuidv4(),
    pos: finalTipPos,
    normal: { x: coneAxis.x, y: coneAxis.y, z: coneAxis.z },
    surfaceNormal: surfaceNormal,
    socketJointId: socketJoint.id,
    profile: coneProfile
  };

  return { socketJoint, contactCone };
}

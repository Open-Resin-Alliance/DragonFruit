"use client";

import React, { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { usePicking } from '@/components/picking';
import { getSnapshot, subscribe } from '../state';
import { getSupportBraceSnapshot, subscribeToSupportBraceStore } from '../SupportTypes/SupportBrace/supportBraceStore';
import { getRaftSettings, subscribeToRaftStore } from '../Rafts/Crenelated/RaftState';
import { getTrunkSegmentEndpoints, getBranchSegmentEndpoints } from '../SupportPrimitives/Knot/knotUtils';
import { getFinalSocketPosition } from '../SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from '../SupportPrimitives/ContactDisk/contactDiskUtils';
import type { Segment, Vec3 } from '../types';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';

type SegmentInstance = {
  start: THREE.Vector3;
  end: THREE.Vector3;
  radius: number;
  modelId: string | null;
};

type SphereInstance = {
  center: THREE.Vector3;
  radius: number;
  modelId: string | null;
};

type TipInstance = {
  center: THREE.Vector3;
  radius: number;
  modelId: string | null;
};

type FrustumInstance = {
  start: THREE.Vector3;
  end: THREE.Vector3;
  startRadius: number;
  endRadius: number;
  modelId: string | null;
};

interface SupportBatchedRendererProps {
  clipLower?: number | null;
  clipUpper?: number | null;
  activeModelId?: string | null;
  hoverModelId?: string | null;
  onModelPointerSelect?: (modelId: string) => void;
  onModelPointerHover?: (modelId: string | null) => void;
}

function toVec3(v: Vec3) {
  return new THREE.Vector3(v.x, v.y, v.z);
}

function diskTipCenter(disk: {
  pos: Vec3;
  surfaceNormal: Vec3;
  coneAxis: Vec3;
  profile: any;
  diskLengthOverride?: number;
}) {
  const thickness = disk.diskLengthOverride ?? calculateDiskThickness(disk.surfaceNormal, disk.coneAxis, disk.profile);
  return new THREE.Vector3(
    disk.pos.x + disk.surfaceNormal.x * thickness,
    disk.pos.y + disk.surfaceNormal.y * thickness,
    disk.pos.z + disk.surfaceNormal.z * thickness,
  );
}

export function SupportBatchedRenderer({
  clipLower,
  clipUpper,
  activeModelId = null,
  hoverModelId = null,
  onModelPointerSelect,
  onModelPointerHover,
}: SupportBatchedRendererProps) {
  const supportState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const supportBraceState = useSyncExternalStore(subscribeToSupportBraceStore, getSupportBraceSnapshot, getSupportBraceSnapshot);
  const raftState = useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);
  const { register, unregister, config } = usePicking();

  const clippingPlanes = useMemo(() => {
    const planes: THREE.Plane[] = [];
    if (clipLower != null) {
      planes.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), -clipLower));
    }
    if (clipUpper != null) {
      planes.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), clipUpper));
    }
    return planes;
  }, [clipLower, clipUpper]);

  const { segmentInstances, sphereInstances, tipInstances, frustumInstances } = useMemo(() => {
    const segments: SegmentInstance[] = [];
    const spheres: SphereInstance[] = [];
    const tips: TipInstance[] = [];
    const frustums: FrustumInstance[] = [];
    const seenJointIds = new Set<string>();
    const rootTopRadiusByRootId = new Map<string, number>();

    for (const trunk of Object.values(supportState.trunks)) {
      const shaftDiameter = trunk.segments[0]?.diameter;
      if (Number.isFinite(shaftDiameter) && shaftDiameter! > 0) {
        rootTopRadiusByRootId.set(trunk.rootId, Math.max(0.03, shaftDiameter! * 0.5));
      }
    }

    const pushSegment = (start: THREE.Vector3, end: THREE.Vector3, diameter: number, modelId: string | null) => {
      if (!Number.isFinite(diameter)) return;
      const length = start.distanceTo(end);
      if (!Number.isFinite(length) || length < 0.001) return;
      segments.push({
        start,
        end,
        radius: Math.max(0.03, diameter * 0.5),
        modelId,
      });
    };

    const pushJointSphere = (joint: { id: string; pos: Vec3; diameter: number } | undefined, modelId: string | null) => {
      if (!joint || seenJointIds.has(joint.id)) return;
      seenJointIds.add(joint.id);
      spheres.push({
        center: toVec3(joint.pos),
        radius: Math.max(0.025, (joint.diameter || 0.2) * 0.5),
        modelId,
      });
    };

    const pushTipSphere = (center: THREE.Vector3, radius: number, modelId: string | null) => {
      tips.push({
        center,
        radius: Math.max(0.03, radius),
        modelId,
      });
    };

    const pushFrustum = (
      start: THREE.Vector3,
      end: THREE.Vector3,
      startRadius: number,
      endRadius: number,
      modelId: string | null,
    ) => {
      const length = start.distanceTo(end);
      if (!Number.isFinite(length) || length < 0.001) return;
      frustums.push({
        start,
        end,
        startRadius: Math.max(0.03, startRadius),
        endRadius: Math.max(0.03, endRadius),
        modelId,
      });
    };

    const pushContactConeVisuals = (cone: ContactCone | undefined, modelId: string | null) => {
      if (!cone?.pos || !cone?.normal || !cone?.profile) return;

      const contactRadius = Math.max(0.03, (cone.profile.contactDiameterMm ?? 0.2) * 0.5);
      const bodyRadius = Math.max(contactRadius, (cone.profile.bodyDiameterMm ?? cone.profile.contactDiameterMm ?? 0.2) * 0.5);

      const surfaceNormal = cone.surfaceNormal ?? cone.normal;
      let coneStart = toVec3(cone.pos);

      if (cone.profile.type === 'disk') {
        const diskThickness = cone.diskLengthOverride ?? calculateDiskThickness(surfaceNormal, cone.normal, cone.profile);
        const diskEnd = new THREE.Vector3(
          cone.pos.x + surfaceNormal.x * diskThickness,
          cone.pos.y + surfaceNormal.y * diskThickness,
          cone.pos.z + surfaceNormal.z * diskThickness,
        );
        pushSegment(toVec3(cone.pos), diskEnd, contactRadius * 2, modelId);
        pushTipSphere(diskEnd, contactRadius, modelId);
        coneStart = diskEnd;
      } else {
        pushTipSphere(coneStart, contactRadius, modelId);
      }

      const socket = toVec3(getFinalSocketPosition(cone));
      pushFrustum(coneStart, socket, contactRadius, bodyRadius, modelId);
    };

    const mergedRoots = {
      ...supportBraceState.roots,
      ...supportState.roots,
    };

    for (const root of Object.values(mergedRoots)) {
      const hasSolidBottom = raftState.bottomMode === 'solid';
      const raftThickness = raftState.thickness ?? 0;
      const effectiveDiskHeight = hasSolidBottom ? 0.05 : root.diskHeight;
      const verticalOffset = hasSolidBottom ? Math.max(raftThickness - effectiveDiskHeight, 0) : 0;

      const base = new THREE.Vector3(
        root.transform.pos.x,
        root.transform.pos.y,
        root.transform.pos.z + verticalOffset,
      );

      const diskTop = base.clone().add(new THREE.Vector3(0, 0, Math.max(0, effectiveDiskHeight)));
      const coneHeight = Math.max(0, root.coneHeight ?? 0);
      const coneTop = diskTop.clone().add(new THREE.Vector3(0, 0, coneHeight));

      const bottomDiameter = Math.max(0.06, root.diameter ?? 0.6);
      if (effectiveDiskHeight > 0.001) {
        pushSegment(base, diskTop, bottomDiameter, root.modelId ?? null);
      }

      if (coneHeight > 0.001) {
        const topRadius = rootTopRadiusByRootId.get(root.id) ?? Math.max(0.05, bottomDiameter * 0.26);
        pushFrustum(diskTop, coneTop, bottomDiameter * 0.5, topRadius, root.modelId ?? null);

        spheres.push({
          center: coneTop,
          radius: topRadius,
          modelId: root.modelId ?? null,
        });
      }
    }

    for (const trunk of Object.values(supportState.trunks)) {
      const root = supportState.roots[trunk.rootId];
      if (!root) continue;

      trunk.segments.forEach((segment, index) => {
        const endpoints = getTrunkSegmentEndpoints(trunk, segment, index, root);
        if (!endpoints) return;
        pushSegment(toVec3(endpoints.start), toVec3(endpoints.end), segment.diameter, trunk.modelId ?? null);
        pushJointSphere(segment.topJoint, trunk.modelId ?? null);
        pushJointSphere(segment.bottomJoint, trunk.modelId ?? null);
      });

      pushContactConeVisuals(trunk.contactCone, trunk.modelId ?? null);
    }

    for (const branch of Object.values(supportState.branches)) {
      const parentKnot = supportState.knots[branch.parentKnotId];
      if (!parentKnot) continue;

      branch.segments.forEach((segment, index) => {
        const endpoints = getBranchSegmentEndpoints(branch, segment, index, parentKnot);
        if (!endpoints) return;
        pushSegment(toVec3(endpoints.start), toVec3(endpoints.end), segment.diameter, branch.modelId ?? null);
        pushJointSphere(segment.topJoint, branch.modelId ?? null);
        pushJointSphere(segment.bottomJoint, branch.modelId ?? null);
      });

      pushContactConeVisuals(branch.contactCone, branch.modelId ?? null);
    }

    for (const leaf of Object.values(supportState.leaves)) {
      pushContactConeVisuals(leaf.contactCone, leaf.modelId ?? null);
    }

    for (const twig of Object.values(supportState.twigs)) {
      for (const segment of twig.segments) {
        const start = segment.bottomJoint ? toVec3(segment.bottomJoint.pos) : diskTipCenter(twig.contactDiskA);
        const end = segment.topJoint ? toVec3(segment.topJoint.pos) : diskTipCenter(twig.contactDiskB);
        pushSegment(start, end, segment.diameter, twig.modelId ?? null);
        pushJointSphere(segment.topJoint, twig.modelId ?? null);
        pushJointSphere(segment.bottomJoint, twig.modelId ?? null);
      }

      const diskATip = diskTipCenter(twig.contactDiskA);
      pushSegment(toVec3(twig.contactDiskA.pos), diskATip, twig.contactDiskA.contactDiameterMm, twig.modelId ?? null);
      tips.push({
        center: diskATip,
        radius: Math.max(0.03, (twig.contactDiskA.contactDiameterMm ?? 0.2) * 0.5),
        modelId: twig.modelId ?? null,
      });

      const diskBTip = diskTipCenter(twig.contactDiskB);
      pushSegment(toVec3(twig.contactDiskB.pos), diskBTip, twig.contactDiskB.contactDiameterMm, twig.modelId ?? null);
      tips.push({
        center: diskBTip,
        radius: Math.max(0.03, (twig.contactDiskB.contactDiameterMm ?? 0.2) * 0.5),
        modelId: twig.modelId ?? null,
      });
    }

    for (const stick of Object.values(supportState.sticks)) {
      for (const segment of stick.segments) {
        const start = segment.bottomJoint ? toVec3(segment.bottomJoint.pos) : toVec3(getFinalSocketPosition(stick.contactConeA));
        const end = segment.topJoint ? toVec3(segment.topJoint.pos) : toVec3(getFinalSocketPosition(stick.contactConeB));
        pushSegment(start, end, segment.diameter, stick.modelId ?? null);
        pushJointSphere(segment.topJoint, stick.modelId ?? null);
        pushJointSphere(segment.bottomJoint, stick.modelId ?? null);
      }

      pushContactConeVisuals(stick.contactConeA, stick.modelId ?? null);
      pushContactConeVisuals(stick.contactConeB, stick.modelId ?? null);
    }

    for (const brace of Object.values(supportState.braces)) {
      const startKnot = supportState.knots[brace.startKnotId];
      const endKnot = supportState.knots[brace.endKnotId];
      if (!startKnot || !endKnot) continue;
      pushSegment(toVec3(startKnot.pos), toVec3(endKnot.pos), Math.max(0.1, brace.profile?.diameter ?? 1), brace.modelId ?? null);
    }

    for (const supportBrace of Object.values(supportBraceState.supportBraces)) {
      const root = supportState.roots[supportBrace.rootId] ?? supportBraceState.roots[supportBrace.rootId];
      const hostKnot = supportState.knots[supportBrace.hostKnotId] ?? supportBraceState.knots[supportBrace.hostKnotId];
      if (!root || !hostKnot) continue;

      const basePos = new THREE.Vector3(root.transform.pos.x, root.transform.pos.y, root.transform.pos.z + root.diskHeight + root.coneHeight);
      let currentStart = basePos;

      for (let index = 0; index < supportBrace.segments.length; index += 1) {
        const segment = supportBrace.segments[index];
        const end = segment.topJoint ? toVec3(segment.topJoint.pos) : toVec3(hostKnot.pos);
        pushSegment(currentStart, end, segment.diameter, supportBrace.modelId ?? null);
        pushJointSphere(segment.topJoint, supportBrace.modelId ?? null);
        pushJointSphere(segment.bottomJoint, supportBrace.modelId ?? null);
        currentStart = end;
      }
    }

    for (const knot of Object.values(supportState.knots)) {
      spheres.push({
        center: toVec3(knot.pos),
        radius: Math.max(0.02, ((knot.diameter ?? 0.2) * 0.5) * 0.55),
        modelId: null,
      });
    }

    return {
      segmentInstances: segments,
      sphereInstances: spheres,
      tipInstances: tips,
      frustumInstances: frustums,
    };
  }, [supportState, supportBraceState, raftState.bottomMode, raftState.thickness]);

  const resolveColor = React.useCallback((modelId: string | null) => {
    const base = new THREE.Color('#a3a3a3');
    const accent = new THREE.Color('#ff8800');

    if (activeModelId && modelId && modelId === activeModelId) {
      return accent;
    }

    if (!activeModelId && hoverModelId && modelId && modelId === hoverModelId) {
      return base.clone().lerp(accent, 0.5);
    }

    return base;
  }, [activeModelId, hoverModelId]);

  const cylinderGeometry = useMemo(() => new THREE.CylinderGeometry(1, 1, 1, 10, 1, false), []);
  const sphereGeometry = useMemo(() => new THREE.SphereGeometry(1, 8, 6), []);

  useLayoutEffect(() => {
    return () => {
      cylinderGeometry.dispose();
      sphereGeometry.dispose();
    };
  }, [cylinderGeometry, sphereGeometry]);

  const segmentMeshRef = useRef<THREE.InstancedMesh>(null);
  const sphereMeshRef = useRef<THREE.InstancedMesh>(null);
  const tipMeshRef = useRef<THREE.InstancedMesh>(null);
  const frustumGroupRef = useRef<THREE.Group>(null);
  const segmentPickIdRef = useRef<number | null>(null);
  const spherePickIdRef = useRef<number | null>(null);
  const tipPickIdRef = useRef<number | null>(null);
  const frustumPickIdRef = useRef<number | null>(null);

  React.useEffect(() => {
    if (!config.enabled) return;

    const segmentObject = segmentMeshRef.current;
    const sphereObject = sphereMeshRef.current;
    const tipObject = tipMeshRef.current;
    const frustumObject = frustumGroupRef.current;

    if (segmentObject && segmentPickIdRef.current == null) {
      segmentPickIdRef.current = register({
        category: 'support',
        objectId: 'support-batched-segments',
        object: segmentObject,
      });
    }

    if (sphereObject && spherePickIdRef.current == null) {
      spherePickIdRef.current = register({
        category: 'support',
        objectId: 'support-batched-spheres',
        object: sphereObject,
      });
    }

    if (tipObject && tipPickIdRef.current == null) {
      tipPickIdRef.current = register({
        category: 'support',
        objectId: 'support-batched-tips',
        object: tipObject,
      });
    }

    if (frustumObject && frustumPickIdRef.current == null) {
      frustumPickIdRef.current = register({
        category: 'support',
        objectId: 'support-batched-frustums',
        object: frustumObject,
      });
    }

    return () => {
      if (segmentPickIdRef.current != null) {
        unregister(segmentPickIdRef.current);
        segmentPickIdRef.current = null;
      }

      if (spherePickIdRef.current != null) {
        unregister(spherePickIdRef.current);
        spherePickIdRef.current = null;
      }

      if (tipPickIdRef.current != null) {
        unregister(tipPickIdRef.current);
        tipPickIdRef.current = null;
      }

      if (frustumPickIdRef.current != null) {
        unregister(frustumPickIdRef.current);
        frustumPickIdRef.current = null;
      }
    };
  }, [config.enabled, register, unregister]);

  useLayoutEffect(() => {
    const mesh = segmentMeshRef.current;
    if (!mesh) return;

    const up = new THREE.Vector3(0, 1, 0);
    const direction = new THREE.Vector3();
    const midpoint = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const matrix = new THREE.Matrix4();

    mesh.count = segmentInstances.length;
    for (let i = 0; i < segmentInstances.length; i += 1) {
      const instance = segmentInstances[i];
      direction.copy(instance.end).sub(instance.start);
      const length = direction.length();
      if (length < 0.001) continue;

      direction.multiplyScalar(1 / length);
      midpoint.copy(instance.start).add(instance.end).multiplyScalar(0.5);
      quaternion.setFromUnitVectors(up, direction);
      scale.set(instance.radius, length, instance.radius);
      matrix.compose(midpoint, quaternion, scale);

      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, resolveColor(instance.modelId));
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [segmentInstances, resolveColor]);

  useLayoutEffect(() => {
    const mesh = sphereMeshRef.current;
    if (!mesh) return;

    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const matrix = new THREE.Matrix4();

    mesh.count = sphereInstances.length;
    for (let i = 0; i < sphereInstances.length; i += 1) {
      const instance = sphereInstances[i];
      scale.set(instance.radius, instance.radius, instance.radius);
      matrix.compose(instance.center, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, resolveColor(instance.modelId));
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [sphereInstances, resolveColor]);

  useLayoutEffect(() => {
    const mesh = tipMeshRef.current;
    if (!mesh) return;

    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const matrix = new THREE.Matrix4();

    mesh.count = tipInstances.length;
    for (let i = 0; i < tipInstances.length; i += 1) {
      const instance = tipInstances[i];
      scale.set(instance.radius, instance.radius, instance.radius);
      matrix.compose(instance.center, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, resolveColor(instance.modelId));
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [tipInstances, resolveColor]);

  return (
    <group>
      <group ref={frustumGroupRef}>
        {frustumInstances.map((instance, index) => {
          const direction = instance.end.clone().sub(instance.start);
          const length = direction.length();
          if (length < 0.001) return null;

          direction.multiplyScalar(1 / length);
          const midpoint = instance.start.clone().add(instance.end).multiplyScalar(0.5);
          const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);

          return (
            <mesh
              key={`support-frustum-${index}`}
              position={[midpoint.x, midpoint.y, midpoint.z]}
              quaternion={quaternion}
              onPointerDown={(e) => {
                if (instance.modelId && onModelPointerSelect) {
                  e.stopPropagation();
                  onModelPointerSelect(instance.modelId);
                }
              }}
              onPointerMove={() => {
                onModelPointerHover?.(instance.modelId ?? null);
              }}
              onPointerOut={() => {
                onModelPointerHover?.(null);
              }}
            >
              <cylinderGeometry args={[instance.endRadius, instance.startRadius, length, 14]} />
              <meshStandardMaterial
                color={resolveColor(instance.modelId)}
                transparent={false}
                roughness={0.66}
                metalness={0.03}
                clippingPlanes={clippingPlanes}
              />
            </mesh>
          );
        })}
      </group>

      <instancedMesh
        ref={segmentMeshRef}
        args={[cylinderGeometry, undefined, Math.max(1, segmentInstances.length)]}
        frustumCulled={false}
        renderOrder={1}
        onPointerDown={(e) => {
          const instanceId = e.instanceId;
          if (instanceId == null) return;
          const modelId = segmentInstances[instanceId]?.modelId;
          if (modelId && onModelPointerSelect) {
            e.stopPropagation();
            onModelPointerSelect(modelId);
          }
        }}
        onPointerMove={(e) => {
          const instanceId = e.instanceId;
          if (instanceId == null) return;
          onModelPointerHover?.(segmentInstances[instanceId]?.modelId ?? null);
        }}
        onPointerOut={() => {
          onModelPointerHover?.(null);
        }}
      >
        <meshStandardMaterial
          transparent={false}
          roughness={0.72}
          metalness={0.02}
          clippingPlanes={clippingPlanes}
        />
      </instancedMesh>

      <instancedMesh
        ref={sphereMeshRef}
        args={[sphereGeometry, undefined, Math.max(1, sphereInstances.length)]}
        frustumCulled={false}
        renderOrder={1}
        onPointerDown={(e) => {
          const instanceId = e.instanceId;
          if (instanceId == null) return;
          const modelId = sphereInstances[instanceId]?.modelId;
          if (modelId && onModelPointerSelect) {
            e.stopPropagation();
            onModelPointerSelect(modelId);
          }
        }}
        onPointerMove={(e) => {
          const instanceId = e.instanceId;
          if (instanceId == null) return;
          onModelPointerHover?.(sphereInstances[instanceId]?.modelId ?? null);
        }}
        onPointerOut={() => {
          onModelPointerHover?.(null);
        }}
      >
        <meshStandardMaterial
          transparent={false}
          roughness={0.68}
          metalness={0.03}
          clippingPlanes={clippingPlanes}
        />
      </instancedMesh>

      <instancedMesh
        ref={tipMeshRef}
        args={[sphereGeometry, undefined, Math.max(1, tipInstances.length)]}
        frustumCulled={false}
        renderOrder={2}
        onPointerDown={(e) => {
          const instanceId = e.instanceId;
          if (instanceId == null) return;
          const modelId = tipInstances[instanceId]?.modelId;
          if (modelId && onModelPointerSelect) {
            e.stopPropagation();
            onModelPointerSelect(modelId);
          }
        }}
        onPointerMove={(e) => {
          const instanceId = e.instanceId;
          if (instanceId == null) return;
          onModelPointerHover?.(tipInstances[instanceId]?.modelId ?? null);
        }}
        onPointerOut={() => {
          onModelPointerHover?.(null);
        }}
      >
        <meshStandardMaterial
          transparent={false}
          roughness={0.52}
          metalness={0.05}
          clippingPlanes={clippingPlanes}
        />
      </instancedMesh>
    </group>
  );
}

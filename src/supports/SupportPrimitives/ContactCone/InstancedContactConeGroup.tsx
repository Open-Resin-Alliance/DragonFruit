import React, { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec3 } from '../../types';
import type { SupportTipProfile } from './types';
import { getConeCenterPosition, getConeQuaternion } from './contactConeUtils';
import { calculateDiskThickness, getDiskCenter, getDiskRotation } from '../ContactDisk/contactDiskUtils';

export interface InstancedContactCone {
    id: string;
    supportId?: string;
    modelId?: string;
    pos: Vec3;
    normal: Vec3;
    surfaceNormal?: Vec3;
    diskLengthOverride?: number;
    profile: SupportTipProfile;
}

interface InstancedContactConeGroupProps {
    cones: InstancedContactCone[];
    color?: string;
    emissive?: string;
    emissiveIntensity?: number;
    transparent?: boolean;
    opacity?: number;
    onConeClick?: (cone: InstancedContactCone, event: ThreeEvent<MouseEvent>) => void;
    onConePointerMove?: (cone: InstancedContactCone, event: ThreeEvent<PointerEvent>) => void;
    onConePointerOut?: (cone: InstancedContactCone | null, event: ThreeEvent<PointerEvent>) => void;
}

interface ConeBucket {
    key: string;
    cones: InstancedContactCone[];
    profileType: 'disk' | 'sphere' | 'legacy';
    contactRadius: number;
    bodyRadius: number;
    length: number;
    diskThickness: number;
    penetration: number;
}

const quantize = (value: number) => Math.round(value * 1000) / 1000;

const getProfileType = (profile: SupportTipProfile): 'disk' | 'sphere' | 'legacy' => {
    if (profile.type === 'disk') return 'disk';
    if (profile.type === 'sphere') return 'sphere';
    return 'legacy';
};

const getDiskThicknessForCone = (cone: InstancedContactCone): number => {
    if (cone.profile.type !== 'disk') return 0;
    const effectiveSurfaceNormal = cone.surfaceNormal ?? cone.normal;
    return cone.diskLengthOverride ?? calculateDiskThickness(effectiveSurfaceNormal, cone.normal, cone.profile);
};

function ConeBucketMesh({
    bucket,
    diskThicknessByCone,
    color,
    emissive,
    emissiveIntensity,
    transparent,
    opacity,
    onConeClick,
    onConePointerMove,
    onConePointerOut,
}: {
    bucket: ConeBucket;
    diskThicknessByCone: ReadonlyMap<InstancedContactCone, number>;
    color: string;
    emissive: string;
    emissiveIntensity: number;
    transparent: boolean;
    opacity: number;
    onConeClick?: (cone: InstancedContactCone, event: ThreeEvent<MouseEvent>) => void;
    onConePointerMove?: (cone: InstancedContactCone, event: ThreeEvent<PointerEvent>) => void;
    onConePointerOut?: (cone: InstancedContactCone | null, event: ThreeEvent<PointerEvent>) => void;
}) {
    const diskRef = useRef<THREE.InstancedMesh>(null);
    const bodyRef = useRef<THREE.InstancedMesh>(null);
    const tipSphereRef = useRef<THREE.InstancedMesh>(null);
    const lastHoveredRef = useRef<InstancedContactCone | null>(null);

    const resolveDiskThickness = (cone: InstancedContactCone) => {
        if (cone.profile.type !== 'disk') return 0;
        return diskThicknessByCone.get(cone)
            ?? getDiskThicknessForCone(cone);
    };

    useLayoutEffect(() => {
        const tempObject = new THREE.Object3D();

        const setInstanceMatrices = (
            mesh: THREE.InstancedMesh | null,
            transform: (cone: InstancedContactCone) => { position: THREE.Vector3; quaternion: THREE.Quaternion },
        ) => {
            if (!mesh) return;
            for (let i = 0; i < bucket.cones.length; i += 1) {
                const cone = bucket.cones[i];
                const { position, quaternion } = transform(cone);
                tempObject.position.copy(position);
                tempObject.quaternion.copy(quaternion);
                tempObject.scale.set(1, 1, 1);
                tempObject.updateMatrix();
                mesh.setMatrixAt(i, tempObject.matrix);
            }
            mesh.count = bucket.cones.length;
            mesh.instanceMatrix.needsUpdate = true;
        };

        setInstanceMatrices(bodyRef.current, (cone) => {
            const effectiveSurfaceNormal = cone.surfaceNormal ?? cone.normal;
            const primitiveThickness = bucket.profileType === 'disk' ? resolveDiskThickness(cone) : 0;
            const coneStart = {
                x: cone.pos.x + effectiveSurfaceNormal.x * primitiveThickness,
                y: cone.pos.y + effectiveSurfaceNormal.y * primitiveThickness,
                z: cone.pos.z + effectiveSurfaceNormal.z * primitiveThickness,
            };
            const center = getConeCenterPosition(coneStart, cone.normal, cone.profile);
            return {
                position: new THREE.Vector3(center.x, center.y, center.z),
                quaternion: getConeQuaternion(cone.normal),
            };
        });

        setInstanceMatrices(tipSphereRef.current, (cone) => {
            const effectiveSurfaceNormal = cone.surfaceNormal ?? cone.normal;
            const primitiveThickness = bucket.profileType === 'disk' ? resolveDiskThickness(cone) : 0;
            const coneStart = new THREE.Vector3(
                cone.pos.x + effectiveSurfaceNormal.x * primitiveThickness,
                cone.pos.y + effectiveSurfaceNormal.y * primitiveThickness,
                cone.pos.z + effectiveSurfaceNormal.z * primitiveThickness,
            );
            return { position: coneStart, quaternion: new THREE.Quaternion() };
        });

        setInstanceMatrices(diskRef.current, (cone) => {
            const effectiveSurfaceNormal = cone.surfaceNormal ?? cone.normal;
            const thickness = resolveDiskThickness(cone);
            const center = getDiskCenter(cone.pos, effectiveSurfaceNormal, thickness);
            const penetration = Math.max(0, cone.profile.penetrationMm ?? 0);
            return {
                position: new THREE.Vector3(
                    center.x - effectiveSurfaceNormal.x * (penetration / 2),
                    center.y - effectiveSurfaceNormal.y * (penetration / 2),
                    center.z - effectiveSurfaceNormal.z * (penetration / 2),
                ),
                quaternion: getDiskRotation(effectiveSurfaceNormal),
            };
        });
    }, [bucket, diskThicknessByCone]);

    const resolveCone = (instanceId: number | undefined | null) => {
        if (instanceId == null) return null;
        return bucket.cones[instanceId] ?? null;
    };

    const handleClick = (event: ThreeEvent<MouseEvent>) => {
        if (!onConeClick) return;
        event.stopPropagation();
        const cone = resolveCone(event.instanceId);
        if (!cone) return;
        onConeClick(cone, event);
    };

    const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
        if (!onConePointerMove) return;
        event.stopPropagation();
        const cone = resolveCone(event.instanceId);
        if (!cone) return;
        lastHoveredRef.current = cone;
        onConePointerMove(cone, event);
    };

    const handlePointerOut = (event: ThreeEvent<PointerEvent>) => {
        if (!onConePointerOut) return;
        event.stopPropagation();
        onConePointerOut(lastHoveredRef.current, event);
        lastHoveredRef.current = null;
    };

    const sharedHandlers = {
        onClick: onConeClick ? handleClick : undefined,
        onPointerMove: onConePointerMove ? handlePointerMove : undefined,
        onPointerOut: onConePointerOut ? handlePointerOut : undefined,
    };

    return (
        <group>
            {bucket.profileType === 'disk' && (
                <instancedMesh
                    ref={diskRef}
                    args={[undefined, undefined, bucket.cones.length]}
                    frustumCulled={false}
                    {...sharedHandlers}
                >
                    <cylinderGeometry args={[bucket.contactRadius, bucket.contactRadius, bucket.diskThickness + bucket.penetration, 10]} />
                    <meshStandardMaterial
                        color={color}
                        emissive={emissive}
                        emissiveIntensity={emissiveIntensity}
                        transparent={transparent}
                        opacity={opacity}
                        depthWrite={!transparent}
                        polygonOffset
                        polygonOffsetFactor={1}
                        polygonOffsetUnits={1}
                    />
                </instancedMesh>
            )}

            <instancedMesh
                ref={bodyRef}
                args={[undefined, undefined, bucket.cones.length]}
                frustumCulled={false}
                {...sharedHandlers}
            >
                <cylinderGeometry args={[bucket.contactRadius, bucket.bodyRadius, bucket.length, 10]} />
                <meshStandardMaterial
                    color={color}
                    emissive={emissive}
                    emissiveIntensity={emissiveIntensity}
                    transparent={transparent}
                    opacity={opacity}
                    depthWrite={!transparent}
                />
            </instancedMesh>

            <instancedMesh
                ref={tipSphereRef}
                args={[undefined, undefined, bucket.cones.length]}
                frustumCulled={false}
                {...sharedHandlers}
            >
                <sphereGeometry args={[bucket.contactRadius, 10, 8]} />
                <meshStandardMaterial
                    color={color}
                    emissive={emissive}
                    emissiveIntensity={emissiveIntensity}
                    transparent={transparent}
                    opacity={opacity}
                    depthWrite={!transparent}
                />
            </instancedMesh>
        </group>
    );
}

export function InstancedContactConeGroup({
    cones,
    color = '#ff8800',
    emissive = '#000000',
    emissiveIntensity = 0,
    transparent = false,
    opacity = 1,
    onConeClick,
    onConePointerMove,
    onConePointerOut,
}: InstancedContactConeGroupProps) {
    const validCones = useMemo(() => {
        return cones.filter((cone) => {
            const normalLenSq = (cone.normal.x * cone.normal.x) + (cone.normal.y * cone.normal.y) + (cone.normal.z * cone.normal.z);
            return normalLenSq > 1e-8;
        });
    }, [cones]);

    const diskThicknessByCone = useMemo(() => {
        const map = new Map<InstancedContactCone, number>();
        for (const cone of validCones) {
            map.set(cone, getDiskThicknessForCone(cone));
        }
        return map;
    }, [validCones]);

    const buckets = useMemo(() => {
        const grouped = new Map<string, ConeBucket>();

        for (const cone of validCones) {
            const profileType = getProfileType(cone.profile);
            const diskThickness = profileType === 'disk'
                ? (diskThicknessByCone.get(cone) ?? getDiskThicknessForCone(cone))
                : 0;
            const contactRadius = Math.max(0.001, cone.profile.contactDiameterMm / 2);
            const bodyRadius = Math.max(0.001, cone.profile.bodyDiameterMm / 2);
            const length = Math.max(0.001, cone.profile.lengthMm);
            const penetration = Math.max(0, cone.profile.penetrationMm ?? 0);

            const key = [
                profileType,
                quantize(contactRadius),
                quantize(bodyRadius),
                quantize(length),
                quantize(diskThickness),
                quantize(penetration),
            ].join(':');

            const existing = grouped.get(key);
            if (existing) {
                existing.cones.push(cone);
                continue;
            }

            grouped.set(key, {
                key,
                cones: [cone],
                profileType,
                contactRadius,
                bodyRadius,
                length,
                diskThickness,
                penetration,
            });
        }

        return Array.from(grouped.values());
    }, [validCones, diskThicknessByCone]);

    if (validCones.length === 0) return null;

    return (
        <group>
            {buckets.map((bucket) => (
                <ConeBucketMesh
                    key={bucket.key}
                    bucket={bucket}
                    diskThicknessByCone={diskThicknessByCone}
                    color={color}
                    emissive={emissive}
                    emissiveIntensity={emissiveIntensity}
                    transparent={transparent}
                    opacity={opacity}
                    onConeClick={onConeClick}
                    onConePointerMove={onConePointerMove}
                    onConePointerOut={onConePointerOut}
                />
            ))}
        </group>
    );
}

import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec3 } from '../../types';
import type { SupportTipProfile } from './types';
import { getConeCenterPosition, getConeQuaternion } from './contactConeUtils';
import { calculateDiskThickness, createContactDiskLoftGeometry, getContactDiskGeometrySpec, resolveContactDiskRadialSegments, resolveContactFaceShape } from '../ContactDisk/contactDiskUtils';

// Tip primitives (cone body, tip ball, disk loft) share one tessellation.
// The disk/ball/cone junction is three nearly-tangent solids, so every
// facet-scale tolerance there (crossing-seam zigzag, the loft's
// ball-circumscribing inflation) is directly proportional to facet size —
// at the old 10 segments those artifacts were visible pixels on deselected
// supports next to the 24-segment detailed (selected) renderer. 16 keeps
// them sub-pixel at normal zoom while staying cheap enough to instance in
// bulk.
const INSTANCED_TIP_RADIAL_SEGMENTS = 16;

export interface InstancedContactCone {
    id: string;
    supportId?: string;
    modelId?: string;
    pos: Vec3;
    normal: Vec3;
    surfaceNormal?: Vec3;
    diskLengthOverride?: number;
    contactFaceRatio?: number;    // Oval contact face: squished-axis fraction (1/absent = circle)
    contactFaceAngleRad?: number; // Oval contact face: rotation about the disc normal
    profile: SupportTipProfile;
}

interface InstancedContactConeGroupProps {
    cones: InstancedContactCone[];
    color?: string;
    emissive?: string;
    emissiveIntensity?: number;
    transparent?: boolean;
    opacity?: number;
    clippingPlanes?: THREE.Plane[] | null;
    outOfBoundsMaterial?: THREE.ShaderMaterial | null;
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
    contactFaceRatio: number; // Oval squish — part of the bucket key (shape is baked into the geometry)
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

// Compose the per-instance oval rotation (about local Y = the disc normal)
// into the disk alignment quaternion. Scratch objects — consumed immediately
// by setInstanceMatrices' tempObject.quaternion.copy().
const _faceAngleAxis = new THREE.Vector3(0, 1, 0);
const _faceAngleQuat = new THREE.Quaternion();
const applyContactFaceAngle = (rotation: THREE.Quaternion, cone: InstancedContactCone): THREE.Quaternion => {
    const { angleRad } = resolveContactFaceShape(cone);
    if (angleRad === 0) return rotation;
    _faceAngleQuat.setFromAxisAngle(_faceAngleAxis, angleRad);
    return rotation.multiply(_faceAngleQuat);
};

function ConeBucketMesh({
    bucket,
    diskThicknessByCone,
    color,
    emissive,
    emissiveIntensity,
    transparent,
    opacity,
    clippingPlanes,
    outOfBoundsMaterial,
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
    clippingPlanes: THREE.Plane[] | null;
    outOfBoundsMaterial?: THREE.ShaderMaterial | null;
    onConeClick?: (cone: InstancedContactCone, event: ThreeEvent<MouseEvent>) => void;
    onConePointerMove?: (cone: InstancedContactCone, event: ThreeEvent<PointerEvent>) => void;
    onConePointerOut?: (cone: InstancedContactCone | null, event: ThreeEvent<PointerEvent>) => void;
}) {
    const diskRef = useRef<THREE.InstancedMesh>(null);
    const bodyRef = useRef<THREE.InstancedMesh>(null);
    const tipSphereRef = useRef<THREE.InstancedMesh>(null);
    const overlayDiskRef = useRef<THREE.InstancedMesh>(null);
    const overlayBodyRef = useRef<THREE.InstancedMesh>(null);
    const overlayTipSphereRef = useRef<THREE.InstancedMesh>(null);
    const lastHoveredRef = useRef<InstancedContactCone | null>(null);

    const hasOverlay = !!outOfBoundsMaterial;

    // Shared per-bucket disk solid — two-stage oval loft (plain cylinder when
    // ratio = 1). Shape is baked per bucket; oval angle is per-instance.
    const diskGeometry = useMemo(() => (
        bucket.profileType === 'disk'
            ? createContactDiskLoftGeometry({
                radius: bucket.contactRadius,
                ratio: bucket.contactFaceRatio,
                thickness: bucket.diskThickness,
                penetrationMm: bucket.penetration,
                // Oval buckets upgrade to the fine wall (24); circles stay cheap.
                radialSegments: resolveContactDiskRadialSegments(INSTANCED_TIP_RADIAL_SEGMENTS, bucket.contactFaceRatio),
            })
            : null
    ), [bucket]);

    useEffect(() => () => { diskGeometry?.dispose(); }, [diskGeometry]);

    const resolveDiskThickness = (cone: InstancedContactCone) => {
        if (cone.profile.type !== 'disk') return 0;
        return diskThicknessByCone.get(cone)
            ?? getDiskThicknessForCone(cone);
    };

    // Canonical disk solid for a cone — same math as the detailed renderer,
    // file export, and slicer feed (see getContactDiskGeometrySpec). The bucket
    // key already includes quantized thickness + penetration, so the shared
    // cylinder height (diskThickness + penetration) matches every instance.
    const resolveDiskSpec = (cone: InstancedContactCone) => {
        const effectiveSurfaceNormal = cone.surfaceNormal ?? cone.normal;
        return getContactDiskGeometrySpec({
            pos: cone.pos,
            surfaceNormal: effectiveSurfaceNormal,
            coneAxis: cone.normal,
            profile: cone.profile,
            contactDiameterMm: cone.profile.contactDiameterMm,
            overrideThickness: resolveDiskThickness(cone),
        });
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
            const spec = resolveDiskSpec(cone);
            return {
                position: new THREE.Vector3(spec.center.x, spec.center.y, spec.center.z),
                quaternion: applyContactFaceAngle(spec.rotation, cone),
            };
        });

        // Overlay meshes share the same transforms
        setInstanceMatrices(overlayBodyRef.current, (cone) => {
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

        setInstanceMatrices(overlayTipSphereRef.current, (cone) => {
            const effectiveSurfaceNormal = cone.surfaceNormal ?? cone.normal;
            const primitiveThickness = bucket.profileType === 'disk' ? resolveDiskThickness(cone) : 0;
            const coneStart = new THREE.Vector3(
                cone.pos.x + effectiveSurfaceNormal.x * primitiveThickness,
                cone.pos.y + effectiveSurfaceNormal.y * primitiveThickness,
                cone.pos.z + effectiveSurfaceNormal.z * primitiveThickness,
            );
            return { position: coneStart, quaternion: new THREE.Quaternion() };
        });

        setInstanceMatrices(overlayDiskRef.current, (cone) => {
            const spec = resolveDiskSpec(cone);
            return {
                position: new THREE.Vector3(spec.center.x, spec.center.y, spec.center.z),
                quaternion: applyContactFaceAngle(spec.rotation, cone),
            };
        });
    }, [bucket, diskThicknessByCone, hasOverlay]);

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
            {bucket.profileType === 'disk' && diskGeometry && (
                <instancedMesh
                    ref={diskRef}
                    args={[undefined, undefined, bucket.cones.length]}
                    geometry={diskGeometry}
                    frustumCulled={false}
                    renderOrder={100000}
                    {...sharedHandlers}
                >
                    <meshStandardMaterial
                        color={color}
                        emissive={emissive}
                        emissiveIntensity={emissiveIntensity}
                        transparent={transparent}
                        opacity={opacity}
                        depthWrite={!transparent}
                        clippingPlanes={clippingPlanes ?? undefined}
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
                renderOrder={100000}
                {...sharedHandlers}
            >
                <cylinderGeometry args={[bucket.contactRadius, bucket.bodyRadius, bucket.length, INSTANCED_TIP_RADIAL_SEGMENTS]} />
                <meshStandardMaterial
                    color={color}
                    emissive={emissive}
                    emissiveIntensity={emissiveIntensity}
                    transparent={transparent}
                    opacity={opacity}
                    depthWrite={!transparent}
                    clippingPlanes={clippingPlanes ?? undefined}
                />
            </instancedMesh>

            <instancedMesh
                ref={tipSphereRef}
                args={[undefined, undefined, bucket.cones.length]}
                frustumCulled={false}
                renderOrder={100000}
                {...sharedHandlers}
            >
                <sphereGeometry args={[bucket.contactRadius, INSTANCED_TIP_RADIAL_SEGMENTS, 12]} />
                <meshStandardMaterial
                    color={color}
                    emissive={emissive}
                    emissiveIntensity={emissiveIntensity}
                    transparent={transparent}
                    opacity={opacity}
                    depthWrite={!transparent}
                    clippingPlanes={clippingPlanes ?? undefined}
                />
            </instancedMesh>

            {outOfBoundsMaterial && (
                <>
                    <instancedMesh
                        ref={overlayBodyRef}
                        args={[undefined, undefined, bucket.cones.length]}
                        frustumCulled={false}
                        raycast={() => null}
                        renderOrder={100000}
                        material={outOfBoundsMaterial}
                    >
                        <cylinderGeometry args={[bucket.contactRadius, bucket.bodyRadius, bucket.length, INSTANCED_TIP_RADIAL_SEGMENTS]} />
                    </instancedMesh>
                    <instancedMesh
                        ref={overlayTipSphereRef}
                        args={[undefined, undefined, bucket.cones.length]}
                        frustumCulled={false}
                        raycast={() => null}
                        renderOrder={100000}
                        material={outOfBoundsMaterial}
                    >
                        <sphereGeometry args={[bucket.contactRadius, INSTANCED_TIP_RADIAL_SEGMENTS, 12]} />
                    </instancedMesh>
                    {bucket.profileType === 'disk' && diskGeometry && (
                        <instancedMesh
                            ref={overlayDiskRef}
                            args={[undefined, undefined, bucket.cones.length]}
                            geometry={diskGeometry}
                            frustumCulled={false}
                            raycast={() => null}
                            renderOrder={100000}
                            material={outOfBoundsMaterial}
                        />
                    )}
                </>
            )}
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
    clippingPlanes = null,
    outOfBoundsMaterial = null,
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
            // Oval ratio joins the bucket key (shape is baked into the shared
            // geometry); the oval ANGLE stays per-instance via the quaternion.
            const contactFaceRatio = profileType === 'disk' ? resolveContactFaceShape(cone).ratio : 1;

            const key = [
                profileType,
                quantize(contactRadius),
                quantize(bodyRadius),
                quantize(length),
                quantize(diskThickness),
                quantize(penetration),
                quantize(contactFaceRatio),
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
                contactFaceRatio,
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
                    clippingPlanes={clippingPlanes}
                    outOfBoundsMaterial={outOfBoundsMaterial}
                    onConeClick={onConeClick}
                    onConePointerMove={onConePointerMove}
                    onConePointerOut={onConePointerOut}
                />
            ))}
        </group>
    );
}

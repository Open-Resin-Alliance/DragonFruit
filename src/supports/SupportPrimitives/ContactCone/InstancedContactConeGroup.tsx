import React, { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec3 } from '../../types';
import type { SupportTipProfile } from './types';
import { getConeCenterPosition, getConeQuaternion } from './contactConeUtils';
import { calculateDiskThickness, getDiskCenter, getDiskRotation } from '../ContactDisk/contactDiskUtils';
import { subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreServerSnapshot, getActiveMaterialProfile, getActivePrinterProfile } from '@/features/profiles/profileStore';
import { calculateTipOffset } from '@/supports/rendering/calculateTipOffset';
import { quantizeToScale } from '@/utils/math';

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
    /**
     * Keep only the contact primitive: the disk for a disk profile, the tip
     * sphere otherwise. The cone body is left to the caller, which draws it as
     * a line in the navigation view.
     */
    discsOnly?: boolean;
    /** Colour for the contact primitive in the discs-only view, so the discs
     *  stand out from the member colours around them. */
    discColor?: string;
    color?: string;
    emissive?: string;
    emissiveIntensity?: number;
    transparent?: boolean;
    opacity?: number;
    clippingPlanes?: THREE.Plane[] | null;
    outOfBoundsMaterial?: THREE.ShaderMaterial | null;
    onConeClick?: (cone: InstancedContactCone, event: ThreeEvent<MouseEvent>) => void;
    onConePointerDown?: (cone: InstancedContactCone, event: ThreeEvent<PointerEvent>) => void;
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

/**
 * The cone's visual axis in world space: the socket the member's shaft ends at,
 * and the centre of the contact primitive it grows from. The navigation view
 * draws this where the cone body would be, so its line meets the shaft line at
 * the socket instead of leaving a gap there.
 */
export function coneAxisSpan(cone: InstancedContactCone): { start: Vec3; end: Vec3 } {
    const surfaceNormal = cone.surfaceNormal ?? cone.normal;
    const thickness = getDiskThicknessForCone(cone);
    const coneStart = {
        x: cone.pos.x + surfaceNormal.x * thickness,
        y: cone.pos.y + surfaceNormal.y * thickness,
        z: cone.pos.z + surfaceNormal.z * thickness,
    };
    const halfLength = cone.profile.lengthMm / 2;
    const centre = getConeCenterPosition(coneStart, cone.normal, cone.profile);
    return {
        // The far end of the body, which is where the shaft's last segment ends.
        start: {
            x: centre.x + cone.normal.x * halfLength,
            y: centre.y + cone.normal.y * halfLength,
            z: centre.z + cone.normal.z * halfLength,
        },
        end: cone.profile.type === 'disk'
            ? getDiskCenter(cone.pos, surfaceNormal, thickness)
            : coneStart,
    };
}

function ConeBucketMesh({
    bucket,
    discsOnly = false,
    discColor,
    diskThicknessByCone,
    color,
    emissive,
    emissiveIntensity,
    transparent,
    opacity,
    clippingPlanes,
    outOfBoundsMaterial,
    onConeClick,
    onConePointerDown,
    onConePointerMove,
    onConePointerOut,
    resolvePenetration,
}: {
    bucket: ConeBucket;
    discsOnly?: boolean;
    discColor?: string;
    diskThicknessByCone: ReadonlyMap<InstancedContactCone, number>;
    color: string;
    emissive: string;
    emissiveIntensity: number;
    transparent: boolean;
    opacity: number;
    clippingPlanes?: THREE.Plane[] | null;
    outOfBoundsMaterial?: THREE.ShaderMaterial | null;
    onConeClick?: (cone: InstancedContactCone, event: ThreeEvent<MouseEvent>) => void;
    onConePointerDown?: (cone: InstancedContactCone, event: ThreeEvent<PointerEvent>) => void;
    onConePointerMove?: (cone: InstancedContactCone, event: ThreeEvent<PointerEvent>) => void;
    onConePointerOut?: (cone: InstancedContactCone | null, event: ThreeEvent<PointerEvent>) => void;
    resolvePenetration: (cone: InstancedContactCone) => number;
}) {
    const diskRef = useRef<THREE.InstancedMesh>(null);
    const bodyRef = useRef<THREE.InstancedMesh>(null);
    const tipSphereRef = useRef<THREE.InstancedMesh>(null);
    const overlayDiskRef = useRef<THREE.InstancedMesh>(null);
    const overlayBodyRef = useRef<THREE.InstancedMesh>(null);
    const overlayTipSphereRef = useRef<THREE.InstancedMesh>(null);
    const lastHoveredRef = useRef<InstancedContactCone | null>(null);

    const hasOverlay = !!outOfBoundsMaterial;

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
            const penetration = Math.max(0, resolvePenetration(cone));
            return {
                position: new THREE.Vector3(
                    center.x - effectiveSurfaceNormal.x * (penetration / 2),
                    center.y - effectiveSurfaceNormal.y * (penetration / 2),
                    center.z - effectiveSurfaceNormal.z * (penetration / 2),
                ),
                quaternion: getDiskRotation(effectiveSurfaceNormal),
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
            const effectiveSurfaceNormal = cone.surfaceNormal ?? cone.normal;
            const thickness = resolveDiskThickness(cone);
            const center = getDiskCenter(cone.pos, effectiveSurfaceNormal, thickness);
            const penetration = Math.max(0, resolvePenetration(cone));
            return {
                position: new THREE.Vector3(
                    center.x - effectiveSurfaceNormal.x * (penetration / 2),
                    center.y - effectiveSurfaceNormal.y * (penetration / 2),
                    center.z - effectiveSurfaceNormal.z * (penetration / 2),
                ),
                quaternion: getDiskRotation(effectiveSurfaceNormal),
            };
        });
    }, [bucket, diskThicknessByCone, hasOverlay, resolvePenetration]);

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

    const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
        if (!onConePointerDown) return;
        event.stopPropagation();
        const cone = resolveCone(event.instanceId);
        if (!cone) return;
        onConePointerDown(cone, event);
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
        onPointerDown: onConePointerDown ? handlePointerDown : undefined,
        onPointerMove: onConePointerMove ? handlePointerMove : undefined,
        onPointerOut: onConePointerOut ? handlePointerOut : undefined,
    };

    return (
        <group>
            {bucket.profileType === 'disk' && (
                // Keyed by count, not just bucket: R3F rebuilds the object in
                // place when args change but never re-registers the new object
                // in its interaction manager, so a grown batch goes dead to
                // hover until anything re-registers it (orbit, reselect). A
                // remount registers fresh. Mirrors the shaft batch key.
                <instancedMesh
                    key={`cone-disk:${bucket.cones.length}`}
                    ref={diskRef}
                    args={[undefined, undefined, bucket.cones.length]}
                    frustumCulled={false}
                    renderOrder={100000}
                    {...sharedHandlers}
                >
                    <cylinderGeometry args={[bucket.contactRadius, bucket.contactRadius, bucket.diskThickness + bucket.penetration, 10]} />
                    <meshStandardMaterial
                        color={discColor ?? color}
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

            {/* The body is a solid with a line form, so the discs-only view drops it
                and the caller draws its axis instead. Unmounted rather than faded:
                a zero-alpha batch left mounted for picking is what kept showing
                cone bodies after a mode switch, because the fade is a material prop
                on an already-built mesh. */}
            {!discsOnly && (
                <instancedMesh
                    key={`cone-body:${bucket.cones.length}`}
                    ref={bodyRef}
                    args={[undefined, undefined, bucket.cones.length]}
                    frustumCulled={false}
                    renderOrder={100000}
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
                        clippingPlanes={clippingPlanes ?? undefined}
                    />
                </instancedMesh>
            )}

            {/* The tip sphere is a sphere profile's contact primitive, so it stays
                visible there; a disk profile draws the disk instead, so this copy
                is not mounted in the discs-only view. */}
            {!(discsOnly && bucket.profileType === 'disk') && (
                <instancedMesh
                    key={`cone-tip:${bucket.cones.length}`}
                    ref={tipSphereRef}
                    args={[undefined, undefined, bucket.cones.length]}
                    frustumCulled={false}
                    renderOrder={100000}
                    {...sharedHandlers}
                >
                    <sphereGeometry args={[bucket.contactRadius, 10, 8]} />
                    <meshStandardMaterial
                        color={discColor ?? color}
                        emissive={emissive}
                        emissiveIntensity={emissiveIntensity}
                        transparent={transparent}
                        opacity={opacity}
                        depthWrite={!transparent}
                        clippingPlanes={clippingPlanes ?? undefined}
                    />
                </instancedMesh>
            )}

            {outOfBoundsMaterial && (
                <>
                    {!discsOnly && (
                        <instancedMesh
                            ref={overlayBodyRef}
                            args={[undefined, undefined, bucket.cones.length]}
                            frustumCulled={false}
                            raycast={() => null}
                            renderOrder={100000}
                            material={outOfBoundsMaterial}
                        >
                            <cylinderGeometry args={[bucket.contactRadius, bucket.bodyRadius, bucket.length, 10]} />
                        </instancedMesh>
                    )}
                    {(!discsOnly || bucket.profileType !== 'disk') && (
                        <instancedMesh
                            ref={overlayTipSphereRef}
                            args={[undefined, undefined, bucket.cones.length]}
                            frustumCulled={false}
                            raycast={() => null}
                            renderOrder={100000}
                            material={outOfBoundsMaterial}
                        >
                            <sphereGeometry args={[bucket.contactRadius, 10, 8]} />
                        </instancedMesh>
                    )}
                    {bucket.profileType === 'disk' && (
                        <instancedMesh
                            ref={overlayDiskRef}
                            args={[undefined, undefined, bucket.cones.length]}
                            frustumCulled={false}
                            raycast={() => null}
                            renderOrder={100000}
                            material={outOfBoundsMaterial}
                        >
                            <cylinderGeometry args={[bucket.contactRadius, bucket.contactRadius, bucket.diskThickness + bucket.penetration, 10]} />
                        </instancedMesh>
                    )}
                </>
            )}
        </group>
    );
}

export function InstancedContactConeGroup({
    cones,
    discsOnly = false,
    discColor,
    color = '#ff8800',
    emissive = '#000000',
    emissiveIntensity = 0,
    transparent = false,
    opacity = 1,
    clippingPlanes = null,
    outOfBoundsMaterial = null,
    onConeClick,
    onConePointerDown,
    onConePointerMove,
    onConePointerOut,
}: InstancedContactConeGroupProps) {
    const storeState = React.useSyncExternalStore(
        subscribeToProfileStore,
        getProfileStoreSnapshot,
        getProfileStoreServerSnapshot
    );
    const activeMaterial = React.useMemo(() => getActiveMaterialProfile(storeState), [storeState]);
    const activePrinter = React.useMemo(() => getActivePrinterProfile(storeState), [storeState]);
    
    const resolvePenetration = React.useCallback((cone: InstancedContactCone) => {
        if (activeMaterial && activePrinter && activeMaterial.antiAliasingSettings?.tipOffsetDisplayInUi) {
            const pxX = activePrinter.pixelSize?.x ? activePrinter.pixelSize.x / 1000 : (activePrinter.buildVolumeMm?.width ?? 143) / (activePrinter.display?.resolutionX ?? 2560);
            const pxY = activePrinter.pixelSize?.y ? activePrinter.pixelSize.y / 1000 : (activePrinter.buildVolumeMm?.depth ?? 89) / (activePrinter.display?.resolutionY ?? 1620);
            return calculateTipOffset(
                activeMaterial.antiAliasingSettings,
                activeMaterial.layerHeightMm,
                pxX,
                pxY
            );
        }
        return cone.profile.penetrationMm ?? 0;
    }, [activeMaterial, activePrinter]);

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
            const penetration = Math.max(0, resolvePenetration(cone));

            const key = [
                profileType,
                quantizeToScale(contactRadius, 1000),
                quantizeToScale(bodyRadius, 1000),
                quantizeToScale(length, 1000),
                quantizeToScale(diskThickness, 1000),
                quantizeToScale(penetration, 1000),
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
    }, [validCones, diskThicknessByCone, resolvePenetration]);

    if (validCones.length === 0) return null;

    return (
        <group>
            {buckets.map((bucket) => (
                <ConeBucketMesh
                    key={bucket.key}
                    bucket={bucket}
                    discsOnly={discsOnly}
                    discColor={discColor}
                    diskThicknessByCone={diskThicknessByCone}
                    color={color}
                    emissive={emissive}
                    emissiveIntensity={emissiveIntensity}
                    transparent={transparent}
                    opacity={opacity}
                    clippingPlanes={clippingPlanes}
                    outOfBoundsMaterial={outOfBoundsMaterial}
                    onConeClick={onConeClick}
                    onConePointerDown={onConePointerDown}
                    onConePointerMove={onConePointerMove}
                    onConePointerOut={onConePointerOut}
                    resolvePenetration={resolvePenetration}
                />
            ))}
        </group>
    );
}

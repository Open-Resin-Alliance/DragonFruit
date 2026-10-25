import React, { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec3 } from '../../types';
import type { SupportTipProfile } from './types';
import { getConeCenterPosition, getConeQuaternionInto } from './contactConeUtils';
import { calculateDiskThickness, getDiskCenter, getDiskRotationInto } from '../ContactDisk/contactDiskUtils';
import { HIDDEN_INSTANCE_MATRIX } from '../hiddenInstanceMatrix';
import { INSTANCED_MESH_RAYCAST } from '../instancedRaycast';
import { writeInstanceColors } from '../instanceColorWriter';
import { buildProxyHoverIndex, createProxyHoverRaycast, type ProxyHoverTarget } from '../../proxyHoverIndex';
import { supportAnswersPointer } from '@/features/scene/plates/plateInteractivity';
import { subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreServerSnapshot, getActiveMaterialProfile, getActivePrinterProfile } from '@/features/profiles/profileStore';
import { calculateTipOffset } from '@/supports/rendering/calculateTipOffset';
import { quantizeToScale } from '@/utils/math';

/** Layout scratch: layouts are synchronous, so the batch kinds can share it. */
const scratchObject = new THREE.Object3D();
const conePosition = new THREE.Vector3();
const coneQuaternion = new THREE.Quaternion();

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
    /**
     * Per-instance colour, for a caller that tints a subset of the batch (the
     * selection). Every instance must be given one: the colour buffer starts
     * black, and the group's own `color` and `discColor` are not used once this
     * is set.
     */
    instanceColor?: (cone: InstancedContactCone) => THREE.Color;
    /**
     * Instances to hide, by the primitive they draw. The world layer keeps an
     * excluded model in its arrays and hides it here, so an activation change
     * costs the changed instances rather than a full re-layout.
     */
    isHidden?: (cone: InstancedContactCone) => boolean;
    /**
     * Grab radius in world units at a distance along the ray. Given one, each
     * bucket answers hover through an index of its own instances rather than
     * three's walk over every one of them, which matters because the buckets are
     * few and large: the batch is keyed on the tip's shape ratio alone.
     */
    grabRadiusAt?: (distance: number) => number;
    /** Models on another bed: their cones stay out of the hover index. See InstancedShaftGroup. */
    pointerSceneryModelIds?: ReadonlySet<string>;
    /**
     * Raycast override, for a caller that wants to answer hover itself.
     */
    raycast?: THREE.Object3D['raycast'];
    onConeClick?: (cone: InstancedContactCone, event: ThreeEvent<MouseEvent>) => void;
    onConePointerDown?: (cone: InstancedContactCone, event: ThreeEvent<PointerEvent>) => void;
    onConePointerMove?: (cone: InstancedContactCone, event: ThreeEvent<PointerEvent>) => void;
    onConePointerOut?: (cone: InstancedContactCone | null, event: ThreeEvent<PointerEvent>) => void;
}

interface ConeBucket {
    key: string;
    cones: InstancedContactCone[];
    profileType: 'disk' | 'sphere' | 'legacy';
    /** How much wider the body is than the contact end. */
    shapeRatio: number;
}

/**
 * The one shape parameter the geometry cannot carry in an instance matrix.
 *
 * The primitives are unit-sized and every dimension rides the instance matrix's
 * scale, so two cones that differ only in size share a mesh. What scale cannot
 * express is the *ratio* between the frustum's ends: a unit frustum scaled by
 * (r, h, r) keeps that ratio, so it is part of the geometry, and the batch is
 * keyed on it alone.
 *
 * That is the whole point of the key. It used to include contactRadius,
 * bodyRadius, length, diskThickness and penetration, each quantized to 0.001 mm,
 * and `penetration` varies with the model surface - so on a scene of 1885 cones
 * the batch became 842 meshes of one or two instances, and each mesh is a draw
 * call on every frame. Keyed on the ratio, the same scene is 41.
 */
export function coneShapeRatio(cone: InstancedContactCone): number {
    const contactRadius = Math.max(0.001, cone.profile.contactDiameterMm / 2);
    const bodyRadius = Math.max(0.001, cone.profile.bodyDiameterMm / 2);
    return bodyRadius / contactRadius;
}

/**
 * Quantization of the frustum's end-to-end ratio, in ratio units.
 *
 * The ratio is the only cone shape parameter an instance matrix cannot carry,
 * so it is part of the bucket key — and the key is a draw-call count: each
 * bucket mounts up to three instanced meshes, in every layer that draws it.
 * A real plate's body-to-contact ratio varies continuously with the support
 * profile (the 20-model scene has 342 distinct values at 0.001 precision), so
 * 0.001 precision produced **2111 draw calls** and a 10 ms CPU render on an
 * RTX 3080.
 *
 * 0.1 parts of the ratio is a body-radius error of at most 5% *of the contact
 * radius* — microns at print resolution — and collapses those 342 values to
 * 34 buckets (17 for the active model), where 0.05 left about twice as many.
 * Cone draw calls are the support layer's bulk and, unlike shafts and joints,
 * they cannot be split spatially without multiplying the buckets, so this is
 * the direct lever on them.
 */
export const CONE_RATIO_BUCKET_STEP = 0.1;
export const CONE_RATIO_BUCKETS_PER_UNIT = 1 / CONE_RATIO_BUCKET_STEP;

/**
 * The key one cone's mesh is grouped under: its profile type and shape ratio, and
 * nothing else. Two cones that differ only in size share a mesh.
 */
export function coneBucketKey(cone: InstancedContactCone): string {
    return `${getProfileType(cone.profile)}:${quantizeToScale(coneShapeRatio(cone), CONE_RATIO_BUCKETS_PER_UNIT)}`;
}

/**
 * The scale that turns each unit primitive into this cone's dimensions.
 *
 * three corrects instance normals for a non-uniform scale (`defaultnormal_vertex`
 * divides by the squared column lengths, in lieu of a per-instance normal
 * matrix), so the frustum body shades correctly at any ratio. Shear is the one
 * thing it does not support, and an axis-aligned scale never introduces it.
 */
export function conePrimitiveScales(
    cone: InstancedContactCone,
    diskThickness: number,
    penetration: number,
): { disk: [number, number, number]; body: [number, number, number]; tip: [number, number, number] } {
    const contactRadius = Math.max(0.001, cone.profile.contactDiameterMm / 2);
    return {
        disk: [contactRadius, Math.max(0.001, diskThickness + penetration), contactRadius],
        body: [contactRadius, Math.max(0.001, cone.profile.lengthMm), contactRadius],
        tip: [contactRadius, contactRadius, contactRadius],
    };
}

/**
 * The profile kind a cone is drawn as. Exported because the capacity batch keys
 * its contact-primitive split on it: `disk` profiles also draw the nib, `sphere`
 * and `legacy` draw the tip ball alone.
 */
export const getProfileType = (profile: SupportTipProfile): 'disk' | 'sphere' | 'legacy' => {
    if (profile.type === 'disk') return 'disk';
    if (profile.type === 'sphere') return 'sphere';
    return 'legacy';
};

/**
 * The nib thickness this cone is drawn with: the authored override, else the
 * angle-dependent `calculateDiskThickness`. Exported so a batch that writes the
 * same disk from a slot list cannot drift from the legacy group's value.
 */
export const getDiskThicknessForCone = (cone: InstancedContactCone): number => {
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
    instanceColor,
    isHidden,
    grabRadiusAt,
    pointerSceneryModelIds,
    raycast,
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
    instanceColor?: (cone: InstancedContactCone) => THREE.Color;
    isHidden?: (cone: InstancedContactCone) => boolean;
    grabRadiusAt?: (distance: number) => number;
    /** Models on another bed: their cones stay out of the hover index. See InstancedShaftGroup. */
    pointerSceneryModelIds?: ReadonlySet<string>;
    raycast?: THREE.Object3D['raycast'];
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

    const hiddenStateRef = React.useRef<Map<InstancedContactCone, boolean>>(new Map());

    const resolveDiskThickness = React.useCallback((cone: InstancedContactCone) => {
        if (cone.profile.type !== 'disk') return 0;
        return diskThicknessByCone.get(cone)
            ?? getDiskThicknessForCone(cone);
    }, [diskThicknessByCone]);

    const hoverRaycast = React.useMemo(() => {
        if (!grabRadiusAt || bucket.cones.length === 0) return undefined;
        const targets: ProxyHoverTarget[] = bucket.cones.map((cone, index) => {
            const normal = cone.surfaceNormal ?? cone.normal;
            const length = Math.max(0.5, cone.profile.lengthMm ?? 0);
            return {
                modelId: cone.modelId,
                index,
                start: cone.pos,
                end: {
                    x: cone.pos.x + normal.x * length,
                    y: cone.pos.y + normal.y * length,
                    z: cone.pos.z + normal.z * length,
                },
                radius: Math.max(0.2, (cone.profile.contactDiameterMm ?? 1) / 2),
            };
        });
        const pickable = targets.filter((target) => supportAnswersPointer(target.modelId, pointerSceneryModelIds));
        const index = buildProxyHoverIndex(pickable);
        return index ? createProxyHoverRaycast(index, grabRadiusAt) : undefined;
    }, [grabRadiusAt, bucket.cones, pointerSceneryModelIds]);

    const writeConeMatrices = React.useCallback((index: number, cone: InstancedContactCone, hidden: boolean) => {
        const meshes = [diskRef.current, bodyRef.current, tipSphereRef.current, overlayDiskRef.current, overlayBodyRef.current, overlayTipSphereRef.current];
        if (hidden) {
            for (const mesh of meshes) if (mesh) mesh.setMatrixAt(index, HIDDEN_INSTANCE_MATRIX);
            return;
        }

        const effectiveSurfaceNormal = cone.surfaceNormal ?? cone.normal;
        const primitiveThickness = bucket.profileType === 'disk' ? resolveDiskThickness(cone) : 0;
        const startX = cone.pos.x + effectiveSurfaceNormal.x * primitiveThickness;
        const startY = cone.pos.y + effectiveSurfaceNormal.y * primitiveThickness;
        const startZ = cone.pos.z + effectiveSurfaceNormal.z * primitiveThickness;

        const scales = conePrimitiveScales(cone, resolveDiskThickness(cone), Math.max(0, resolvePenetration(cone)));

        const write = (
            mesh: THREE.InstancedMesh | null,
            position: THREE.Vector3,
            quaternion: THREE.Quaternion,
            scale: readonly [number, number, number],
        ) => {
            if (!mesh) return;
            scratchObject.position.copy(position);
            scratchObject.quaternion.copy(quaternion);
            scratchObject.scale.set(scale[0], scale[1], scale[2]);
            scratchObject.updateMatrix();
            mesh.setMatrixAt(index, scratchObject.matrix);
        };

        // Body: the cone's own centre along its normal.
        const bodyCenter = getConeCenterPosition({ x: startX, y: startY, z: startZ }, cone.normal, cone.profile);
        conePosition.set(bodyCenter.x, bodyCenter.y, bodyCenter.z);
        getConeQuaternionInto(cone.normal, coneQuaternion);
        write(bodyRef.current, conePosition, coneQuaternion, scales.body);
        write(overlayBodyRef.current, conePosition, coneQuaternion, scales.body);

        // Tip sphere: the contact point itself, unrotated.
        conePosition.set(startX, startY, startZ);
        coneQuaternion.identity();
        write(tipSphereRef.current, conePosition, coneQuaternion, scales.tip);
        write(overlayTipSphereRef.current, conePosition, coneQuaternion, scales.tip);

        // Disk: its own centre, pulled back by half the penetration.
        const diskThickness = resolveDiskThickness(cone);
        const diskCenter = getDiskCenter(cone.pos, effectiveSurfaceNormal, diskThickness);
        const penetration = Math.max(0, resolvePenetration(cone));
        conePosition.set(
            diskCenter.x - effectiveSurfaceNormal.x * (penetration / 2),
            diskCenter.y - effectiveSurfaceNormal.y * (penetration / 2),
            diskCenter.z - effectiveSurfaceNormal.z * (penetration / 2),
        );
        getDiskRotationInto(effectiveSurfaceNormal, coneQuaternion);
        write(diskRef.current, conePosition, coneQuaternion, scales.disk);
        write(overlayDiskRef.current, conePosition, coneQuaternion, scales.disk);
    }, [bucket.profileType, resolveDiskThickness, resolvePenetration]);

    useLayoutEffect(() => {
        for (let i = 0; i < bucket.cones.length; i += 1) {
            const cone = bucket.cones[i];
            writeConeMatrices(i, cone, false);
        }

        for (const mesh of [diskRef.current, bodyRef.current, tipSphereRef.current, overlayDiskRef.current, overlayBodyRef.current, overlayTipSphereRef.current]) {
            if (!mesh) continue;
            mesh.count = bucket.cones.length;
            mesh.instanceMatrix.needsUpdate = true;
        }
        // The batch was just rewritten with every instance visible, so the hide
        // pass's memo of what it has already applied is stale. Without this it
        // skips the excluded instances and they render at their committed
        // position, which is the ghost of a dragged model's supports.
        hiddenStateRef.current.clear();
    }, [bucket, hasOverlay, writeConeMatrices]);

    // Hiding an instance writes one matrix, not the whole bucket: this is what an
    // activation change pays, and it must not re-derive every other instance.
    useLayoutEffect(() => {
        if (!isHidden) return;

        const hiddenState = hiddenStateRef.current;
        let touched = false;
        for (let i = 0; i < bucket.cones.length; i += 1) {
            const cone = bucket.cones[i];
            const hidden = isHidden(cone);
            if ((hiddenState.get(cone) ?? false) === hidden) continue;
            hiddenState.set(cone, hidden);
            touched = true;
            writeConeMatrices(i, cone, hidden);
        }

        if (!touched) return;
        for (const mesh of [diskRef.current, bodyRef.current, tipSphereRef.current, overlayDiskRef.current, overlayBodyRef.current, overlayTipSphereRef.current]) {
            if (mesh) mesh.instanceMatrix.needsUpdate = true;
        }
    }, [bucket, hasOverlay, isHidden, writeConeMatrices]);

    // Colours are a separate pass: a selection changes them and nothing else, and
    // it must not re-derive every instance matrix to do it.
    useLayoutEffect(() => {
        if (!instanceColor) return;
        for (const mesh of [diskRef.current, bodyRef.current, tipSphereRef.current]) {
            if (!mesh) continue;
            writeInstanceColors(mesh, bucket.cones, instanceColor);
        }
    }, [bucket, instanceColor]);

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
                    raycast={raycast ?? INSTANCED_MESH_RAYCAST}
                >
                    <cylinderGeometry args={[1, 1, 1, 10]} />
                    <meshStandardMaterial
                        color={instanceColor ? '#ffffff' : (discColor ?? color)}
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
                    raycast={raycast ?? INSTANCED_MESH_RAYCAST}
                >
                    <cylinderGeometry args={[1, bucket.shapeRatio, 1, 10]} />
                    <meshStandardMaterial
                        color={instanceColor ? '#ffffff' : color}
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
                    raycast={raycast ?? INSTANCED_MESH_RAYCAST}
                >
                    <sphereGeometry args={[1, 8, 6]} />
                    <meshStandardMaterial
                        color={instanceColor ? '#ffffff' : (discColor ?? color)}
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
                            <cylinderGeometry args={[1, bucket.shapeRatio, 1, 10]} />
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
                            <sphereGeometry args={[1, 8, 6]} />
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
                            <cylinderGeometry args={[1, 1, 1, 10]} />
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
    instanceColor,
    isHidden,
    grabRadiusAt,
    pointerSceneryModelIds,
    raycast,
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
            const key = coneBucketKey(cone);

            const existing = grouped.get(key);
            if (existing) {
                existing.cones.push(cone);
                continue;
            }

            grouped.set(key, {
                key,
                cones: [cone],
                profileType,
                shapeRatio: coneShapeRatio(cone),
            });
        }

        return Array.from(grouped.values());
    }, [validCones]);

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
                    instanceColor={instanceColor}
                    isHidden={isHidden}
                    grabRadiusAt={grabRadiusAt}
                    pointerSceneryModelIds={pointerSceneryModelIds}
                    raycast={raycast}
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

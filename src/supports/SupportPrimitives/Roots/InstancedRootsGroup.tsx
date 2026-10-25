import React, { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec3 } from '../../types';
import { quantizeToScale } from '@/utils/math';
import { HIDDEN_INSTANCE_MATRIX } from '../hiddenInstanceMatrix';
import { INSTANCED_MESH_RAYCAST } from '../instancedRaycast';
import { writeInstanceColors } from '../instanceColorWriter';

/**
 * How far the rendered root sits above the plate, in millimetres.
 *
 * A root's disk bottom lands exactly on the plate, and the plate top, the raft's
 * bottom and every root disk are then coplanar: three surfaces at the same depth
 * fight, and a raft of roots shows it as a mottled patch through the raft. A
 * hundredth of a millimetre is invisible at any zoom the app offers and takes the
 * disk off the plane. It is a rendering offset only - the sliced and exported
 * geometry is generated from the support state, not from this batch.
 */
export const ROOT_RENDER_LIFT_MM = 0.01;

export interface InstancedRoot {
    id: string;
    supportId?: string;
    modelId?: string;
    basePos: Vec3;
    bottomRadius: number;
    topRadius: number;
    effectiveDiskHeight: number;
    coneHeight: number;
}

interface InstancedRootsGroupProps {
    roots: InstancedRoot[];
    /** Keep the plate disk visible: the navigation view's reference for where a
     *  support meets the plate. The rest of the root stays mounted at zero
     *  alpha so the pointer still hits it. */
    diskOnly?: boolean;
    /** Colour for that disk, so it matches the contact discs. */
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
    instanceColor?: (root: InstancedRoot) => THREE.Color;
    /**
     * Instances to hide, by the primitive they draw. The world layer keeps an
     * excluded model in its arrays and hides it here, so an activation change
     * costs the changed instances rather than a full re-layout.
     */
    isHidden?: (root: InstancedRoot) => boolean;
    /**
     * Raycast override, for a caller whose batch is too large for three's
     * per-instance walk. The hover grid answers it in O(cells crossed).
     */
    raycast?: THREE.Object3D['raycast'];
    onRootClick?: (root: InstancedRoot, event: ThreeEvent<MouseEvent>) => void;
    onRootPointerDown?: (root: InstancedRoot, event: ThreeEvent<PointerEvent>) => void;
    onRootPointerMove?: (root: InstancedRoot, event: ThreeEvent<PointerEvent>) => void;
    onRootPointerOut?: (root: InstancedRoot | null, event: ThreeEvent<PointerEvent>) => void;
}

interface RootBucket {
    key: string;
    roots: InstancedRoot[];
    /** Top-to-bottom radius of the base cone: the one dimension a matrix cannot carry. */
    shapeRatio: number;
    /** Whether the bucket has any base cone at all; a root without one hides its instance. */
    hasCone: boolean;
}

const ROOT_ROTATION = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
const IDENTITY_ROTATION = new THREE.Quaternion();

/** Layout scratch: layouts are synchronous, so the batch kinds can share it. */
const scratchObject = new THREE.Object3D();

/**
 * Quantization of the base cone's top-to-bottom radius, in ratio units.
 *
 * The ratio is the only root dimension a unit geometry plus an instance matrix
 * cannot express: a cylinder scaled by (r, h, r) covers the disk, a uniform
 * sphere covers the top ball, but a frustum's two radii differ. It used to be
 * part of a four-parameter key at 0.001 precision — and the root *diameter*
 * varies continuously with the support profile, so the 20-model scene produced
 * **254 buckets** and 762 mount calls for roots alone.
 *
 * 0.05 parts of the ratio is a top-radius error of at most 2.5% of the bottom
 * radius, well under a print pixel, and it collapses a plate's roots to a
 * handful of meshes.
 */
export const ROOT_SHAPE_RATIO_STEP = 0.05;
export const ROOT_SHAPE_RATIO_BUCKETS_PER_UNIT = 1 / ROOT_SHAPE_RATIO_STEP;

export function rootShapeRatio(root: InstancedRoot): number {
    return Math.max(0.001, root.topRadius) / Math.max(0.001, root.bottomRadius);
}

/** The key one root's meshes are grouped under: its base cone's shape alone. */
export function rootBucketKey(root: InstancedRoot): string {
    return String(quantizeToScale(rootShapeRatio(root), ROOT_SHAPE_RATIO_BUCKETS_PER_UNIT));
}

/**
 * The instance scale for each root primitive.
 *
 * The geometries are unit-sized (a 1×1×1 cylinder, a 1-radius sphere), so the
 * instance matrix carries every millimetre dimension and two roots that differ
 * only in size share a mesh. The disk and cone are rotated onto Z by the caller;
 * their scale is in the geometry's own Y-up frame, where `y` is the height.
 */
export function rootInstanceScales(root: InstancedRoot): {
    disk: [number, number, number];
    cone: [number, number, number];
    sphere: [number, number, number];
} {
    const bottomRadius = Math.max(0.001, root.bottomRadius);
    const topRadius = Math.max(0.001, root.topRadius);
    return {
        disk: [bottomRadius, Math.max(0.001, root.effectiveDiskHeight), bottomRadius],
        cone: [bottomRadius, Math.max(0.001, root.coneHeight), bottomRadius],
        sphere: [topRadius, topRadius, topRadius],
    };
}

function RootBucketMesh({
    bucket,
    diskOnly = false,
    discColor,
    color,
    emissive,
    emissiveIntensity,
    transparent,
    opacity,
    clippingPlanes,
    outOfBoundsMaterial,
    instanceColor,
    isHidden,
    raycast,
    onRootClick,
    onRootPointerDown,
    onRootPointerMove,
    onRootPointerOut,
}: {
    bucket: RootBucket;
    diskOnly?: boolean;
    discColor?: string;
    color: string;
    emissive: string;
    emissiveIntensity: number;
    transparent: boolean;
    opacity: number;
    clippingPlanes: THREE.Plane[] | null;
    outOfBoundsMaterial?: THREE.ShaderMaterial | null;
    instanceColor?: (root: InstancedRoot) => THREE.Color;
    isHidden?: (root: InstancedRoot) => boolean;
    raycast?: THREE.Object3D['raycast'];
    onRootClick?: (root: InstancedRoot, event: ThreeEvent<MouseEvent>) => void;
    onRootPointerDown?: (root: InstancedRoot, event: ThreeEvent<PointerEvent>) => void;
    onRootPointerMove?: (root: InstancedRoot, event: ThreeEvent<PointerEvent>) => void;
    onRootPointerOut?: (root: InstancedRoot | null, event: ThreeEvent<PointerEvent>) => void;
}) {
    const diskRef = useRef<THREE.InstancedMesh>(null);
    const coneRef = useRef<THREE.InstancedMesh>(null);
    const sphereRef = useRef<THREE.InstancedMesh>(null);
    const overlayDiskRef = useRef<THREE.InstancedMesh>(null);
    const overlayConeRef = useRef<THREE.InstancedMesh>(null);
    const overlaySphereRef = useRef<THREE.InstancedMesh>(null);
    const lastHoveredRootRef = useRef<InstancedRoot | null>(null);

    const hasOverlay = !!outOfBoundsMaterial;

    const hiddenStateRef = React.useRef<Map<InstancedRoot, boolean>>(new Map());

    const writeBucketMatrices = React.useCallback((
        index: number,
        root: InstancedRoot,
        hidden: boolean,
    ) => {
        const meshes = [
            diskRef.current, coneRef.current, sphereRef.current,
            overlayDiskRef.current, overlayConeRef.current, overlaySphereRef.current,
        ];
        if (hidden) {
            for (const mesh of meshes) {
                if (mesh) mesh.setMatrixAt(index, HIDDEN_INSTANCE_MATRIX);
            }
            return;
        }

        // The whole stack rides the lift together, so its own faces keep their
        // spacing; only the disk's bottom leaves the plate.
        const lift = ROOT_RENDER_LIFT_MM;
        const scales = rootInstanceScales(root);
        // A root with no cone has no top ball either; its instances stay
        // collapsed rather than drawing at the origin.
        const hasCone = root.coneHeight > 0;
        const entries: Array<{
            mesh: THREE.InstancedMesh | null;
            quaternion: THREE.Quaternion;
            scale: [number, number, number];
            zOffset: number;
        }> = [
            { mesh: diskRef.current, quaternion: ROOT_ROTATION, scale: scales.disk, zOffset: lift + root.effectiveDiskHeight / 2 },
            { mesh: coneRef.current, quaternion: ROOT_ROTATION, scale: scales.cone, zOffset: lift + root.effectiveDiskHeight + (root.coneHeight / 2) },
            { mesh: sphereRef.current, quaternion: IDENTITY_ROTATION, scale: scales.sphere, zOffset: lift + root.effectiveDiskHeight + root.coneHeight },
            { mesh: overlayDiskRef.current, quaternion: ROOT_ROTATION, scale: scales.disk, zOffset: lift + root.effectiveDiskHeight / 2 },
            { mesh: overlayConeRef.current, quaternion: ROOT_ROTATION, scale: scales.cone, zOffset: lift + root.effectiveDiskHeight + (root.coneHeight / 2) },
            { mesh: overlaySphereRef.current, quaternion: IDENTITY_ROTATION, scale: scales.sphere, zOffset: lift + root.effectiveDiskHeight + root.coneHeight },
        ];

        for (let i = 0; i < entries.length; i += 1) {
            const entry = entries[i];
            if (!entry.mesh) continue;
            if (!hasCone && i !== 0 && i !== 3) {
                entry.mesh.setMatrixAt(index, HIDDEN_INSTANCE_MATRIX);
                continue;
            }
            scratchObject.position.set(root.basePos.x, root.basePos.y, root.basePos.z + entry.zOffset);
            scratchObject.quaternion.copy(entry.quaternion);
            scratchObject.scale.set(entry.scale[0], entry.scale[1], entry.scale[2]);
            scratchObject.updateMatrix();
            entry.mesh.setMatrixAt(index, scratchObject.matrix);
        }
    }, []);

    useLayoutEffect(() => {
        for (let i = 0; i < bucket.roots.length; i += 1) {
            const root = bucket.roots[i];
            writeBucketMatrices(i, root, false);
        }

        for (const mesh of [
            diskRef.current, coneRef.current, sphereRef.current,
            overlayDiskRef.current, overlayConeRef.current, overlaySphereRef.current,
        ]) {
            if (!mesh) continue;
            mesh.count = bucket.roots.length;
            mesh.instanceMatrix.needsUpdate = true;
        }
        // The batch was just rewritten with every instance visible, so the hide
        // pass's memo of what it has already applied is stale. Without this it
        // skips the excluded instances and they render at their committed
        // position, which is the ghost of a dragged model's supports.
        hiddenStateRef.current.clear();
    }, [bucket, hasOverlay, writeBucketMatrices]);

    // Hiding an instance writes one matrix, not the whole bucket: this is what an
    // activation change pays, and it must not re-derive every other instance.
    useLayoutEffect(() => {
        if (!isHidden) return;

        const hiddenState = hiddenStateRef.current;
        let touched = false;
        for (let i = 0; i < bucket.roots.length; i += 1) {
            const root = bucket.roots[i];
            const hidden = isHidden(root);
            if ((hiddenState.get(root) ?? false) === hidden) continue;
            hiddenState.set(root, hidden);
            touched = true;
            writeBucketMatrices(i, root, hidden);
        }

        if (!touched) return;
        for (const mesh of [
            diskRef.current, coneRef.current, sphereRef.current,
            overlayDiskRef.current, overlayConeRef.current, overlaySphereRef.current,
        ]) {
            if (mesh) mesh.instanceMatrix.needsUpdate = true;
        }
    }, [bucket, hasOverlay, isHidden, writeBucketMatrices]);

    // Colours are a separate pass: a selection changes them and nothing else, and
    // it must not re-derive every instance matrix to do it.
    useLayoutEffect(() => {
        if (!instanceColor) return;
        for (const mesh of [diskRef.current, coneRef.current, sphereRef.current]) {
            if (!mesh) continue;
            writeInstanceColors(mesh, bucket.roots, instanceColor);
        }
    }, [bucket, instanceColor]);

    const resolveRootFromEvent = (instanceId: number | undefined | null) => {
        if (instanceId == null) return null;
        return bucket.roots[instanceId] ?? null;
    };

    const handleClick = (event: ThreeEvent<MouseEvent>) => {
        if (!onRootClick) return;
        event.stopPropagation();
        const root = resolveRootFromEvent(event.instanceId);
        if (!root) return;
        onRootClick(root, event);
    };

    const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
        if (!onRootPointerDown) return;
        event.stopPropagation();
        const root = resolveRootFromEvent(event.instanceId);
        if (!root) return;
        onRootPointerDown(root, event);
    };

    const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
        if (!onRootPointerMove) return;
        event.stopPropagation();
        const root = resolveRootFromEvent(event.instanceId);
        if (!root) return;
        lastHoveredRootRef.current = root;
        onRootPointerMove(root, event);
    };

    const handlePointerOut = (event: ThreeEvent<PointerEvent>) => {
        if (!onRootPointerOut) return;
        event.stopPropagation();
        onRootPointerOut(lastHoveredRootRef.current, event);
        lastHoveredRootRef.current = null;
    };

    return (
        <group>
            <instancedMesh
                // Same remount-for-fresh-interaction-registration as the shaft,
                // cone and joint batches.
                key={`root-disk:${bucket.roots.length}`}
                ref={diskRef}
                args={[undefined, undefined, bucket.roots.length]}
                frustumCulled={false}
                renderOrder={100000}
                raycast={raycast ?? INSTANCED_MESH_RAYCAST}
                onClick={onRootClick ? handleClick : undefined}
                onPointerDown={onRootPointerDown ? handlePointerDown : undefined}
                onPointerMove={onRootPointerMove ? handlePointerMove : undefined}
                onPointerOut={onRootPointerOut ? handlePointerOut : undefined}
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
                />
            </instancedMesh>

            {!diskOnly && bucket.hasCone && (
                <instancedMesh
                    key={`root-cone:${bucket.roots.length}`}
                    ref={coneRef}
                    args={[undefined, undefined, bucket.roots.length]}
                    frustumCulled={false}
                    renderOrder={100000}
                    raycast={() => null}
                >
                    <cylinderGeometry args={[bucket.shapeRatio, 1, 1, 10]} />
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

            {!diskOnly && bucket.hasCone && (
                <instancedMesh
                    key={`root-sphere:${bucket.roots.length}`}
                    ref={sphereRef}
                    args={[undefined, undefined, bucket.roots.length]}
                    frustumCulled={false}
                    renderOrder={100000}
                    raycast={() => null}
                >
                    <sphereGeometry args={[1, 8, 6]} />
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

            {outOfBoundsMaterial && (
                <>
                    <instancedMesh
                        ref={overlayDiskRef}
                        args={[undefined, undefined, bucket.roots.length]}
                        frustumCulled={false}
                        raycast={() => null}
                        renderOrder={100000}
                        material={outOfBoundsMaterial}
                    >
                        <cylinderGeometry args={[1, 1, 1, 10]} />
                    </instancedMesh>
                    {!diskOnly && bucket.hasCone && (
                        <instancedMesh
                            ref={overlayConeRef}
                            args={[undefined, undefined, bucket.roots.length]}
                            frustumCulled={false}
                            raycast={() => null}
                            renderOrder={100000}
                            material={outOfBoundsMaterial}
                        >
                            <cylinderGeometry args={[bucket.shapeRatio, 1, 1, 10]} />
                        </instancedMesh>
                    )}
                    {!diskOnly && bucket.hasCone && (
                        <instancedMesh
                            ref={overlaySphereRef}
                            args={[undefined, undefined, bucket.roots.length]}
                            frustumCulled={false}
                            raycast={() => null}
                            renderOrder={100000}
                            material={outOfBoundsMaterial}
                        >
                            <sphereGeometry args={[1, 8, 6]} />
                        </instancedMesh>
                    )}
                </>
            )}
        </group>
    );
}

export function InstancedRootsGroup({
    roots,
    diskOnly = false,
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
    onRootClick,
    onRootPointerDown,
    onRootPointerMove,
    onRootPointerOut,
}: InstancedRootsGroupProps) {
    const validRoots = useMemo(() => {
        return roots.filter((root) => root.bottomRadius > 0 && root.effectiveDiskHeight > 0);
    }, [roots]);

    const buckets = useMemo(() => {
        const grouped = new Map<string, RootBucket>();

        for (const root of validRoots) {
            const key = rootBucketKey(root);
            const existing = grouped.get(key);
            if (existing) {
                existing.roots.push(root);
                if (root.coneHeight > 0) existing.hasCone = true;
                continue;
            }

            grouped.set(key, {
                key,
                roots: [root],
                shapeRatio: quantizeToScale(rootShapeRatio(root), ROOT_SHAPE_RATIO_BUCKETS_PER_UNIT),
                hasCone: root.coneHeight > 0,
            });
        }

        return Array.from(grouped.values());
    }, [validRoots]);

    if (validRoots.length === 0) return null;

    return (
        <group>
            {buckets.map((bucket) => (
                <RootBucketMesh
                    key={bucket.key}
                    bucket={bucket}
                    diskOnly={diskOnly}
                    discColor={discColor}
                    color={color}
                    emissive={emissive}
                    emissiveIntensity={emissiveIntensity}
                    transparent={transparent}
                    opacity={opacity}
                    clippingPlanes={clippingPlanes}
                    outOfBoundsMaterial={outOfBoundsMaterial}
                    instanceColor={instanceColor}
                    isHidden={isHidden}
                    onRootClick={onRootClick}
                    onRootPointerDown={onRootPointerDown}
                    onRootPointerMove={onRootPointerMove}
                    onRootPointerOut={onRootPointerOut}
                />
            ))}
        </group>
    );
}

import React, { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec3 } from '../../types';

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
    color?: string;
    emissive?: string;
    emissiveIntensity?: number;
    transparent?: boolean;
    opacity?: number;
    clippingPlanes?: THREE.Plane[] | null;
    outOfBoundsMaterial?: THREE.ShaderMaterial | null;
    onRootClick?: (root: InstancedRoot, event: ThreeEvent<MouseEvent>) => void;
    onRootPointerMove?: (root: InstancedRoot, event: ThreeEvent<PointerEvent>) => void;
    onRootPointerOut?: (root: InstancedRoot | null, event: ThreeEvent<PointerEvent>) => void;
}

interface RootBucket {
    key: string;
    roots: InstancedRoot[];
    diskRadius: number;
    diskHeight: number;
    coneTopRadius: number;
    coneBottomRadius: number;
    coneHeight: number;
    sphereRadius: number;
}

const ROOT_ROTATION = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

const quantize = (value: number) => Math.round(value * 1000) / 1000;

const toBucketKey = (root: InstancedRoot) => {
    return [
        quantize(root.bottomRadius),
        quantize(root.effectiveDiskHeight),
        quantize(root.topRadius),
        quantize(root.coneHeight),
    ].join(':');
};

function RootBucketMesh({
    bucket,
    color,
    emissive,
    emissiveIntensity,
    transparent,
    opacity,
    clippingPlanes,
    outOfBoundsMaterial,
    onRootClick,
    onRootPointerMove,
    onRootPointerOut,
}: {
    bucket: RootBucket;
    color: string;
    emissive: string;
    emissiveIntensity: number;
    transparent: boolean;
    opacity: number;
    clippingPlanes: THREE.Plane[] | null;
    outOfBoundsMaterial?: THREE.ShaderMaterial | null;
    onRootClick?: (root: InstancedRoot, event: ThreeEvent<MouseEvent>) => void;
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

    useLayoutEffect(() => {
        const tempObject = new THREE.Object3D();

        const updateMesh = (
            mesh: THREE.InstancedMesh | null,
            centerCalculator: (root: InstancedRoot) => Vec3,
            quaternion: THREE.Quaternion,
        ) => {
            if (!mesh) return;
            for (let i = 0; i < bucket.roots.length; i += 1) {
                const root = bucket.roots[i];
                const center = centerCalculator(root);
                tempObject.position.set(center.x, center.y, center.z);
                tempObject.quaternion.copy(quaternion);
                tempObject.scale.set(1, 1, 1);
                tempObject.updateMatrix();
                mesh.setMatrixAt(i, tempObject.matrix);
            }
            mesh.count = bucket.roots.length;
            mesh.instanceMatrix.needsUpdate = true;
        };

        const diskCenter = (root: InstancedRoot) => ({
            x: root.basePos.x,
            y: root.basePos.y,
            z: root.basePos.z + (root.effectiveDiskHeight / 2),
        });
        const coneCenter = (root: InstancedRoot) => ({
            x: root.basePos.x,
            y: root.basePos.y,
            z: root.basePos.z + root.effectiveDiskHeight + (root.coneHeight / 2),
        });
        const sphereCenter = (root: InstancedRoot) => ({
            x: root.basePos.x,
            y: root.basePos.y,
            z: root.basePos.z + root.effectiveDiskHeight + root.coneHeight,
        });

        updateMesh(diskRef.current, diskCenter, ROOT_ROTATION);
        updateMesh(coneRef.current, coneCenter, ROOT_ROTATION);
        updateMesh(sphereRef.current, sphereCenter, new THREE.Quaternion());
        updateMesh(overlayDiskRef.current, diskCenter, ROOT_ROTATION);
        updateMesh(overlayConeRef.current, coneCenter, ROOT_ROTATION);
        updateMesh(overlaySphereRef.current, sphereCenter, new THREE.Quaternion());
    }, [bucket, hasOverlay]);

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
                ref={diskRef}
                args={[undefined, undefined, bucket.roots.length]}
                frustumCulled={false}
                onClick={onRootClick ? handleClick : undefined}
                onPointerMove={onRootPointerMove ? handlePointerMove : undefined}
                onPointerOut={onRootPointerOut ? handlePointerOut : undefined}
            >
                <cylinderGeometry args={[bucket.diskRadius, bucket.diskRadius, bucket.diskHeight, 10]} />
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

            {bucket.coneHeight > 0 && (
                <instancedMesh
                    ref={coneRef}
                    args={[undefined, undefined, bucket.roots.length]}
                    frustumCulled={false}
                    onClick={onRootClick ? handleClick : undefined}
                    onPointerMove={onRootPointerMove ? handlePointerMove : undefined}
                    onPointerOut={onRootPointerOut ? handlePointerOut : undefined}
                >
                    <cylinderGeometry args={[bucket.coneTopRadius, bucket.coneBottomRadius, bucket.coneHeight, 10]} />
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

            {bucket.coneHeight > 0 && (
                <instancedMesh
                    ref={sphereRef}
                    args={[undefined, undefined, bucket.roots.length]}
                    frustumCulled={false}
                    onClick={onRootClick ? handleClick : undefined}
                    onPointerMove={onRootPointerMove ? handlePointerMove : undefined}
                    onPointerOut={onRootPointerOut ? handlePointerOut : undefined}
                >
                    <sphereGeometry args={[bucket.sphereRadius, 10, 8]} />
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

            {outOfBoundsMaterial && (
                <>
                    <instancedMesh
                        ref={overlayDiskRef}
                        args={[undefined, undefined, bucket.roots.length]}
                        frustumCulled={false}
                        raycast={() => null}
                        renderOrder={3}
                        material={outOfBoundsMaterial}
                    >
                        <cylinderGeometry args={[bucket.diskRadius, bucket.diskRadius, bucket.diskHeight, 10]} />
                    </instancedMesh>
                    {bucket.coneHeight > 0 && (
                        <instancedMesh
                            ref={overlayConeRef}
                            args={[undefined, undefined, bucket.roots.length]}
                            frustumCulled={false}
                            raycast={() => null}
                            renderOrder={3}
                            material={outOfBoundsMaterial}
                        >
                            <cylinderGeometry args={[bucket.coneTopRadius, bucket.coneBottomRadius, bucket.coneHeight, 10]} />
                        </instancedMesh>
                    )}
                    {bucket.coneHeight > 0 && (
                        <instancedMesh
                            ref={overlaySphereRef}
                            args={[undefined, undefined, bucket.roots.length]}
                            frustumCulled={false}
                            raycast={() => null}
                            renderOrder={3}
                            material={outOfBoundsMaterial}
                        >
                            <sphereGeometry args={[bucket.sphereRadius, 10, 8]} />
                        </instancedMesh>
                    )}
                </>
            )}
        </group>
    );
}

export function InstancedRootsGroup({
    roots,
    color = '#ff8800',
    emissive = '#000000',
    emissiveIntensity = 0,
    transparent = false,
    opacity = 1,
    clippingPlanes = null,
    outOfBoundsMaterial = null,
    onRootClick,
    onRootPointerMove,
    onRootPointerOut,
}: InstancedRootsGroupProps) {
    const validRoots = useMemo(() => {
        return roots.filter((root) => root.bottomRadius > 0 && root.effectiveDiskHeight > 0);
    }, [roots]);

    const buckets = useMemo(() => {
        const grouped = new Map<string, RootBucket>();

        for (const root of validRoots) {
            const key = toBucketKey(root);
            const existing = grouped.get(key);
            if (existing) {
                existing.roots.push(root);
                continue;
            }

            grouped.set(key, {
                key,
                roots: [root],
                diskRadius: root.bottomRadius,
                diskHeight: root.effectiveDiskHeight,
                coneTopRadius: root.topRadius,
                coneBottomRadius: root.bottomRadius,
                coneHeight: root.coneHeight,
                sphereRadius: root.topRadius,
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
                    color={color}
                    emissive={emissive}
                    emissiveIntensity={emissiveIntensity}
                    transparent={transparent}
                    opacity={opacity}
                    clippingPlanes={clippingPlanes}
                    outOfBoundsMaterial={outOfBoundsMaterial}
                    onRootClick={onRootClick}
                    onRootPointerMove={onRootPointerMove}
                    onRootPointerOut={onRootPointerOut}
                />
            ))}
        </group>
    );
}

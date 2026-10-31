import React, { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec3 } from '../../types';
import { HIDDEN_INSTANCE_MATRIX } from '../hiddenInstanceMatrix';
import { INSTANCED_MESH_RAYCAST } from '../instancedRaycast';
import { writeInstanceColors } from '../instanceColorWriter';
import { buildProxyHoverIndex, createProxyHoverRaycast } from '../../proxyHoverIndex';

/** One scratch object per batch kind: layouts are synchronous, so they share it. */
const scratchObject = new THREE.Object3D();

export interface InstancedJoint {
    id: string;
    pos: Vec3;
    diameter: number;
    supportId?: string;
    modelId?: string;
}

interface InstancedJointGroupProps {
    joints: InstancedJoint[];
    color?: string;
    emissive?: string;
    emissiveIntensity?: number;
    transparent?: boolean;
    opacity?: number;
    clippingPlanes?: THREE.Plane[] | null;
    widthSegments?: number;
    heightSegments?: number;
    outOfBoundsMaterial?: THREE.ShaderMaterial | null;
    /**
     * Per-instance colour, for a caller that tints a subset of the batch (the
     * selection). Every instance must be given one: the colour buffer starts
     * black, and the group's own `color` is not used once this is set.
     */
    instanceColor?: (joint: InstancedJoint) => THREE.Color;
    /**
     * Instances to hide, by the primitive they draw. The world layer keeps an
     * excluded model in its arrays and hides it here, so an activation change
     * costs the changed instances rather than a full re-layout.
     */
    isHidden?: (joint: InstancedJoint) => boolean;
    /**
     * Raycast override, for a caller whose batch is too large for three's
     * per-instance walk. The hover grid answers it in O(cells crossed).
     */
    raycast?: THREE.Object3D['raycast'];
    /**
     * Grab radius at a depth, in millimetres. Supplying it builds a hover index
     * for the batch: three's per-instance walk raycasts all 16k joints on this
     * plate on every pointer move, while the index tests only the cells the ray
     * crosses.
     */
    grabRadiusAt?: (distance: number) => number;
    onJointClick?: (joint: InstancedJoint, event: ThreeEvent<MouseEvent>) => void;
    onJointPointerDown?: (joint: InstancedJoint, event: ThreeEvent<PointerEvent>) => void;
    onJointPointerMove?: (joint: InstancedJoint, event: ThreeEvent<PointerEvent>) => void;
    onJointPointerOut?: (joint: InstancedJoint | null, event: ThreeEvent<PointerEvent>) => void;
}

export function InstancedJointGroup({
    joints,
    color = '#ff8800',
    emissive = '#000000',
    emissiveIntensity = 0,
    transparent = false,
    opacity = 1,
    clippingPlanes = null,
    widthSegments = 12,
    heightSegments = 10,
    outOfBoundsMaterial = null,
    instanceColor,
    isHidden,
    raycast,
    grabRadiusAt,
    onJointClick,
    onJointPointerDown,
    onJointPointerMove,
    onJointPointerOut,
}: InstancedJointGroupProps) {
    const meshRef = useRef<THREE.InstancedMesh>(null);
    const overlayMeshRef = useRef<THREE.InstancedMesh>(null);
    const lastHoveredJointRef = useRef<InstancedJoint | null>(null);

    const validJoints = useMemo(() => {
        return joints.filter((joint) => Number.isFinite(joint.diameter) && joint.diameter > 0.001);
    }, [joints]);

    const hoverRaycast = useMemo(() => {
        if (!grabRadiusAt || validJoints.length === 0) return undefined;
        const targets = validJoints.map((joint, index) => {
            const radius = Math.max(0.001, joint.diameter * 0.5);
            return {
                modelId: joint.modelId,
                index,
                // A joint is a ball; a short vertical segment approximates it
                // without a degenerate segment (three's ray-segment maths divides
                // by its length).
                start: { x: joint.pos.x, y: joint.pos.y, z: joint.pos.z - radius },
                end: { x: joint.pos.x, y: joint.pos.y, z: joint.pos.z + radius },
                radius,
            };
        });
        const index = buildProxyHoverIndex(targets);
        return index ? createProxyHoverRaycast(index, grabRadiusAt) : undefined;
    }, [grabRadiusAt, validJoints]);

    const hasOverlay = !!outOfBoundsMaterial;

    const hiddenStateRef = React.useRef<Map<InstancedJoint, boolean>>(new Map());

    const writeInstanceMatrix = React.useCallback((
        mesh: THREE.InstancedMesh,
        index: number,
        joint: InstancedJoint,
        hidden: boolean,
    ) => {
        if (hidden) {
            mesh.setMatrixAt(index, HIDDEN_INSTANCE_MATRIX);
            return;
        }
        const radius = Math.max(0.001, joint.diameter * 0.5);
        scratchObject.position.set(joint.pos.x, joint.pos.y, joint.pos.z);
        scratchObject.quaternion.identity();
        scratchObject.scale.set(radius, radius, radius);
        scratchObject.updateMatrix();
        mesh.setMatrixAt(index, scratchObject.matrix);
    }, []);

    useLayoutEffect(() => {
        const mesh = meshRef.current;
        const overlayMesh = overlayMeshRef.current;
        if (!mesh) return;

        for (let i = 0; i < validJoints.length; i += 1) {
            const joint = validJoints[i];
            writeInstanceMatrix(mesh, i, joint, false);
            if (overlayMesh) writeInstanceMatrix(overlayMesh, i, joint, false);
        }

        mesh.count = validJoints.length;
        mesh.instanceMatrix.needsUpdate = true;
        if (overlayMesh) {
            overlayMesh.count = validJoints.length;
            overlayMesh.instanceMatrix.needsUpdate = true;
        }
        // The batch was just rewritten with every instance visible, so the hide
        // pass's memo of what it has already applied is stale. Without this it
        // skips the excluded instances and they render at their committed
        // position, which is the ghost of a dragged model's supports.
        hiddenStateRef.current.clear();
    }, [validJoints, hasOverlay, writeInstanceMatrix]);

    // Hiding an instance writes one matrix, not the whole batch: this is what an
    // activation change pays, and it must not re-derive every other instance.
    useLayoutEffect(() => {
        const mesh = meshRef.current;
        const overlayMesh = overlayMeshRef.current;
        if (!mesh || !isHidden) return;

        const hiddenState = hiddenStateRef.current;
        let touched = false;
        for (let i = 0; i < validJoints.length; i += 1) {
            const joint = validJoints[i];
            const hidden = isHidden(joint);
            if ((hiddenState.get(joint) ?? false) === hidden) continue;
            hiddenState.set(joint, hidden);
            touched = true;
            writeInstanceMatrix(mesh, i, joint, hidden);
            if (overlayMesh) writeInstanceMatrix(overlayMesh, i, joint, hidden);
        }

        if (!touched) return;
        mesh.instanceMatrix.needsUpdate = true;
        if (overlayMesh) overlayMesh.instanceMatrix.needsUpdate = true;
    }, [validJoints, hasOverlay, isHidden, writeInstanceMatrix]);

    // Colours are a separate pass: a selection changes them and nothing else, and
    // it must not re-derive every instance matrix to do it.
    useLayoutEffect(() => {
        const mesh = meshRef.current;
        if (!mesh || !instanceColor) return;
        writeInstanceColors(mesh, validJoints, instanceColor);
    }, [validJoints, instanceColor]);

    if (validJoints.length === 0) return null;

    const resolveJoint = (instanceId: number | undefined | null) => {
        if (instanceId == null) return null;
        return validJoints[instanceId] ?? null;
    };

    const handleClick = (event: ThreeEvent<MouseEvent>) => {
        if (!onJointClick) return;
        event.stopPropagation();
        const joint = resolveJoint(event.instanceId);
        if (!joint) return;
        onJointClick(joint, event);
    };

    const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
        if (!onJointPointerDown) return;
        event.stopPropagation();
        const joint = resolveJoint(event.instanceId);
        if (!joint) return;
        onJointPointerDown(joint, event);
    };

    const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
        if (!onJointPointerMove) return;
        event.stopPropagation();
        const joint = resolveJoint(event.instanceId);
        if (!joint) return;
        lastHoveredJointRef.current = joint;
        onJointPointerMove(joint, event);
    };

    const handlePointerOut = (event: ThreeEvent<PointerEvent>) => {
        if (!onJointPointerOut) return;
        event.stopPropagation();
        onJointPointerOut(lastHoveredJointRef.current, event);
        lastHoveredJointRef.current = null;
    };

    return (
        <>
            <instancedMesh
                // Same remount-for-fresh-interaction-registration as the shaft
                // and cone batches: without the key, a grown batch keeps the
                // old raycast/matrix state until something re-registers it.
                key={`joint:${validJoints.length}`}
                ref={meshRef}
                args={[undefined, undefined, validJoints.length]}
                frustumCulled={false}
                renderOrder={100000}
                raycast={raycast ?? hoverRaycast ?? INSTANCED_MESH_RAYCAST}
                onClick={onJointClick ? handleClick : undefined}
                onPointerDown={onJointPointerDown ? handlePointerDown : undefined}
                onPointerMove={onJointPointerMove ? handlePointerMove : undefined}
                onPointerOut={onJointPointerOut ? handlePointerOut : undefined}
            >
                <sphereGeometry args={[1, widthSegments, heightSegments]} />
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
            {outOfBoundsMaterial && (
                <instancedMesh
                    ref={overlayMeshRef}
                    args={[undefined, undefined, validJoints.length]}
                    frustumCulled={false}
                    raycast={() => null}
                    renderOrder={100000}
                    material={outOfBoundsMaterial}
                >
                    <sphereGeometry args={[1, widthSegments, heightSegments]} />
                </instancedMesh>
            )}
        </>
    );
}

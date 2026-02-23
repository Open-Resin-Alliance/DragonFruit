import React, { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec3 } from '../../types';

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
    widthSegments?: number;
    heightSegments?: number;
    onJointClick?: (joint: InstancedJoint, event: ThreeEvent<MouseEvent>) => void;
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
    widthSegments = 12,
    heightSegments = 10,
    onJointClick,
    onJointPointerMove,
    onJointPointerOut,
}: InstancedJointGroupProps) {
    const meshRef = useRef<THREE.InstancedMesh>(null);
    const lastHoveredJointRef = useRef<InstancedJoint | null>(null);

    const validJoints = useMemo(() => {
        return joints.filter((joint) => Number.isFinite(joint.diameter) && joint.diameter > 0.001);
    }, [joints]);

    useLayoutEffect(() => {
        const mesh = meshRef.current;
        if (!mesh) return;

        const tempObject = new THREE.Object3D();

        for (let i = 0; i < validJoints.length; i += 1) {
            const joint = validJoints[i];
            const radius = Math.max(0.001, joint.diameter * 0.5);

            tempObject.position.set(joint.pos.x, joint.pos.y, joint.pos.z);
            tempObject.quaternion.identity();
            tempObject.scale.set(radius, radius, radius);
            tempObject.updateMatrix();
            mesh.setMatrixAt(i, tempObject.matrix);
        }

        mesh.count = validJoints.length;
        mesh.instanceMatrix.needsUpdate = true;
    }, [validJoints]);

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
        <instancedMesh
            ref={meshRef}
            args={[undefined, undefined, validJoints.length]}
            onClick={onJointClick ? handleClick : undefined}
            onPointerMove={onJointPointerMove ? handlePointerMove : undefined}
            onPointerOut={onJointPointerOut ? handlePointerOut : undefined}
        >
            <sphereGeometry args={[1, widthSegments, heightSegments]} />
            <meshStandardMaterial
                color={color}
                emissive={emissive}
                emissiveIntensity={emissiveIntensity}
                transparent={transparent}
                opacity={opacity}
                depthWrite={!transparent}
            />
        </instancedMesh>
    );
}

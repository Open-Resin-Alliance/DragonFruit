import React, { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Vec3 } from '../../types';

export interface InstancedJoint {
    id: string;
    pos: Vec3;
    diameter: number;
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
}: InstancedJointGroupProps) {
    const meshRef = useRef<THREE.InstancedMesh>(null);

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

    return (
        <instancedMesh
            ref={meshRef}
            args={[undefined, undefined, validJoints.length]}
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

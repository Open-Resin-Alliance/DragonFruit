import React, { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec3 } from '../../types';

export interface InstancedShaft {
    id: string;
    start: Vec3;
    end: Vec3;
    diameter: number;
    supportId?: string;
    modelId?: string;
}

interface InstancedShaftGroupProps {
    shafts: InstancedShaft[];
    color?: string;
    emissive?: string;
    emissiveIntensity?: number;
    transparent?: boolean;
    opacity?: number;
    radialSegments?: number;
    onShaftClick?: (shaft: InstancedShaft, event: ThreeEvent<MouseEvent>) => void;
    onShaftPointerMove?: (shaft: InstancedShaft, event: ThreeEvent<PointerEvent>) => void;
    onShaftPointerOut?: (shaft: InstancedShaft | null, event: ThreeEvent<PointerEvent>) => void;
}

const UP = new THREE.Vector3(0, 1, 0);

export function InstancedShaftGroup({
    shafts,
    color = '#ff8800',
    emissive = '#000000',
    emissiveIntensity = 0,
    transparent = false,
    opacity = 1,
    radialSegments = 12,
    onShaftClick,
    onShaftPointerMove,
    onShaftPointerOut,
}: InstancedShaftGroupProps) {
    const meshRef = useRef<THREE.InstancedMesh>(null);
    const lastHoveredShaftRef = useRef<InstancedShaft | null>(null);

    const validShafts = useMemo(() => {
        return shafts.filter((shaft) => {
            const dx = shaft.end.x - shaft.start.x;
            const dy = shaft.end.y - shaft.start.y;
            const dz = shaft.end.z - shaft.start.z;
            const lengthSq = dx * dx + dy * dy + dz * dz;
            return lengthSq >= 1e-6;
        });
    }, [shafts]);

    useLayoutEffect(() => {
        const mesh = meshRef.current;
        if (!mesh) return;

        const tempObject = new THREE.Object3D();
        const start = new THREE.Vector3();
        const end = new THREE.Vector3();
        const direction = new THREE.Vector3();
        const midpoint = new THREE.Vector3();

        for (let i = 0; i < validShafts.length; i += 1) {
            const shaft = validShafts[i];

            start.set(shaft.start.x, shaft.start.y, shaft.start.z);
            end.set(shaft.end.x, shaft.end.y, shaft.end.z);

            direction.subVectors(end, start);
            const length = direction.length();
            if (length < 0.001) continue;

            direction.divideScalar(length);
            midpoint.addVectors(start, end).multiplyScalar(0.5);

            tempObject.position.copy(midpoint);
            tempObject.quaternion.setFromUnitVectors(UP, direction);
            tempObject.scale.set(shaft.diameter, length, shaft.diameter);
            tempObject.updateMatrix();
            mesh.setMatrixAt(i, tempObject.matrix);
        }

        mesh.count = validShafts.length;
        mesh.instanceMatrix.needsUpdate = true;
    }, [validShafts]);

    if (validShafts.length === 0) return null;

    const handleClick = (event: ThreeEvent<MouseEvent>) => {
        if (!onShaftClick) return;
        event.stopPropagation();
        const instanceId = event.instanceId;
        if (instanceId == null) return;
        const shaft = validShafts[instanceId];
        if (!shaft) return;
        onShaftClick(shaft, event);
    };

    const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
        if (!onShaftPointerMove) return;
        event.stopPropagation();
        const instanceId = event.instanceId;
        if (instanceId == null) return;
        const shaft = validShafts[instanceId];
        if (!shaft) return;
        lastHoveredShaftRef.current = shaft;
        onShaftPointerMove(shaft, event);
    };

    const handlePointerOut = (event: ThreeEvent<PointerEvent>) => {
        if (!onShaftPointerOut) return;
        event.stopPropagation();
        onShaftPointerOut(lastHoveredShaftRef.current, event);
        lastHoveredShaftRef.current = null;
    };

    return (
        <instancedMesh
            ref={meshRef}
            args={[undefined, undefined, validShafts.length]}
            onClick={onShaftClick ? handleClick : undefined}
            onPointerMove={onShaftPointerMove ? handlePointerMove : undefined}
            onPointerOut={onShaftPointerOut ? handlePointerOut : undefined}
        >
            <cylinderGeometry args={[0.5, 0.5, 1, radialSegments]} />
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

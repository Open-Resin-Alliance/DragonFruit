import React, { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Vec3 } from '../../types';

export interface InstancedShaft {
    id: string;
    start: Vec3;
    end: Vec3;
    diameter: number;
}

interface InstancedShaftGroupProps {
    shafts: InstancedShaft[];
    color?: string;
    emissive?: string;
    emissiveIntensity?: number;
    transparent?: boolean;
    opacity?: number;
    radialSegments?: number;
}

const UP = new THREE.Vector3(0, 1, 0);

export function InstancedShaftGroup({
    shafts,
    color = '#ff8800',
    emissive = '#000000',
    emissiveIntensity = 0,
    transparent = false,
    opacity = 1,
    radialSegments = 20,
}: InstancedShaftGroupProps) {
    const meshRef = useRef<THREE.InstancedMesh>(null);

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

    return (
        <instancedMesh ref={meshRef} args={[undefined, undefined, validShafts.length]}>
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

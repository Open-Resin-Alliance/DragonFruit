import React, { useMemo } from 'react';
import * as THREE from 'three';
import { Vec3 } from '../../types';

interface Props {
    position: Vec3;
    diameter: number;
    normal?: Vec3;
}

export function JointPlacementPreview({ position, diameter, normal }: Props) {
    const radius = diameter / 2;
    const offset = radius * 2.25;

    // Calculate light positions based on normal (if provided)
    const lightPositions = useMemo(() => {
        if (!normal) {
            // Fallback to tetrahedral if no normal
            return [
                [offset, offset, offset],
                [-offset, -offset, offset],
                [-offset, offset, -offset],
                [offset, -offset, -offset]
            ] as const;
        }

        // Create a ring of lights perpendicular to the shaft normal
        const norm = new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
        
        // Find a perpendicular vector (tangent)
        let tangent = new THREE.Vector3(1, 0, 0);
        if (Math.abs(norm.x) > 0.9) tangent.set(0, 1, 0); // If normal is X-aligned, use Y
        
        const right = new THREE.Vector3().crossVectors(norm, tangent).normalize();
        const forward = new THREE.Vector3().crossVectors(norm, right).normalize();

        // 4 lights in a ring around the equator
        const p1 = right.clone().multiplyScalar(offset);
        const p2 = forward.clone().multiplyScalar(offset);
        const p3 = right.clone().negate().multiplyScalar(offset);
        const p4 = forward.clone().negate().multiplyScalar(offset);

        return [
            [p1.x, p1.y, p1.z],
            [p2.x, p2.y, p2.z],
            [p3.x, p3.y, p3.z],
            [p4.x, p4.y, p4.z]
        ] as const;
    }, [normal, offset]);

    return (
        <group position={[position.x, position.y, position.z]}>
            <mesh>
                <sphereGeometry args={[radius, 16, 16]} />
                <meshStandardMaterial 
                    color="#222222" 
                    emissive="#aaaaaa"
                    emissiveIntensity={0.2}
                    metalness={0.0}
                    roughness={1.0}
                />
            </mesh>
            {/* Light Array */}
            {lightPositions.map((pos, i) => (
                <pointLight 
                    key={i}
                    position={pos} 
                    color="#ffffff" 
                    intensity={4} 
                    distance={radius * 15} 
                    decay={2} 
                />
            ))}
        </group>
    );
}

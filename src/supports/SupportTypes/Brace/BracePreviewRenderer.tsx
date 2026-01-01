import React from 'react';
import * as THREE from 'three';
import type { BracePreviewData } from './bracePlacementState';

export function BracePreviewRenderer({ preview }: { preview: BracePreviewData }) {
    const start = new THREE.Vector3(preview.start.x, preview.start.y, preview.start.z);
    const end = new THREE.Vector3(preview.end.x, preview.end.y, preview.end.z);
    const dir = end.clone().sub(start);
    const len = dir.length();
    const startShaftRadius = Math.max(0.001, preview.startDiameterMm / 2);
    const endShaftRadius = Math.max(0.001, preview.endDiameterMm / 2);
    const startKnotRadius = Math.max(0.001, (preview.startDiameterMm + 0.1) / 2);
    const endKnotRadius = Math.max(0.001, (preview.endDiameterMm + 0.1) / 2);

    const maxKnotRadius = Math.max(startKnotRadius, endKnotRadius);

    const offset = maxKnotRadius * 2.25;
    const lightOffsets = [
        [offset, offset, offset],
        [-offset, -offset, offset],
        [-offset, offset, -offset],
        [offset, -offset, -offset],
    ] as const;

    const renderEndpoint = (p: THREE.Vector3, keyPrefix: string, knotRadius: number) => {
        return (
            <group>
                <mesh position={[p.x, p.y, p.z]}>
                    <sphereGeometry args={[knotRadius, 16, 16]} />
                    <meshStandardMaterial
                        color="#00ff00"
                        emissive="#00ff00"
                        emissiveIntensity={0.18}
                        transparent
                        opacity={0.75}
                        metalness={0.0}
                        roughness={1.0}
                        depthWrite={false}
                    />
                </mesh>
                {lightOffsets.map((o, i) => (
                    <pointLight
                        key={`${keyPrefix}-light-${i}`}
                        position={[p.x + o[0], p.y + o[1], p.z + o[2]]}
                        color="#00ff00"
                        intensity={4}
                        distance={knotRadius * 15}
                        decay={2}
                    />
                ))}
            </group>
        );
    };

    // Immediate feedback: even if start/end overlap (e.g. right after first click),
    // still render the start sphere so the user can see placement mode is active.
    if (len < 0.001) {
        return (
            <group>
                {renderEndpoint(start, 'start', startKnotRadius)}
            </group>
        );
    }

    const mid = start.clone().add(end).multiplyScalar(0.5);
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());

    return (
        <group>
            <group position={[mid.x, mid.y, mid.z]} quaternion={quat} scale={[1, len, 1]}>
                <mesh>
                    {/* CylinderGeometry is Y-up: radiusTop applies to +Y (end), radiusBottom to -Y (start) */}
                    <cylinderGeometry args={[endShaftRadius, startShaftRadius, 1, 10]} />
                    <meshStandardMaterial color="#00ff00" transparent opacity={0.5} emissive="#00ff00" emissiveIntensity={0.2} depthWrite={false} />
                </mesh>
            </group>
            {renderEndpoint(start, 'start', startKnotRadius)}
            {renderEndpoint(end, 'end', endKnotRadius)}
        </group>
    );
}

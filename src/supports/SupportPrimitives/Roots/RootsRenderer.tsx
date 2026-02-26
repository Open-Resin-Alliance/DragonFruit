import React from 'react';
import * as THREE from 'three';
import { Roots } from '../../types';
import { useSyncExternalStore } from 'react';
import { getRaftSettings, subscribeToRaftStore } from '../../Rafts/Crenelated/RaftState';
import { subscribeToSettings, getSettingsSnapshot } from '../../Settings';

interface RootsRendererProps {
    root: Roots;
    shaftDiameter: number; // Diameter of the connecting trunk shaft (matches top diameter)
    color?: string;
    emissive?: string;
    emissiveIntensity?: number;
    transparent?: boolean;
    opacity?: number;
    raycast?: any;
    diskColor?: string; // Granular override for base disk
    coneColor?: string; // Granular override for cone part
    diskMaterialOverride?: { transparent?: boolean; opacity?: number; depthWrite?: boolean };
    radialSegments?: number;
    sphereSegments?: number;
}

/**
 * RootsRenderer - Renders the base/footprint element of a support.
 * 
 * Per Anatomy spec:
 * - Truncated cone with integrated spherical top
 * - Bottom diameter = footprint (default 3.0mm)
 * - Top diameter = matches trunk shaft
 * - Sphere diameter = top diameter
 * - Trunk shaft embeds into the spherical top
 */
export function RootsRenderer({
    root,
    shaftDiameter,
    color = '#ff8800',
    emissive = '#000000',
    emissiveIntensity = 0,
    transparent = false,
    opacity = 1,
    raycast,
    raftOverride, // Optional override for preview
    diskColor,
    coneColor,
    diskMaterialOverride,
    radialSegments = 24,
    sphereSegments = 24,
}: RootsRendererProps & { raftOverride?: { bottomMode: 'off' | 'solid' | 'line'; thickness: number } }) {
    const storeRaft = useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);
    const settings = useSyncExternalStore(subscribeToSettings, getSettingsSnapshot, getSettingsSnapshot);

    // Use override if provided, otherwise use store
    const raft = raftOverride || storeRaft;

    const rootsSettings = settings.roots;

    // Use root properties directly (populated by builder, supports overrides)
    const diskHeight = root.diskHeight;
    const coneHeight = root.coneHeight;

    // When a raft is enabled, the roots should sit on top of the raft with a very thin
    // overlap disk.
    const hasSolidBottom = (raft as any).bottomMode === 'solid';
    const raftThickness = (raft as any).thickness ?? 0;
    const effectiveDiskHeight = hasSolidBottom ? 0.05 : diskHeight;
    const verticalOffset = hasSolidBottom ? Math.max(raftThickness - effectiveDiskHeight, 0) : 0;

    const basePos = new THREE.Vector3(
        root.transform.pos.x,
        root.transform.pos.y,
        root.transform.pos.z + verticalOffset,
    );

    // Dimensions
    const bottomRadius = root.diameter / 2;
    const topRadius = shaftDiameter / 2;    // Matches trunk shaft
    const sphereRadius = topRadius;         // Sphere diameter = top diameter

    // Rotate to lay flat on XY plane (cylinder default is Y-up)
    const coneQuaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

    // 1. Disk sits at the very bottom
    const diskCenter = basePos.clone().add(new THREE.Vector3(0, 0, effectiveDiskHeight / 2));

    // 2. Cone sits at the top of the disk
    // Its base starts at basePos.z + effectiveDiskHeight
    const coneCenter = basePos.clone().add(new THREE.Vector3(0, 0, effectiveDiskHeight + coneHeight / 2));

    // 3. Sphere sits at top of cone
    const sphereCenter = basePos.clone().add(new THREE.Vector3(0, 0, effectiveDiskHeight + coneHeight));

    // Resolve colors
    const finalDiskColor = diskColor || color;
    const finalConeColor = coneColor || color;

    const diskTransparent = diskMaterialOverride?.transparent ?? transparent;
    const diskOpacity = diskMaterialOverride?.opacity ?? opacity;
    const diskDepthWrite = diskMaterialOverride?.depthWrite ?? !diskTransparent;

    return (
        <group>
            {/* Bottom disk - footprint on plate */}
            <group position={[diskCenter.x, diskCenter.y, diskCenter.z]} quaternion={coneQuaternion}>
                <mesh raycast={raycast}>
                    <cylinderGeometry args={[bottomRadius, bottomRadius, effectiveDiskHeight, radialSegments]} />
                    <meshStandardMaterial
                        color={finalDiskColor}
                        emissive={emissive}
                        emissiveIntensity={emissiveIntensity}
                        transparent={diskTransparent}
                        opacity={diskOpacity}
                        depthWrite={diskDepthWrite}
                    />
                </mesh>
            </group>

            {/* Truncated cone body - only render if height > 0 */}
            {coneHeight > 0 && (
                <group position={[coneCenter.x, coneCenter.y, coneCenter.z]} quaternion={coneQuaternion}>
                    <mesh raycast={raycast}>
                        <cylinderGeometry args={[topRadius, bottomRadius, coneHeight, radialSegments]} />
                        <meshStandardMaterial
                            color={finalConeColor}
                            emissive={emissive}
                            emissiveIntensity={emissiveIntensity}
                            transparent={transparent}
                            opacity={opacity}
                            depthWrite={!transparent}
                        />
                    </mesh>
                </group>
            )}

            {/* Spherical top - trunk shaft embeds into this */}
            {coneHeight > 0 && (
                <mesh position={[sphereCenter.x, sphereCenter.y, sphereCenter.z]} raycast={raycast}>
                    <sphereGeometry args={[sphereRadius, sphereSegments, Math.max(6, Math.floor(sphereSegments * 0.75))]} />
                    <meshStandardMaterial
                        color={finalConeColor}
                        emissive={emissive}
                        emissiveIntensity={emissiveIntensity}
                        transparent={transparent}
                        opacity={opacity}
                        depthWrite={!transparent}
                    />
                </mesh>
            )}
        </group>
    );
}

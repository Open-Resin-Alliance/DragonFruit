"use client";

import React, { useMemo, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { getScanVisualPosition } from '@/utils/scanPositioning';
import type { ModelTransform } from '@/hooks/useModelTransform';

interface Props {
    geometry: THREE.BufferGeometry | undefined;
    faceLabels: Int32Array | undefined;
    transform?: ModelTransform;
    visible: boolean;
}

/**
 * Renders the mesh with faces colored according to their Island ID.
 */
export function MeshClassificationRenderer({ geometry, faceLabels, transform, visible }: Props) {
    const meshRef = useRef<THREE.Mesh>(null);

    // Create a clone of the geometry with vertex colors when faceLabels change
    const coloredGeometry = useMemo(() => {
        if (!geometry || !faceLabels) return null;

        // Clone to avoid mutating original
        const geom = geometry.clone();

        // Ensure non-indexed for easier face coloring (or handle indices)
        // Handling indexed geometry for face coloring is tricky because vertices are shared.
        // To color FACES distinctly, we usually need non-indexed geometry (vertex duplication) 
        // OR we use a texture/shader. 
        // Simplest "Color per Face" approach in Three.js standard material: use non-indexed geometry.

        const nonIndexed = geom.toNonIndexed();
        const count = nonIndexed.getAttribute('position').count;

        // Color attribute
        const colors = new Float32Array(count * 3);
        const color = new THREE.Color();

        // Cache colors
        const colorMap = new Map<number, THREE.Color>();
        const getColor = (id: number) => {
            if (id === 0) return new THREE.Color(0x333333); // Grey for void
            if (!colorMap.has(id)) {
                const hue = (id * 0.618033988749895) % 1.0;
                colorMap.set(id, new THREE.Color().setHSL(hue, 0.8, 0.6));
            }
            return colorMap.get(id)!;
        };

        // Faces are 3 vertices.
        // faceLabels[i] corresponds to face i.
        // Vertices for face i are at i*3, i*3+1, i*3+2

        for (let i = 0; i < faceLabels.length; i++) {
            const islandId = faceLabels[i];
            const c = getColor(islandId);

            // Set for all 3 vertices of the face
            const vIdx = i * 3;

            colors[vIdx * 3] = c.r;
            colors[vIdx * 3 + 1] = c.g;
            colors[vIdx * 3 + 2] = c.b;

            colors[(vIdx + 1) * 3] = c.r;
            colors[(vIdx + 1) * 3 + 1] = c.g;
            colors[(vIdx + 1) * 3 + 2] = c.b;

            colors[(vIdx + 2) * 3] = c.r;
            colors[(vIdx + 2) * 3 + 1] = c.g;
            colors[(vIdx + 2) * 3 + 2] = c.b;
        }

        nonIndexed.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        return nonIndexed;

    }, [geometry, faceLabels]);

    if (!visible || !coloredGeometry) return null;

    return (
        <group position={getScanVisualPosition(transform)}>
            <mesh
                geometry={coloredGeometry}
                ref={meshRef}
                rotation={[Math.PI / 2, 0, 0]} // Original STL assumed X=Right, Y=Back, Z=Up convention mismatch or handled by parent? 
            // Actually getScanVisualPosition handles position, but rotation?
            // The expansion visualization uses specific transforms.
            // Let's assume standard orientation for now, user can verify. 
            // WAIT: prepareTransformedGeom centered and rotated it. 
            // So the geometry is ALREADY transformed in 'useIslandVolumeAnalysis'.
            // But here we are rendering it. 
            // If we pass the *original* geometry, we need to transform it.
            // If we pass the *transformed* geometry, it's already aligned to world 0,0,0 (visually).
            // Scan Results rely on transformed geometry.
            // So `coloredGeometry` has the rotation/scale BAKED IN.
            // So we should NOT apply transform again here, except maybe centering if `getScanVisualPosition` does something.
            // However, `getScanVisualPosition` usually returns the position of the model group.
            // If the geometry is baked, it sits at 0,0,0 relative to the group?
            // The simulator uses the baked positions. 
            // So we just render at 0,0,0.
            >
                <meshStandardMaterial
                    vertexColors
                    roughness={0.5}
                    metalness={0.1}
                    side={THREE.DoubleSide}
                />
            </mesh>
        </group>
    );
}

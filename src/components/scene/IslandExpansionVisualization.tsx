"use client";

import React, { useMemo, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { BasinFillSimulator } from '@/volumeAnalysis/islandVolume/steps/expansion/BasinFillSimulator';
import { BasinFillProxy } from '@/volumeAnalysis/islandVolume/steps/expansion/BasinFillProxy';
import { getScanVisualPosition } from '@/utils/scanPositioning';
import type { ModelTransform } from '@/hooks/useModelTransform';

interface Props {
    simulator: BasinFillSimulator | BasinFillProxy | null;
    transform?: ModelTransform;
    enabled: boolean;
}

export function IslandExpansionVisualization({ simulator, transform, enabled }: Props) {
    const meshRef = useRef<THREE.InstancedMesh>(null);
    const textureRef = useRef<THREE.DataTexture | null>(null);
    const materialRef = useRef<THREE.MeshStandardMaterial>(null);
    const { invalidate } = useThree();

    // Kick the demand-mode loop alive when the animation starts — without this,
    // useFrame never fires in an idle demand scene and the simulator's first
    // flush never renders. Uses invalidate + rAF defer per R3F scaling-performance
    // docs (avoids first-frame-jump).
    useEffect(() => {
        if (!enabled || !simulator) return;
        let cancelled = false;
        invalidate();
        requestAnimationFrame(() => {
            if (cancelled) return;
            invalidate();
        });
        return () => { cancelled = true; };
    }, [enabled, simulator, invalidate]);

    // 1. Initialize GPU Data (Texture & Geometry)
    // Re-run only if simulator instance changes or enabled toggle flips
    useEffect(() => {
        if (!simulator || !enabled || !meshRef.current) return;

        // Wait for surface calculation (Proxy might need a frame to sync?)
        // Actually, Proxy copies it in constructor. If it's null, we can't do surface culling yet.
        const surfaceIndices = simulator.surfaceVoxelIndices;
        if (!surfaceIndices) {
            console.warn('[Visual] Surface Indices not ready yet. Skipping init.');
            return;
        }

        const mesh = meshRef.current;
        const solidCount = simulator.solidVoxelCount;
        const surfaceCount = surfaceIndices.length;

        console.log(`[Visual] Initializing GPU Renderer. Solids: ${solidCount}, Surface: ${surfaceCount}. Ratio: ${(surfaceCount / solidCount).toFixed(2)}`);

        // --- A. Setup Data Texture for State ---
        // Size = square root of solid count
        const texSize = Math.ceil(Math.sqrt(solidCount));
        const data = new Float32Array(texSize * texSize).fill(0); // Default 0 (Unassigned)

        // Initial State Fill
        const labels = simulator.labels;
        for (let i = 0; i < solidCount; i++) {
            data[i] = labels[i];
        }

        const texture = new THREE.DataTexture(data, texSize, texSize, THREE.RedFormat, THREE.FloatType);
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.needsUpdate = true;
        textureRef.current = texture;

        // --- B. Setup InstancedMesh (Surface Voxels Only) ---
        // We manually allocate the VoxelID attribute
        const voxelIdAttribute = new Float32Array(surfaceCount);
        const dummy = new THREE.Object3D();

        for (let i = 0; i < surfaceCount; i++) {
            const solidIdx = surfaceIndices[i];
            voxelIdAttribute[i] = solidIdx;

            // Set Static Position
            const x = simulator.positions[solidIdx * 3];
            const y = simulator.positions[solidIdx * 3 + 1];
            const z = simulator.positions[solidIdx * 3 + 2];
            dummy.position.set(x, y, z);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
        }

        mesh.geometry.setAttribute('aVoxelID', new THREE.InstancedBufferAttribute(voxelIdAttribute, 1));
        mesh.instanceMatrix.needsUpdate = true;

        // --- C. Configure Material Shader ---
        if (materialRef.current) {
            const mat = materialRef.current;
            mat.onBeforeCompile = (shader) => {
                // Inject Uniforms & Attributes
                shader.uniforms.uStateTexture = { value: texture };
                shader.uniforms.uTexSize = { value: texSize };

                // Vertex Shader Injection
                shader.vertexShader = `
                    attribute float aVoxelID;
                    uniform sampler2D uStateTexture;
                    uniform float uTexSize;
                    varying float vIslandID;
                ` + shader.vertexShader;

                // Replace 'begin_vertex' to lookup state and set visibility
                shader.vertexShader = shader.vertexShader.replace(
                    '#include <begin_vertex>',
                    `
                    #include <begin_vertex>

                    // Calculate UV from VoxelID (Integer Index)
                    float tx = mod(aVoxelID, uTexSize);
                    float ty = floor(aVoxelID / uTexSize);
                    vec2 uv = (vec2(tx, ty) + 0.5) / uTexSize;

                    // Read State
                    float state = texture2D(uStateTexture, uv).r;
                    vIslandID = state;

                    // Visibility Logic
                    // If state == 0 (Unassigned), collapse to 0 scale (hide)
                    // (Unless we want to show unassigned as gray? No, user wants expansion)
                    if (state < 0.1) {
                         transformed *= 0.0;
                    }
                    `
                );

                // Fragment Shader Injection to Colorize
                shader.fragmentShader = `
                    varying float vIslandID;
                    
                    // Golden Ratio Color Generator
                    vec3 getIslandColor(float id) {
                        if (id < 0.1) return vec3(0.0); // Should be hidden
                        // Simple hash-ish hue
                        float hue = mod(id * 0.618033988749895, 1.0);
                        
                        // HSL to RGB conversion (simplified)
                        // approximation or built-in? GLSL doesn't have HSL.
                        // We'll use a cosine palette for speed & smoothness
                        // vec3 col = 0.5 + 0.5 * cos(6.28318 * (hue + vec3(0.0, 0.33, 0.67))); 
                        
                        // Or manual HSL2RGB
                        float h = hue;
                        float s = 0.8;
                        float l = 0.6;
                        
                        float c = (1.0 - abs(2.0 * l - 1.0)) * s;
                        float x = c * (1.0 - abs(mod(h * 6.0, 2.0) - 1.0));
                        float m = l - c / 2.0;
                        
                        vec3 rgb = vec3(0.0);
                        if (0.0 <= h && h < 1.0/6.0) rgb = vec3(c, x, 0.0);
                        else if (1.0/6.0 <= h && h < 2.0/6.0) rgb = vec3(x, c, 0.0);
                        else if (2.0/6.0 <= h && h < 3.0/6.0) rgb = vec3(0.0, c, x);
                        else if (3.0/6.0 <= h && h < 4.0/6.0) rgb = vec3(0.0, x, c);
                        else if (4.0/6.0 <= h && h < 5.0/6.0) rgb = vec3(x, 0.0, c);
                        else if (5.0/6.0 <= h && h < 1.0) rgb = vec3(c, 0.0, x);
                        
                        return rgb + m;
                    }
                ` + shader.fragmentShader;

                // Color assignment
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <color_fragment>',
                    `
                    #include <color_fragment>
                    if (vIslandID > 0.0) {
                        diffuseColor.rgb = getIslandColor(vIslandID);
                    }
                    `
                );
            };
            mat.needsUpdate = true;
        }

    }, [simulator, enabled]);


    // 2. Animation Loop: Update Data Texture
    useFrame(() => {
        if (!enabled || !simulator || !textureRef.current) return;

        // Flush generic changes
        const changes = simulator.flushChanges(200000); // Massive batch size supported
        if (changes.length === 0) return;

        const texture = textureRef.current;
        const data = texture.image.data;
        if (!data) return;
        const labels = simulator.labels;

        for (let i = 0; i < changes.length; i++) {
            const idx = changes[i]; // Solid Index
            data[idx] = labels[idx];
        }

        texture.needsUpdate = true; // Fast upload
        invalidate(); // Keep the loop alive in demand mode while changes keep flushing.
    });

    if (!enabled || !simulator) return null;

    // Safety: If surface indices missing, don't render or fallback?
    // We return null to avoid crashing, useEffect will verify logs.
    if (!simulator.surfaceVoxelIndices) return null;

    const voxelSize = simulator.pxMm;
    const surfaceCount = simulator.surfaceVoxelIndices.length;

    return (
        <group position={getScanVisualPosition(transform)}>
            <instancedMesh
                ref={meshRef}
                args={[undefined, undefined, surfaceCount]}
                frustumCulled={false}
            >
                <boxGeometry args={[voxelSize, voxelSize, simulator.layerHeightMm]} />
                <meshStandardMaterial
                    ref={materialRef}
                    roughness={0.8}
                    metalness={0.0}
                />
            </instancedMesh>
        </group>
    );
}

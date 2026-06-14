import React, { useMemo, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { IslandMarker } from '@/volumeAnalysis/IslandScan/islandOverlayLogic';
import { applyIslandOverlay as drawIslandOverlay } from '@/volumeAnalysis/IslandScan/islandOverlayPainter';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { getScanVisualPosition } from '@/utils/scanPositioning';

type IslandOverlayProps = {
  markers: IslandMarker[];
  meshRef?: THREE.Mesh | null;
  brushRadiusMm: number;
  color: string;
  opacity: number;
  transform?: ModelTransform;
  centerOffset?: THREE.Vector3;
  selectedIslandId?: number | null;
  clipLower?: number | null;
  clipUpper?: number | null;
};

export function IslandOverlay({ markers, meshRef, brushRadiusMm, color, opacity, transform, centerOffset, selectedIslandId, clipLower, clipUpper }: IslandOverlayProps) {
  const threeColor = useMemo(() => new THREE.Color(color), [color]);
  const visibleColor = useMemo(() => new THREE.Color('#ffff00'), []); // Bright yellow when visible
  const occludedColor = useMemo(() => new THREE.Color('#fF6600'), []); // Vibrant red-orange when behind mesh

  // Initialize clipping planes once (update in-place to avoid recreation)
  const clippingPlanesRef = React.useRef<THREE.Plane[]>([]);

  React.useEffect(() => {
    const planes: THREE.Plane[] = [];

    if (clipLower != null) {
      planes.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), -clipLower));
    }
    if (clipUpper != null) {
      planes.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), clipUpper));
    }

    clippingPlanesRef.current = planes;
  }, [clipLower, clipUpper]);

  const clippingPlanes = clippingPlanesRef.current;



  // Split markers into instanced (non-selected positive IDs), selected (double-pass occluded/visible), and negative IDs (utility markers)
  const { instancedMarkers, selectedMarkers, negativeIdMarkers } = useMemo(() => {
    const instanced: IslandMarker[] = [];
    const selected: IslandMarker[] = [];
    const neg: IslandMarker[] = [];

    for (const m of markers) {
      if (m.id < 0) {
        neg.push(m);
      } else if (m.id === selectedIslandId) {
        selected.push(m);
      } else {
        instanced.push(m);
      }
    }

    return { instancedMarkers: instanced, selectedMarkers: selected, negativeIdMarkers: neg };
  }, [markers, selectedIslandId]);

  const instancedMeshRef = useRef<THREE.InstancedMesh>(null);
  const instancedMaterialRef = useRef<THREE.ShaderMaterial>(null);

  // Synchronously update instance matrices before rendering
  React.useLayoutEffect(() => {
    const mesh = instancedMeshRef.current;
    if (!mesh || instancedMarkers.length === 0) return;

    const tempMatrix = new THREE.Matrix4();
    const tempPosition = new THREE.Vector3();
    const tempScale = new THREE.Vector3();

    instancedMarkers.forEach((marker, index) => {
      if (!marker.geometry) return;
      if (!marker.geometry.boundingBox) {
        marker.geometry.computeBoundingBox();
      }
      const bbox = marker.geometry.boundingBox!;
      const radius = (bbox.max.x - bbox.min.x) / 2;

      tempPosition.set(marker.centerX, marker.centerY, marker.baseZ);
      // Slightly squashed sphere (oblate spheroid) sitting flat as a volumetric dome
      tempScale.set(radius, radius, radius * 0.6);
      tempMatrix.compose(tempPosition, new THREE.Quaternion(), tempScale);

      mesh.setMatrixAt(index, tempMatrix);
    });

    mesh.instanceMatrix.needsUpdate = true;
  }, [instancedMarkers]);

  // Uniform allocations
  const instancedUniforms = useMemo(() => ({
    uColor: { value: threeColor },
    uOpacity: { value: opacity },
    uTime: { value: 0.0 },
    uSelected: { value: 0.0 },
  }), [threeColor, opacity]);

  const selectedUniforms = useMemo(() => ({
    occluded: {
      uColor: { value: occludedColor },
      uOpacity: { value: 0.95 },
      uTime: { value: 0.0 },
      uSelected: { value: 1.0 },
    },
    visible: {
      uColor: { value: visibleColor },
      uOpacity: { value: 0.95 },
      uTime: { value: 0.0 },
      uSelected: { value: 1.0 },
    },
  }), [occludedColor, visibleColor]);

  // Update time uniforms in a single R3F frame loop to keep all glows in sync at 2 Hz
  useFrame(({ clock }) => {
    const elapsed = clock.getElapsedTime();
    if (instancedMaterialRef.current) {
      instancedMaterialRef.current.uniforms.uTime.value = elapsed;
    }
    selectedUniforms.occluded.uTime.value = elapsed;
    selectedUniforms.visible.uTime.value = elapsed;
  });

  if (markers.length === 0) {
    return null;
  }

  return (
    <group position={getScanVisualPosition(transform)}>
      {/* 1. Render utility markers (negative IDs) */}
      {negativeIdMarkers.map((marker) => (
        <mesh key={marker.id} geometry={marker.geometry} renderOrder={99999}>
          <meshBasicMaterial
            color={marker.id < -1_000_000 ? '#00ff00' : '#ffff00'}
            depthTest={false}
            depthWrite={false}
            clippingPlanes={clippingPlanes}
          />
        </mesh>
      ))}

      {/* 2. Render all unselected island markers using a single draw call instanced mesh */}
      {instancedMarkers.length > 0 && (
        <instancedMesh
          key={instancedMarkers.length}
          ref={instancedMeshRef}
          args={[undefined, undefined, instancedMarkers.length]}
        >
          <sphereGeometry args={[1, 24, 24]} />
          <shaderMaterial
            ref={instancedMaterialRef}
            clipping={true}
            clippingPlanes={clippingPlanes}
            depthTest={true}
            depthWrite={false}
            transparent={true}
            uniforms={instancedUniforms}
            vertexShader={VERTEX_SHADER}
            fragmentShader={FRAGMENT_SHADER}
            clipIntersection={true}
          />
        </instancedMesh>
      )}

      {/* 3. Render selected island (if any) twice for occlusion contrast */}
      {selectedMarkers.map((marker) => {
        if (!marker.geometry) return null;
        if (!marker.geometry.boundingBox) {
          marker.geometry.computeBoundingBox();
        }
        const bbox = marker.geometry.boundingBox!;
        const radius = (bbox.max.x - bbox.min.x) / 2;

        return (
          <group
            key={marker.id}
            position={[marker.centerX, marker.centerY, marker.baseZ]}
            scale={[radius, radius, radius * 0.6]}
          >
            {/* Occluded state - orange, no depth test, renders behind */}
            <mesh renderOrder={999}>
              <sphereGeometry args={[1, 24, 24]} />
              <shaderMaterial
                clipping={true}
                clippingPlanes={clippingPlanes}
                depthTest={false}
                depthWrite={false}
                transparent={true}
                uniforms={selectedUniforms.occluded}
                vertexShader={VERTEX_SHADER}
                fragmentShader={FRAGMENT_SHADER}
                clipIntersection={true}
              />
            </mesh>

            {/* Visible state - yellow, with depth test, renders on top */}
            <mesh renderOrder={1000}>
              <sphereGeometry args={[1, 24, 24]} />
              <shaderMaterial
                clipping={true}
                clippingPlanes={clippingPlanes}
                depthTest={true}
                depthWrite={false}
                transparent={true}
                uniforms={selectedUniforms.visible}
                vertexShader={VERTEX_SHADER}
                fragmentShader={FRAGMENT_SHADER}
                clipIntersection={true}
              />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

const VERTEX_SHADER = `
#include <common>
#include <clipping_planes_pars_vertex>

uniform float uTime;
varying vec3 vViewPosition;
varying vec3 vPosition;

void main() {
  vPosition = position;
  
  // 2 Hz breathing pulse
  float pulse = 1.0 + 0.12 * sin(uTime * 12.566370618);
  vec3 localPos = position * pulse;
  
  #ifdef USE_INSTANCING
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(localPos, 1.0);
  #else
    vec4 mvPosition = modelViewMatrix * vec4(localPos, 1.0);
  #endif

  #include <clipping_planes_vertex>
  
  vViewPosition = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const FRAGMENT_SHADER = `
#include <clipping_planes_pars_fragment>
uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;
uniform float uSelected;

varying vec3 vViewPosition;
varying vec3 vPosition;

void main() {
  #include <clipping_planes_fragment>
  
  // Distance from center of the sphere (0.0 to 1.0)
  float dist = length(vPosition);
  
  // Intensity gradient: 1.0 at center, fading to 0.0 at the outer surface
  float intensity = max(0.0, 1.0 - dist);
  
  // Volumetric soft exponential fadeout
  float softHalo = pow(intensity, 2.5);
  
  // High-intensity laser highlight core in the exact center
  float laserCore = pow(intensity, 16.0);
  
  // 2 Hz breathing pulse for alpha
  float pulseAlpha = 0.85 + 0.15 * sin(uTime * 12.566370618);
  
  float selectionMultiplier = uSelected > 0.5 ? 1.5 : 1.0;
  
  // Blend color with a brilliant white highlight core
  vec3 coreColor = vec3(1.0);
  vec3 finalColor = mix(uColor, coreColor, laserCore * 0.7);
  
  // Scale alpha: soft halo + sharp laser core, scaled by opacity and 2 Hz pulse
  float alpha = clamp((uOpacity * softHalo + laserCore * 0.4) * pulseAlpha * selectionMultiplier, 0.0, 0.95);
  
  gl_FragColor = vec4(finalColor, alpha);
}
`;

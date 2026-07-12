import React, { useMemo, useRef, useLayoutEffect } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { IslandMarker } from '@/volumeAnalysis/IslandScan/islandOverlayLogic';
import type { ModelTransform } from '@/hooks/useModelTransform';

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

// --- Puck Shaders ---
const PUCK_VERTEX_SHADER = `
#include <common>
#include <clipping_planes_pars_vertex>

varying vec3 vNormal;
varying vec3 vViewPosition;

void main() {
  vNormal = normalize(normalMatrix * normal);
  
  #ifdef USE_INSTANCING
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  #else
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  #endif
  
  #include <clipping_planes_vertex>
  vViewPosition = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const PUCK_FRAGMENT_SHADER = `
#include <clipping_planes_pars_fragment>

uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;

varying vec3 vNormal;
varying vec3 vViewPosition;

void main() {
  #include <clipping_planes_fragment>
  
  vec3 normal = normalize(vNormal);
  vec3 viewDir = normalize(vViewPosition);
  
  // 1.0 at center (facing camera), 0.0 at silhouette edges
  float facing = max(0.0, dot(normal, viewDir));
  
  // Soft volumetric halo
  float softHalo = pow(facing, 2.5);
  
  // High-intensity color core, matching indicator hue but saturated and brighter
  float core = pow(facing, 20.0);
  vec3 coreColor = clamp(uColor * 2.0, 0.0, 1.0);
  vec3 finalColor = mix(uColor, coreColor, core * 0.95);
  
  // 0.35 Hz breathing pulse (omega = 2 * pi * 0.35 = 2.19911486)
  float pulse = 0.8 + 0.2 * sin(uTime * 2.19911486);
  
  float alpha = clamp((uOpacity * softHalo + core * 0.5) * pulse, 0.0, 0.95);
  
  gl_FragColor = vec4(finalColor, alpha);
}
`;

// Temporary values to avoid per-frame allocations in matrix updates
const tempPosition = new THREE.Vector3();
const tempScale = new THREE.Vector3();
const tempMatrix = new THREE.Matrix4();

export function IslandOverlay({
  markers,
  color,
  opacity,
  transform,
  selectedIslandId,
  clipLower,
  clipUpper,
}: IslandOverlayProps) {
  const threeColor = useMemo(() => new THREE.Color(color), [color]);
  const visibleColor = useMemo(() => new THREE.Color('#ffff00'), []); // Bright yellow
  const occludedColor = useMemo(() => new THREE.Color('#ff6600'), []); // Vibrant orange-red

  const puckInstancedRef = useRef<THREE.InstancedMesh>(null);

  // Initialize clipping planes
  const clippingPlanesRef = useRef<THREE.Plane[]>([]);
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

  // Single shared uTime uniform updated via THREE.Timer (Clock is deprecated)
  const globalTimeUniform = useMemo(() => ({ value: 0 }), []);
  const timerRef = useRef(new THREE.Timer());
  useFrame(() => {
    timerRef.current.update();
    globalTimeUniform.value = timerRef.current.getElapsed();
  });

  // Filter unselected vs selected markers, and handle utility markers (negative IDs)
  const utilityMarkers = useMemo(() => markers.filter(m => m.id < 0), [markers]);
  const normalMarkers = useMemo(() => markers.filter(m => m.id >= 0), [markers]);

  const instancedMarkers = useMemo(() => {
    return normalMarkers.filter(m => m.id !== selectedIslandId);
  }, [normalMarkers, selectedIslandId]);

  const selectedMarker = useMemo(() => {
    return normalMarkers.find(m => m.id === selectedIslandId);
  }, [normalMarkers, selectedIslandId]);

  // Update instance matrices for unselected pucks
  useLayoutEffect(() => {
    const puckMesh = puckInstancedRef.current;
    if (!puckMesh) return;

    instancedMarkers.forEach((marker, index) => {
      // Scale up by 30%
      const radius = (marker.radius ?? 0.1) * 1.3;

      tempPosition.set(marker.centerX, marker.centerY, marker.baseZ);
      tempScale.set(radius, radius, radius);
      tempMatrix.compose(tempPosition, new THREE.Quaternion(), tempScale);
      puckMesh.setMatrixAt(index, tempMatrix);
    });

    puckMesh.instanceMatrix.needsUpdate = true;
  }, [instancedMarkers]);

  // Memoize uniforms for standard materials
  const unselectedPuckUniforms = useMemo(() => ({
    uColor: { value: threeColor },
    uOpacity: { value: opacity },
    uTime: globalTimeUniform,
  }), [threeColor, opacity, globalTimeUniform]);

  const selectedOccludedPuckUniforms = useMemo(() => ({
    uColor: { value: occludedColor },
    uOpacity: { value: 0.95 },
    uTime: globalTimeUniform,
  }), [occludedColor, globalTimeUniform]);

  const selectedVisiblePuckUniforms = useMemo(() => ({
    uColor: { value: visibleColor },
    uOpacity: { value: 0.95 },
    uTime: globalTimeUniform,
  }), [visibleColor, globalTimeUniform]);

  // Calculate selected marker properties if it exists
  const selectedDetails = useMemo(() => {
    if (!selectedMarker) return null;
    // Scale up by 30%
    const radius = (selectedMarker.radius ?? 0.1) * 1.3;
    return { radius };
  }, [selectedMarker]);

  if (markers.length === 0) {
    return null;
  }

  return (
    <group>
      {/* 1. Render utility markers (negative IDs for center/seed points) */}
      {utilityMarkers.map((marker) => {
        if (!marker.geometry) return null;
        const isSeed = marker.id < -1_000_000;
        const markerColor = isSeed ? '#00ff00' : '#ffff00';
        return (
          <mesh key={marker.id} geometry={marker.geometry} renderOrder={99999}>
            <meshBasicMaterial
              color={markerColor}
              depthTest={false}
              depthWrite={false}
              clippingPlanes={clippingPlanes}
            />
          </mesh>
        );
      })}

      {/* 2. Render all unselected island markers using instanced rendering */}
      {instancedMarkers.length > 0 && (
        <instancedMesh
          key={`pucks-${instancedMarkers.length}`}
          ref={puckInstancedRef}
          args={[undefined, undefined, instancedMarkers.length]}
        >
          <sphereGeometry args={[1, 16, 16]} />
          <shaderMaterial
            clipping={true}
            clippingPlanes={clippingPlanes}
            depthTest={true}
            depthWrite={false}
            transparent={true}
            uniforms={unselectedPuckUniforms}
            vertexShader={PUCK_VERTEX_SHADER}
            fragmentShader={PUCK_FRAGMENT_SHADER}
          />
        </instancedMesh>
      )}

      {/* 3. Render selected island twice (occluded/visible passes) for high contrast */}
      {selectedMarker && selectedDetails && (
        <group position={[selectedMarker.centerX, selectedMarker.centerY, selectedMarker.baseZ]}>
          {/* Occluded state (Orange-Red, renders through model meshes) */}
          <mesh scale={[selectedDetails.radius, selectedDetails.radius, selectedDetails.radius]} renderOrder={999}>
            <sphereGeometry args={[1, 16, 16]} />
            <shaderMaterial
              clipping={true}
              clippingPlanes={clippingPlanes}
              depthTest={false}
              depthWrite={false}
              transparent={true}
              uniforms={selectedOccludedPuckUniforms}
              vertexShader={PUCK_VERTEX_SHADER}
              fragmentShader={PUCK_FRAGMENT_SHADER}
            />
          </mesh>

          {/* Visible state (Bright Yellow, depth-tested to sit on top of model surface) */}
          <mesh scale={[selectedDetails.radius, selectedDetails.radius, selectedDetails.radius]} renderOrder={1000}>
            <sphereGeometry args={[1, 16, 16]} />
            <shaderMaterial
              clipping={true}
              clippingPlanes={clippingPlanes}
              depthTest={true}
              depthWrite={false}
              transparent={true}
              uniforms={selectedVisiblePuckUniforms}
              vertexShader={PUCK_VERTEX_SHADER}
              fragmentShader={PUCK_FRAGMENT_SHADER}
            />
          </mesh>
        </group>
      )}
    </group>
  );
}

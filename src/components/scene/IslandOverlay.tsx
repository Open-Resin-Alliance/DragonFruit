import React, { useMemo, useRef, useCallback } from 'react';
import * as THREE from 'three';
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

// Global sync timer running at module level in a single requestAnimationFrame loop.
// No need to track frames or register useFrame loops in React/R3F components.
const globalTimeUniform = { value: 0 };
if (typeof window !== 'undefined') {
  const updateTime = () => {
    globalTimeUniform.value = performance.now() / 1000;
    requestAnimationFrame(updateTime);
  };
  requestAnimationFrame(updateTime);
}

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

  // Single base unit geometry shared by the instanced mesh (radius 1, height 1)
  const baseGeometry = useMemo(() => {
    const g = new THREE.CylinderGeometry(1, 1, 1, 24);
    g.rotateX(Math.PI / 2); // Rotate to Z-up
    return g;
  }, []);

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
      const height = bbox.max.z - bbox.min.z;

      tempPosition.set(marker.centerX, marker.centerY, marker.baseZ);
      tempScale.set(radius, radius, height);
      tempMatrix.compose(tempPosition, new THREE.Quaternion(), tempScale);

      mesh.setMatrixAt(index, tempMatrix);
    });

    mesh.instanceMatrix.needsUpdate = true;
  }, [instancedMarkers]);

  // Inject custom volumetric glow and laser core shaders into standard material compiling
  const onBeforeCompile = useCallback((shader: THREE.Shader) => {
    shader.uniforms.uTime = globalTimeUniform;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
       varying vec3 vLocalPosition;`
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vLocalPosition = position;`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
       varying vec3 vLocalPosition;
       uniform float uTime;`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `
      // Radial distance from center axis (0.0 to 1.0)
      float r = length(vLocalPosition.xy);
      // Vertical distance from center plane (0.0 to 1.0)
      float h = abs(vLocalPosition.z) * 2.0;

      // Volumetric falloff: smoothly decay to 0 at all boundaries to remove flat puck edges
      float radialFalloff = smoothstep(1.0, 0.0, r);
      float verticalFalloff = smoothstep(1.0, 0.0, h);
      float intensity = radialFalloff * verticalFalloff;

      float softHalo = intensity;
      float laserCore = pow(intensity, 8.0);
      float pulse = 1.0 + 0.15 * sin(uTime * 12.5663706);

      // Blend color with a brilliant white highlight core
      vec3 finalColor = mix(diffuseColor.rgb, vec3(1.0), laserCore * 0.7);
      // Scale alpha: soft halo + sharp laser core, scaled by opacity and 2 Hz pulse
      float finalAlpha = clamp((diffuseColor.a * softHalo + laserCore * 0.4) * pulse, 0.0, 0.95);

      #ifdef OPAQUE
      gl_FragColor = vec4( finalColor, 1.0 );
      #else
      gl_FragColor = vec4( finalColor, finalAlpha );
      #endif
      `
    );
  }, []);

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
          args={[baseGeometry, undefined, instancedMarkers.length]}
        >
          <meshBasicMaterial
            transparent={true}
            color={threeColor}
            opacity={opacity}
            depthTest={true}
            depthWrite={false}
            clippingPlanes={clippingPlanes}
            onBeforeCompile={onBeforeCompile}
          />
        </instancedMesh>
      )}

      {/* 3. Render selected island (if any) twice for occlusion contrast */}
      {selectedMarkers.map((marker) => (
        <group key={marker.id}>
          {/* Occluded state - orange, no depth test, renders behind */}
          <mesh
            geometry={marker.geometry!}
            renderOrder={999}
          >
            <meshBasicMaterial
              transparent={true}
              color={occludedColor}
              opacity={0.95}
              depthTest={false}
              depthWrite={false}
              clippingPlanes={clippingPlanes}
              onBeforeCompile={onBeforeCompile}
            />
          </mesh>

          {/* Visible state - yellow, with depth test, renders on top */}
          <mesh
            geometry={marker.geometry!}
            renderOrder={1000}
          >
            <meshBasicMaterial
              transparent={true}
              color={visibleColor}
              opacity={0.95}
              depthTest={true}
              depthWrite={false}
              clippingPlanes={clippingPlanes}
              onBeforeCompile={onBeforeCompile}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}

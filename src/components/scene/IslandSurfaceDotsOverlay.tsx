import React, { useState, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import { generateDecalGrid } from '@/volumeAnalysis/IslandScan/decalGridHelper';
import type { IslandMarker } from '@/volumeAnalysis/IslandScan/islandOverlayLogic';
import type { ModelTransform } from '@/hooks/useModelTransform';

interface IslandSurfaceDotsOverlayProps {
  geometry: THREE.BufferGeometry;
  islandMarkers: IslandMarker[];
  scanBBox: THREE.Box3 | null;
  selectedIslandId?: number | null;
  clipLower?: number | null;
  clipUpper?: number | null;
  opacity?: number;
  transform?: ModelTransform | null;
  dropOffsetZ?: number;
}

const defaultPosition = new THREE.Vector3(0, 0, 0);
const defaultQuaternion = new THREE.Quaternion(0, 0, 0, 1);
const defaultScale = new THREE.Vector3(1, 1, 1);

export default function IslandSurfaceDotsOverlay({
  geometry,
  islandMarkers,
  scanBBox,
  selectedIslandId,
  clipLower,
  clipUpper,
  opacity = 0.9,
  transform,
  dropOffsetZ = 0,
}: IslandSurfaceDotsOverlayProps) {
  const [gridTexture, setGridTexture] = useState<THREE.DataTexture | null>(null);
  const [markerTexture, setMarkerTexture] = useState<THREE.DataTexture | null>(null);
  const [markerMetaTexture, setMarkerMetaTexture] = useState<THREE.DataTexture | null>(null);
  const [bboxMin, setBboxMin] = useState<THREE.Vector3>(new THREE.Vector3());
  const [bboxMax, setBboxMax] = useState<THREE.Vector3>(new THREE.Vector3());

  const clippingPlanes = useMemo(() => {
    const arr: THREE.Plane[] = [];
    if (clipLower != null) {
      arr.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), -clipLower));
    }
    if (clipUpper != null) {
      arr.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), clipUpper));
    }
    return arr;
  }, [clipLower, clipUpper]);

  // Compute geometry local offset (negation of bounding box center)
  const centerOffset = useMemo(() => {
    if (!geometry) return new THREE.Vector3();
    const bbox = geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
      geometry.getAttribute('position') as THREE.BufferAttribute
    );
    return bbox.getCenter(new THREE.Vector3());
  }, [geometry]);

  const meshLocalOffset = useMemo(
    () => new THREE.Vector3(-centerOffset.x, -centerOffset.y, -centerOffset.z),
    [centerOffset]
  );

  const localBBox = useMemo(() => {
    if (!geometry) return new THREE.Box3();
    return geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
      geometry.getAttribute('position') as THREE.BufferAttribute
    );
  }, [geometry]);

  // Transform world-space marker centers back to geometry local space on the CPU
  const localMarkers = useMemo(() => {
    if (islandMarkers.length === 0) return [];
    const matrix = new THREE.Matrix4();
    if (transform) {
      matrix.compose(
        transform.position,
        quaternionFromGlobalEuler(transform.rotation),
        transform.scale
      );
    } else {
      matrix.identity();
    }
    const invMatrix = matrix.clone().invert();

    return islandMarkers.map(m => {
      const worldCenter = new THREE.Vector3(m.centerX, m.centerY, m.baseZ);
      const localCenter = worldCenter.clone().applyMatrix4(invMatrix).add(centerOffset);
      return {
        ...m,
        centerX: localCenter.x,
        centerY: localCenter.y,
        baseZ: localCenter.z,
      };
    });
  }, [islandMarkers, transform, centerOffset]);

  // Generate 2D decal grid + 1D marker list textures on CPU (completely local space)
  useEffect(() => {
    if (localMarkers.length === 0 || !localBBox) {
      setGridTexture(prev => { if (prev) prev.dispose(); return null; });
      setMarkerTexture(prev => { if (prev) prev.dispose(); return null; });
      setMarkerMetaTexture(prev => { if (prev) prev.dispose(); return null; });
      return;
    }

    const res = generateDecalGrid(localMarkers, localBBox);
    setGridTexture(prev => { if (prev) prev.dispose(); return res.gridTexture; });
    setMarkerTexture(prev => { if (prev) prev.dispose(); return res.markerTexture; });
    setMarkerMetaTexture(prev => { if (prev) prev.dispose(); return res.markerMetaTexture; });
    setBboxMin(res.bboxMin);
    setBboxMax(res.bboxMax);
  }, [localMarkers, localBBox]);

  // Clean up texture resources on unmount
  useEffect(() => {
    return () => {
      setGridTexture(prev => { if (prev) prev.dispose(); return null; });
      setMarkerTexture(prev => { if (prev) prev.dispose(); return null; });
      setMarkerMetaTexture(prev => { if (prev) prev.dispose(); return null; });
    };
  }, []);

  // Custom shader material mapping the decal grid
  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: false,
      clippingPlanes: clippingPlanes || [],
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      toneMapped: false,
      uniforms: {
        uGridTexture: { value: null },
        uMarkerTexture: { value: null },
        uMarkerMetaTexture: { value: null },
        uBBoxMin: { value: new THREE.Vector3() },
        uBBoxMax: { value: new THREE.Vector3() },
        uSelectedIslandId: { value: -1 },
        uOpacity: { value: opacity },
      },
      vertexShader: `
        varying vec3 vLocalPos;
        varying vec3 vWorldNormal;

        void main() {
          vLocalPos = position.xyz;
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        varying vec3 vLocalPos;
        varying vec3 vWorldNormal;

        uniform sampler2D uGridTexture;
        uniform sampler2D uMarkerTexture;
        uniform sampler2D uMarkerMetaTexture;
        uniform vec3 uBBoxMin;
        uniform vec3 uBBoxMax;
        uniform float uSelectedIslandId;
        uniform float uOpacity;

        #include <clipping_planes_pars_fragment>

        void main() {
          #include <clipping_planes_fragment>

          vec3 normal = normalize(vWorldNormal);
          if (normal.z >= -0.1) {
            discard;
          }

          // Convert fragment local X/Y coordinates to normalized grid UV coordinates
          vec2 uv = (vLocalPos.xy - uBBoxMin.xy) / (uBBoxMax.xy - uBBoxMin.xy);

          if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
            discard;
          }

          // Fetch the 4 candidate marker indices stored in this cell
          vec4 cellIndices = texture(uGridTexture, uv);
          
          vec3 finalColor = vec3(0.0);
          float finalAlpha = 0.0;
          bool hit = false;

          // Loop over each of the 4 slots to check for overlapping circles
          for (int c = 0; c < 4; c++) {
            float fIndex = (c == 0) ? cellIndices.r : ((c == 1) ? cellIndices.g : ((c == 2) ? cellIndices.b : cellIndices.a));
            if (fIndex < 0.0) {
              continue;
            }

            int idx = int(floor(fIndex + 0.5));
            
            // Sample the 1D marker textures containing the analytical data of marker idx
            vec4 markerData = texelFetch(uMarkerTexture, ivec2(idx, 0), 0);
            vec4 metaData = texelFetch(uMarkerMetaTexture, ivec2(idx, 0), 0);
            
            vec3 center = markerData.xyz;
            float radius = markerData.a;

            float islandId = metaData.r;
            float type = metaData.g;

            // Compute exact analytical 3D distance in local space
            float dist = distance(vLocalPos, center);

            if (dist < radius) {
              vec3 color = vec3(0.0, 0.33, 1.0); // Voxel blue
              if (type == 1.0) {
                color = vec3(0.0, 1.0, 0.0); // Minima green
              } else if (type == 2.0) {
                color = vec3(1.0, 0.0, 0.0); // Intersection red
              }

              float aa = max(fwidth(dist) * 1.15, 0.001);
              float alpha = 1.0 - smoothstep(radius - aa, radius + aa, dist);

              if (islandId == uSelectedIslandId) {
                color = vec3(1.0, 0.92, 0.016); // Selected yellow (#ffff00)
                alpha = 0.95;
              }

              float blendedAlpha = alpha * uOpacity;
              finalColor = mix(finalColor, color, alpha);
              finalAlpha = max(finalAlpha, blendedAlpha);
              hit = true;
            }
          }

          if (!hit) {
            discard;
          }

          gl_FragColor = vec4(finalColor, finalAlpha);
        }
      `,
    });
  }, [clippingPlanes, opacity]);

  // Sync uniforms to texture/coordinate updates
  useEffect(() => {
    if (!material) return;
    material.uniforms.uGridTexture.value = gridTexture || null;
    material.uniforms.uMarkerTexture.value = markerTexture || null;
    material.uniforms.uMarkerMetaTexture.value = markerMetaTexture || null;
    material.uniforms.uBBoxMin.value.copy(bboxMin);
    material.uniforms.uBBoxMax.value.copy(bboxMax);
    material.uniforms.uSelectedIslandId.value = selectedIslandId ?? -1;
  }, [gridTexture, markerTexture, markerMetaTexture, bboxMin, bboxMax, selectedIslandId, material]);

  // Clean up material resources on unmount
  useEffect(() => {
    return () => {
      material.dispose();
    };
  }, [material]);

  const groupRef = useRef<THREE.Group>(null);

  // Sync group transformation in frame loop to eliminate 1-frame latency/wobbling
  useFrame(() => {
    if (!groupRef.current) return;
    const pos = transform?.position ?? defaultPosition;
    const zOffset = dropOffsetZ ?? 0;
    groupRef.current.position.set(pos.x, pos.y, pos.z + zOffset);
    groupRef.current.quaternion.copy(transform ? quaternionFromGlobalEuler(transform.rotation) : defaultQuaternion);
    groupRef.current.scale.copy(transform?.scale ?? defaultScale);
  });

  return (
    <group ref={groupRef}>
      {gridTexture && markerTexture && markerMetaTexture && (
        <mesh geometry={geometry} position={meshLocalOffset} renderOrder={8} raycast={() => null}>
          <primitive object={material} attach="material" />
        </mesh>
      )}
    </group>
  );
}

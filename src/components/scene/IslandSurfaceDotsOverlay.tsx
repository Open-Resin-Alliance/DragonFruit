import React, { useMemo, useRef, useLayoutEffect, useEffect } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { IslandMarker } from '@/volumeAnalysis/IslandScan/islandOverlayLogic';
import type { ModelTransform } from '@/hooks/useModelTransform';

export interface ExtendedIslandMarker extends IslandMarker {
  radius?: number;
  type?: number;
  islandId?: number;
}

interface IslandSurfaceDotsOverlayProps {
  geometry: THREE.BufferGeometry;
  islandMarkers: ExtendedIslandMarker[];
  scanBBox?: THREE.Box3 | null;
  selectedIslandId?: number | null;
  clipLower?: number | null;
  clipUpper?: number | null;
  opacity?: number;
  transform?: ModelTransform | null;
}

const vertexShader = `
  #include <clipping_planes_pars_vertex>
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  void main() {
    #include <clipping_planes_vertex>
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const fragmentShader = `
  #include <clipping_planes_pars_fragment>
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  uniform sampler2D uMarkerTexture;
  uniform sampler2D uMarkerMetaTexture;
  uniform int uMarkerCount;
  uniform float uSelectedIslandId;
  uniform float uOpacity;
  uniform float uTime;

  out vec4 fragColor;

  // Colors matching original theme
  const vec3 COLOR_VOXEL = vec3(0.0, 0.33, 1.0);       // Voxel blue
  const vec3 COLOR_MINIMA = vec3(0.0, 1.0, 0.0);      // Minima green
  const vec3 COLOR_INTERSECTION = vec3(1.0, 0.0, 0.0); // Intersection red
  const vec3 COLOR_CONSOLIDATED = vec3(0.53, 0.81, 0.98); // Paler blue
  const vec3 COLOR_SELECTED_OCCLUDED = vec3(1.0, 0.4, 0.0); // Orange-red
  const vec3 COLOR_SELECTED_VISIBLE = vec3(1.0, 1.0, 0.0);  // Yellow

  int findStartIndex(float zLimit, int count) {
    int low = 0;
    int high = count - 1;
    int result = 0;
    for (int step = 0; step < 11; step++) {
      if (low > high) break;
      int mid = (low + high) / 2;
      vec4 m = texelFetch(uMarkerTexture, ivec2(mid, 0), 0);
      if (m.z >= zLimit) {
        result = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return result;
  }

  void main() {
    #include <clipping_planes_fragment>

    if (uMarkerCount == 0) discard;

    // Search range: [vWorldPos.z - 5.0, vWorldPos.z + 5.0]
    int startIdx = findStartIndex(vWorldPos.z - 5.0, uMarkerCount);

    bool painted = false;
    vec3 paintColor = vec3(0.0);
    float paintAlpha = 0.0;

    for (int i = 0; i < 1000; i++) {
      int idx = startIdx + i;
      if (idx >= uMarkerCount) break;

      vec4 marker = texelFetch(uMarkerTexture, ivec2(idx, 0), 0);

      // Early break since sorted by Z
      if (marker.z > vWorldPos.z + 5.0) break;

      vec4 meta = texelFetch(uMarkerMetaTexture, ivec2(idx, 0), 0);
      float islandId = meta.r;
      float type = meta.g;

      bool isSelectedMarker = (uSelectedIslandId >= 0.0 && abs(islandId - uSelectedIslandId) < 0.1);

      #ifdef OCCLUDED_PASS_ONLY
      if (!isSelectedMarker) continue;
      #endif

      float radius = marker.w;

      // 1. Pure 3D Spherical Decal Projection (no planar snapping or normal-based guards to avoid smearing/spilling)
      float dist = distance(vWorldPos, marker.xyz);
      float dp = max(fwidth(dist), 0.0001);

      // 2. Decal dot factor with crisp, screen-space anti-aliasing (exactly 1.5 pixels wide transition)
      float factor = 1.0 - smoothstep(radius - dp * 0.75, radius + dp * 0.75, dist);
      if (factor > 0.001) {
        vec3 col = COLOR_VOXEL;
        if (isSelectedMarker) {
          #ifdef OCCLUDED_PASS_ONLY
          col = COLOR_SELECTED_OCCLUDED;
          #else
          float pulse = 0.4 + 0.3 * sin(uTime * 8.0);
          col = mix(COLOR_SELECTED_VISIBLE, vec3(1.0, 1.0, 1.0), pulse * 0.3);
          #endif
        } else {
          if (type == 1.0) col = COLOR_MINIMA;
          else if (type == 2.0) col = COLOR_INTERSECTION;
          else if (type == 3.0) col = COLOR_CONSOLIDATED;
        }

        float alpha = factor * uOpacity;
        if (alpha > paintAlpha) {
          paintAlpha = alpha;
          paintColor = col;
          painted = true;
        }
      }
    }

    if (!painted) discard;
    fragColor = vec4(paintColor, paintAlpha);
  }
`;

export default function IslandSurfaceDotsOverlay({
  geometry,
  islandMarkers,
  selectedIslandId,
  clipLower,
  clipUpper,
  opacity = 0.9,
  transform,
}: IslandSurfaceDotsOverlayProps) {
  
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

  // Keep track of textures and count
  const { markerTexture, markerMetaTexture, markerCount } = useMemo(() => {
    const sorted = [...islandMarkers].sort((a, b) => a.baseZ - b.baseZ);
    const count = sorted.length;

    if (count === 0) {
      const dummy = new Float32Array(4);
      const tex = new THREE.DataTexture(dummy, 1, 1, THREE.RGBAFormat, THREE.FloatType);
      tex.internalFormat = 'RGBA32F';
      tex.needsUpdate = true;

      const meta = new THREE.DataTexture(dummy, 1, 1, THREE.RGBAFormat, THREE.FloatType);
      meta.internalFormat = 'RGBA32F';
      meta.needsUpdate = true;

      return { markerTexture: tex, markerMetaTexture: meta, markerCount: 0 };
    }

    const markerData = new Float32Array(count * 4);
    const markerMetaData = new Float32Array(count * 4);

    for (let i = 0; i < count; i++) {
      const m = sorted[i];
      markerData[i * 4] = m.centerX;
      markerData[i * 4 + 1] = m.centerY;
      markerData[i * 4 + 2] = m.baseZ;
      markerData[i * 4 + 3] = m.radius ?? 0.1;

      const islandId = m.islandId ?? m.id ?? -1;
      const type = m.type ?? 0;
      markerMetaData[i * 4] = islandId;
      markerMetaData[i * 4 + 1] = type;
      markerMetaData[i * 4 + 2] = 0;
      markerMetaData[i * 4 + 3] = 0;
    }

    const tex = new THREE.DataTexture(markerData, count, 1, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.internalFormat = 'RGBA32F';
    tex.needsUpdate = true;

    const meta = new THREE.DataTexture(markerMetaData, count, 1, THREE.RGBAFormat, THREE.FloatType);
    meta.minFilter = THREE.NearestFilter;
    meta.magFilter = THREE.NearestFilter;
    meta.internalFormat = 'RGBA32F';
    meta.needsUpdate = true;

    return { markerTexture: tex, markerMetaTexture: meta, markerCount: count };
  }, [islandMarkers]);

  useEffect(() => {
    return () => {
      markerTexture.dispose();
      markerMetaTexture.dispose();
    };
  }, [markerTexture, markerMetaTexture]);

  const uniforms = useRef({
    uMarkerTexture: { value: markerTexture },
    uMarkerMetaTexture: { value: markerMetaTexture },
    uMarkerCount: { value: markerCount },
    uSelectedIslandId: { value: selectedIslandId ?? -1 },
    uOpacity: { value: opacity },
    uTime: { value: 0 },
  });

  useLayoutEffect(() => {
    uniforms.current.uMarkerTexture.value = markerTexture;
    uniforms.current.uMarkerMetaTexture.value = markerMetaTexture;
    uniforms.current.uMarkerCount.value = markerCount;
    uniforms.current.uSelectedIslandId.value = selectedIslandId ?? -1;
    uniforms.current.uOpacity.value = opacity;
  }, [markerTexture, markerMetaTexture, markerCount, selectedIslandId, opacity]);

  useFrame((state) => {
    uniforms.current.uTime.value = state.clock.getElapsedTime();
  });

  const occludedMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      clipping: true,
      clippingPlanes,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -1.0,
      polygonOffsetUnits: -4.0,
      defines: {
        OCCLUDED_PASS_ONLY: true,
      },
      uniforms: uniforms.current,
      vertexShader,
      fragmentShader,
    });
  }, [clippingPlanes]);

  const visibleMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      clipping: true,
      clippingPlanes,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -1.0,
      polygonOffsetUnits: -4.0,
      uniforms: uniforms.current,
      vertexShader,
      fragmentShader,
    });
  }, [clippingPlanes]);

  useEffect(() => {
    return () => {
      occludedMaterial.dispose();
      visibleMaterial.dispose();
    };
  }, [occludedMaterial, visibleMaterial]);

  if (markerCount === 0) {
    return null;
  }

  const isSelectedActive = selectedIslandId != null && selectedIslandId >= 0;

  return (
    <group position={meshLocalOffset}>
      {/* 1. Occluded Pass (Selected Island only, visible through model geometry in orange-red) */}
      {isSelectedActive && (
        <mesh geometry={geometry} raycast={() => null} renderOrder={999}>
          <primitive object={occludedMaterial} attach="material" />
        </mesh>
      )}

      {/* 2. Visible Pass (All islands, depth-tested and sitting on top of model surface in standard colors) */}
      <mesh geometry={geometry} raycast={() => null} renderOrder={1000}>
        <primitive object={visibleMaterial} attach="material" />
      </mesh>
    </group>
  );
}

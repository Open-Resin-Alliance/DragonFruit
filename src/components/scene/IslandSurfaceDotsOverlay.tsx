import React, { useMemo, useRef, useLayoutEffect, useEffect } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { IslandMarker } from '@/volumeAnalysis/IslandScan/islandOverlayLogic';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { useHoveredIslandId } from '@/volumeAnalysis/Islands/hoverStore';

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
  uniform float uHoveredIslandId;
  uniform float uOpacity;
  uniform float uTime;

  out vec4 fragColor;

  // Colors matching original theme
  const vec3 COLOR_VOXEL = vec3(0.53, 0.81, 0.98);       // Voxel pale blue
  const vec3 COLOR_MINIMA = vec3(0.0, 1.0, 0.0);      // Minima green
  const vec3 COLOR_INTERSECTION = vec3(1.0, 0.0, 0.0); // Intersection red
  const vec3 COLOR_CONSOLIDATED = vec3(0.53, 0.81, 0.98); // Paler blue
  const vec3 COLOR_SELECTED_OCCLUDED = vec3(1.0, 0.4, 0.0); // Orange-red
  const vec3 COLOR_SELECTED_VISIBLE = vec3(1.0, 1.0, 0.0);  // Yellow

  int findStartIndex(float zLimit, int count) {
    int low = 0;
    int high = count - 1;
    int result = 0;
    for (int step = 0; step < 15; step++) {
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

    // Search range: [vWorldPos.z - 3.0, vWorldPos.z + 3.0]
    int startIdx = findStartIndex(vWorldPos.z - 3.0, uMarkerCount);

    struct IslandOccupancy {
      float id;
      float type;
      float val;
    };
    IslandOccupancy localIslands[4];
    int localCount = 0;
    for (int k = 0; k < 4; k++) {
      localIslands[k].id = -1.0;
      localIslands[k].type = 0.0;
      localIslands[k].val = 0.0;
    }

    for (int i = 0; i < 80; i++) {
      int idx = startIdx + i;
      if (idx >= uMarkerCount) break;

      vec4 marker = texelFetch(uMarkerTexture, ivec2(idx, 0), 0);

      // Early break since sorted by Z
      if (marker.z > vWorldPos.z + 3.0) break;

      vec4 meta = texelFetch(uMarkerMetaTexture, ivec2(idx, 0), 0);
      float islandId = meta.r;
      float type = meta.g;

      bool isSelectedMarker = (uSelectedIslandId >= 0.0 && abs(islandId - uSelectedIslandId) < 0.1);

      #ifdef OCCLUDED_PASS_ONLY
      if (!isSelectedMarker) continue;
      #endif

      float radius = marker.w;
      if (type == 3.0 || type == 0.0) {
        radius = radius * 1.4;
      }
      float dist = distance(vWorldPos, marker.xyz);

      // Quadratic falloff calculation
      float ratio = clamp(dist / radius, 0.0, 1.0);
      float intensity = 1.0 - ratio * ratio;
      intensity = intensity * intensity * 1.5;

      if (intensity > 0.001) {
        int foundIdx = -1;
        for (int k = 0; k < 4; k++) {
          if (k >= localCount) break;
          bool sameIsland = (abs(localIslands[k].id - islandId) < 0.1);
          bool compatibleTypes = (localIslands[k].type == type) || 
                                 (localIslands[k].type <= 0.5 && type == 3.0) || 
                                 (localIslands[k].type == 3.0 && type <= 0.5);
          if (sameIsland && compatibleTypes) {
            foundIdx = k;
            break;
          }
        }

        if (foundIdx >= 0) {
          localIslands[foundIdx].val += intensity;
        } else if (localCount < 4) {
          localIslands[localCount].id = islandId;
          localIslands[localCount].type = type;
          localIslands[localCount].val = intensity;
          localCount++;
        }
      }
    }

    bool painted = false;
    vec3 paintColor = vec3(0.0);
    float paintAlpha = 0.0;
    float maxVal = 0.0;
    int maxPriority = -1;

    for (int k = 0; k < 4; k++) {
      if (k >= localCount) break;

      float val = localIslands[k].val;
      if (val <= 0.02) continue;

      float islandId = localIslands[k].id;
      float type = localIslands[k].type;
      bool isSelectedMarker = (uSelectedIslandId >= 0.0 && abs(islandId - uSelectedIslandId) < 0.1);
      bool isHoveredMarker = (uHoveredIslandId >= 0.0 && abs(islandId - uHoveredIslandId) < 0.1);

      int priority = 1;
      if (type == 1.0 || type == 2.0) {
        priority = 2;
      }
      if (isHoveredMarker) {
        priority = 3;
      }
      if (isSelectedMarker) {
        priority = 4;
      }

      bool chooseThis = false;
      if (priority > maxPriority) {
        chooseThis = true;
      } else if (priority == maxPriority) {
        if (val > maxVal) {
          chooseThis = true;
        }
      }

      if (chooseThis) {
        maxPriority = priority;
        maxVal = val;

        vec3 fillCol = COLOR_VOXEL;
        vec3 borderCol = COLOR_VOXEL;

        if (isSelectedMarker) {
          #ifdef OCCLUDED_PASS_ONLY
          fillCol = COLOR_SELECTED_OCCLUDED;
          borderCol = COLOR_SELECTED_OCCLUDED;
          #else
          float pulse = 0.4 + 0.3 * sin(uTime * 8.0);
          fillCol = mix(COLOR_SELECTED_VISIBLE, vec3(1.0, 1.0, 1.0), pulse * 0.3);
          borderCol = COLOR_SELECTED_VISIBLE;
          #endif
        } else if (isHoveredMarker) {
          float pulse = 0.5 + 0.5 * sin(uTime * 12.0);
          borderCol = mix(vec3(0.0, 1.0, 1.0), vec3(1.0, 1.0, 1.0), pulse * 0.4);
          if (type == 1.0) {
            fillCol = COLOR_MINIMA;
          } else if (type == 2.0) {
            fillCol = COLOR_INTERSECTION;
          } else if (type == 3.0) {
            fillCol = COLOR_CONSOLIDATED;
          } else {
            fillCol = COLOR_VOXEL;
          }
        } else {
          if (type == 1.0) {
            fillCol = COLOR_MINIMA;
            borderCol = COLOR_MINIMA;
          } else if (type == 2.0) {
            fillCol = COLOR_INTERSECTION;
            borderCol = COLOR_INTERSECTION;
          } else if (type == 3.0) {
            fillCol = COLOR_CONSOLIDATED;
            borderCol = COLOR_VOXEL;
          } else {
            fillCol = COLOR_VOXEL;
            borderCol = COLOR_VOXEL;
          }
        }

        // Black outline at outer edge of marker for max contrast
        float outlineStrength = smoothstep(0.01, 0.035, val) * (1.0 - smoothstep(0.06, 0.10, val));
        // Inner fill with border color (mid-intensity band for visual depth)
        float borderStrength = smoothstep(0.06, 0.12, val) * (1.0 - smoothstep(0.15, 0.25, val));
        if (isHoveredMarker && !isSelectedMarker) {
          borderStrength = smoothstep(0.04, 0.10, val) * (1.0 - smoothstep(0.20, 0.30, val));
        }
        vec3 outlineMix = mix(fillCol, borderCol, borderStrength);
        paintColor = mix(outlineMix, vec3(0.0, 0.0, 0.0), outlineStrength);
        paintAlpha = smoothstep(0.01, 0.06, val) * uOpacity;
        painted = true;
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
  const hoveredIslandId = useHoveredIslandId();
  
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
    const sorted = [...islandMarkers].sort((a, b) => {
      if (Math.abs(a.baseZ - b.baseZ) > 0.0001) {
        return a.baseZ - b.baseZ;
      }
      const typeA = a.type ?? 0;
      const typeB = b.type ?? 0;
      const isMinimaA = typeA === 1 || typeA === 2;
      const isMinimaB = typeB === 1 || typeB === 2;
      if (isMinimaA && !isMinimaB) return 1;
      if (!isMinimaA && isMinimaB) return -1;
      return 0;
    });
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
    uHoveredIslandId: { value: hoveredIslandId ?? -1 },
    uOpacity: { value: opacity },
    uTime: { value: 0 },
  });

  useLayoutEffect(() => {
    uniforms.current.uMarkerTexture.value = markerTexture;
    uniforms.current.uMarkerMetaTexture.value = markerMetaTexture;
    uniforms.current.uMarkerCount.value = markerCount;
    uniforms.current.uSelectedIslandId.value = selectedIslandId ?? -1;
    uniforms.current.uHoveredIslandId.value = hoveredIslandId ?? -1;
    uniforms.current.uOpacity.value = opacity;
  }, [markerTexture, markerMetaTexture, markerCount, selectedIslandId, hoveredIslandId, opacity]);

  const timerRef = useRef(new THREE.Timer());
  useFrame(() => {
    timerRef.current.update();
    uniforms.current.uTime.value = timerRef.current.getElapsed();
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

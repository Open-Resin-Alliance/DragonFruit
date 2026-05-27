import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { supportPainterStore } from '../supportPainterStore';

/**
 * Computes a unique float ID for every triangle in flat/non-indexed geometry.
 */
function buildTriangleIdAttribute(geometry: THREE.BufferGeometry): THREE.BufferAttribute {
  const positionAttr = geometry.getAttribute('position');
  if (!positionAttr) {
    throw new Error('Position attribute is missing from geometry');
  }
  const vertexCount = positionAttr.count;
  const array = new Float32Array(vertexCount);
  for (let k = 0; k < vertexCount; k++) {
    array[k] = Math.floor(k / 3);
  }
  return new THREE.BufferAttribute(array, 1);
}

/**
 * Renders high-quality color overlays per-triangle using a DataTexture lookup table.
 * Supports committed ROI blending and pulsing hover previews.
 */
export function useRoiHighlightMaterial(
  geometry: THREE.BufferGeometry | null,
  isActive: boolean,
  meshColor: string = '#c8c8ce'
): THREE.ShaderMaterial | null {
  const timeRef = useRef<number>(0);
  const textureRef = useRef<THREE.DataTexture | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);

  // Parse mesh base color
  const baseColor = useMemo(() => {
    return new THREE.Color(meshColor);
  }, [meshColor]);

  // Compute total triangle count
  const totalTriangleCount = useMemo(() => {
    if (!geometry) return 0;
    const pos = geometry.getAttribute('position');
    return pos ? Math.floor(pos.count / 3) : 0;
  }, [geometry]);

  // Setup Geometry Attribute for Triangle IDs
  useEffect(() => {
    if (!geometry || totalTriangleCount === 0) return;
    if (!geometry.getAttribute('aTriangleId')) {
      try {
        const attr = buildTriangleIdAttribute(geometry);
        geometry.setAttribute('aTriangleId', attr);
      } catch (err) {
        console.error('[ROIHighlight] failed to build aTriangleId attribute', err);
      }
    }
  }, [geometry, totalTriangleCount]);

  // Setup DataTexture and ShaderMaterial
  const material = useMemo(() => {
    if (!geometry || totalTriangleCount === 0 || !isActive) return null;

    // 1. Create a 1D DataTexture: Width = totalTriangleCount, Height = 1
    const size = totalTriangleCount * 4; // RGBA
    const data = new Uint8Array(size);
    const texture = new THREE.DataTexture(
      data,
      totalTriangleCount,
      1,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    textureRef.current = texture;

    // 2. Define Custom Shader Material with basic Diffuse shading for beautiful premium visuals
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uRoiMap: { value: texture },
        uRoiMapWidth: { value: totalTriangleCount },
        uTime: { value: 0 },
        uBaseColor: { value: baseColor },
      },
      vertexShader: `
        attribute float aTriangleId;
        varying float vTriangleId;
        varying vec3 vNormal;

        void main() {
          vTriangleId = aTriangleId;
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uRoiMap;
        uniform float uRoiMapWidth;
        uniform float uTime;
        uniform vec3 uBaseColor;

        varying float vTriangleId;
        varying vec3 vNormal;

        void main() {
          // Half-texel offset for accurate nearest sampling
          float u = (vTriangleId + 0.5) / uRoiMapWidth;
          vec4 roi = texture2D(uRoiMap, vec2(u, 0.5));

          vec3 finalColor = uBaseColor;
          float blendFactor = 0.0;

          if (roi.a > 0.01) {
            if (roi.a < 0.6) {
              // Proposed preview (flashing/pulsing hover)
              float pulse = 0.5 + 0.5 * sin(uTime * 8.0);
              finalColor = roi.rgb;
              blendFactor = pulse * 0.75;
            } else {
              // Committed ROI color
              finalColor = roi.rgb;
              blendFactor = 0.70;
            }
          }

          // Blend ROI color with base mesh color
          vec3 blendedColor = mix(uBaseColor, finalColor, blendFactor);

          // Harmonic Diffuse Lambertian Lighting
          vec3 lightDir = normalize(vec3(0.5, 0.75, 1.0));
          float diffuse = max(0.28, dot(normalize(vNormal), lightDir));
          vec3 litColor = blendedColor * diffuse;

          // Add a subtle rim light/ambient glow to the selection
          if (blendFactor > 0.01) {
            float rim = 1.0 - max(0.0, dot(normalize(vNormal), vec3(0.0, 0.0, 1.0)));
            litColor += finalColor * pow(rim, 4.0) * blendFactor * 0.25;
          }

          gl_FragColor = vec4(litColor, 1.0);
        }
      `,
      side: THREE.FrontSide,
      depthWrite: true,
      clipping: true,
    });

    materialRef.current = mat;
    return mat;
  }, [geometry, totalTriangleCount, isActive, baseColor]);

  // Sync state changes with the DataTexture
  useEffect(() => {
    const texture = textureRef.current;
    if (!texture || totalTriangleCount === 0 || !isActive) return;

    const handleUpdate = () => {
      const snap = supportPainterStore.getSnapshot();
      const data = texture.image.data;
      if (!data) return;

      // Reset to transparent [0,0,0,0]
      data.fill(0);

      // Write committed regions & hover previews into texture data
      for (const [triId, [r, g, b, a]] of snap.triangleColorMap.entries()) {
        if (triId >= 0 && triId < totalTriangleCount) {
          const offset = triId * 4;
          data[offset] = r;
          data[offset + 1] = g;
          data[offset + 2] = b;
          data[offset + 3] = a;
        }
      }

      texture.needsUpdate = true;
    };

    // Initialize with current state
    handleUpdate();

    // Subscribe to store updates
    const unsubscribe = supportPainterStore.subscribe(handleUpdate);
    return () => {
      unsubscribe();
    };
  }, [totalTriangleCount, isActive, material]);

  // Drive the pulse animations in useFrame
  useFrame((state) => {
    timeRef.current = state.clock.getElapsedTime();
    if (materialRef.current) {
      materialRef.current.uniforms.uTime.value = timeRef.current;
    }
  });

  // Clean up WebGL resources
  useEffect(() => {
    return () => {
      if (textureRef.current) {
        textureRef.current.dispose();
        textureRef.current = null;
      }
      if (materialRef.current) {
        materialRef.current.dispose();
        materialRef.current = null;
      }
    };
  }, []);

  return material;
}

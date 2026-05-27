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
  meshColor: string = '#c8c8ce',
  clippingPlanes: THREE.Plane[] = []
): { material: THREE.ShaderMaterial | null; geometry: THREE.BufferGeometry | null } {
  const timeRef = useRef<number>(0);
  const textureRef = useRef<THREE.DataTexture | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);

  // Parse mesh base color
  const baseColor = useMemo(() => {
    return new THREE.Color(meshColor || '#c8c8ce');
  }, [meshColor]);

  // Compute non-indexed rendering geometry copy if original is indexed
  const renderingGeometry = useMemo(() => {
    if (!geometry || !isActive) return geometry;

    console.log('[ROIHighlight] Creating dedicated rendering geometry copy for paint highlighting');
    let geom: THREE.BufferGeometry;
    try {
      if (geometry.index) {
        geom = geometry.toNonIndexed();
      } else {
        geom = geometry.clone();
      }

      // SYNCHRONOUS INITIALIZATION: Attach attribute BEFORE geometry is ever rendered
      const attr = buildTriangleIdAttribute(geom);
      geom.setAttribute('aTriangleId', attr);

      // Compute BVH bounds tree for collision detection & raycasting support
      (geom as any).computeBoundsTree?.();

      console.log('[ROIHighlight] Synchronously built attribute and computed BVH boundsTree');
    } catch (err) {
      console.error('[ROIHighlight] Failed to initialize rendering geometry copy', err);
      geom = geometry;
    }
    return geom;
  }, [geometry, isActive]);

  // Clean up non-indexed copy on change or unmount
  useEffect(() => {
    return () => {
      if (renderingGeometry && renderingGeometry !== geometry) {
        renderingGeometry.dispose();
      }
    };
  }, [renderingGeometry, geometry]);

  // Compute total triangle count
  const totalTriangleCount = useMemo(() => {
    if (!renderingGeometry) return 0;
    const pos = renderingGeometry.getAttribute('position');
    return pos ? Math.floor(pos.count / 3) : 0;
  }, [renderingGeometry]);

  // Setup DataTexture and ShaderMaterial
  const material = useMemo(() => {
    if (!renderingGeometry || totalTriangleCount === 0 || !isActive) return null;

    // 1. Create a 2D DataTexture to avoid GPU WebGL MAX_TEXTURE_SIZE limitations on large models
    const texWidth = 2048;
    const texHeight = Math.ceil(totalTriangleCount / texWidth);
    const size = texWidth * texHeight * 4; // RGBA
    const data = new Uint8Array(size);
    const texture = new THREE.DataTexture(
      data,
      texWidth,
      texHeight,
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
      precision: 'highp', // Enforce highp for high-density mesh indexing
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      uniforms: {
        uRoiMap: { value: texture },
        uRoiMapWidth: { value: texWidth },
        uRoiMapHeight: { value: texHeight },
        uTime: { value: 0 },
        uBaseColor: { value: baseColor },
      },
      vertexShader: `
        #include <clipping_planes_pars_vertex>
        attribute float aTriangleId;
        varying float vTriangleId;
        varying vec3 vNormal;

        void main() {
          // Microscopic dilation along normal (0.05mm) to pull the overlay in front
          vec3 dilatedPosition = position + normal * 0.05;
          vec4 mvPosition = modelViewMatrix * vec4(dilatedPosition, 1.0);
          #include <clipping_planes_vertex>
          vTriangleId = aTriangleId;
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        #include <clipping_planes_pars_fragment>
        uniform sampler2D uRoiMap;
        uniform float uRoiMapWidth;
        uniform float uRoiMapHeight;
        uniform float uTime;
        uniform vec3 uBaseColor;

        varying float vTriangleId;
        varying vec3 vNormal;

        void main() {
          #include <clipping_planes_fragment>
          // Round interpolated float ID to nearest integer to avoid rasterizer rounding errors
          float triId = floor(vTriangleId + 0.5);
          // Calculate 2D coordinates for the triangle ID with half-texel offset for accurate nearest sampling
          float x = mod(triId, uRoiMapWidth) + 0.5;
          float y = floor(triId / uRoiMapWidth) + 0.5;
          vec2 uv = vec2(x / uRoiMapWidth, y / uRoiMapHeight);
          vec4 roi = texture2D(uRoiMap, uv);

          if (roi.a <= 0.01) {
            discard;
          }

          vec3 finalColor = roi.rgb;
          float blendFactor = 0.0;

          if (roi.a < 0.6) {
            // Proposed preview (flashing/pulsing hover with 0.35 opacity floor)
            float pulse = 0.35 + 0.5 * sin(uTime * 8.0);
            blendFactor = pulse * 0.85;
          } else {
            // Committed ROI color
            blendFactor = 0.75;
          }

          vec3 normalVec = vNormal;
          if (length(normalVec) < 0.001) {
            normalVec = vec3(0.0, 0.0, 1.0);
          }
          vec3 normalizedNormal = normalize(normalVec);

          // Harmonic Diffuse Lambertian Lighting
          vec3 lightDir = normalize(vec3(0.5, 0.75, 1.0));
          float diffuse = max(0.28, dot(normalizedNormal, lightDir));
          vec3 litColor = finalColor * diffuse;

          // Boost self-emissive glow for high contrast
          litColor += finalColor * 0.35 * blendFactor;

          // Add a subtle rim light/ambient glow to the selection
          float rim = 1.0 - max(0.0, dot(normalizedNormal, vec3(0.0, 0.0, 1.0)));
          litColor += finalColor * pow(rim, 4.0) * blendFactor * 0.35;

          gl_FragColor = vec4(litColor, blendFactor);
        }
      `,
      side: THREE.FrontSide,
      clipping: true,
    });

    materialRef.current = mat;
    return mat;
  }, [renderingGeometry, totalTriangleCount, isActive, baseColor]);

  // Sync clipping planes dynamically
  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.clippingPlanes = clippingPlanes;
    }
  }, [clippingPlanes]);

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

  return { material, geometry: renderingGeometry };
}

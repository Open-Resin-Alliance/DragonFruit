import * as THREE from 'three';
import React from 'react';
import { blendTintColor, clampTintStrength } from './tint';


export function SoftClayMaterial({
  isSelected,
  isHovered,
  useVertexColors,
  meshColor,
  hoverTintColor,
  selectedTintColor,
  hoverTintStrength,
  selectedTintStrength,
  materialRoughness,
  clippingPlanes,
  bakedAoStrength = 0,
}: {
  isSelected: boolean;
  isHovered: boolean;
  useVertexColors?: boolean;
  meshColor?: string;
  hoverTintColor?: string;
  selectedTintColor?: string;
  hoverTintStrength?: number;
  selectedTintStrength?: number;
  materialRoughness?: number;
  clippingPlanes: THREE.Plane[];
  /** How much of the geometry's baked per-vertex occlusion (`aBakedAo`) to
   *  apply. 0 when the geometry carries none, which is also what a geometry
   *  without the attribute reads: the shader declares it unconditionally and
   *  gates it through this uniform, so unbaked meshes are untouched rather than
   *  needing a branch. */
  bakedAoStrength?: number;
}) {
  const baseColor = meshColor ?? '#a3a3a3';
  const selectedStrength = clampTintStrength(selectedTintStrength, 0.70);
  const hoverStrength = clampTintStrength(hoverTintStrength, 0.5);
  const tintColor = isSelected
    ? blendTintColor(baseColor, selectedTintColor, selectedStrength)
    : isHovered
      ? blendTintColor(baseColor, hoverTintColor, hoverStrength)
      : baseColor;

  // `onBeforeCompile` runs once, when the program is compiled — which is before
  // an asynchronous bake can have landed. The uniforms therefore have to be kept
  // live through a ref, or a model compiles against the fallback volume and
  // never picks up its own occlusion.
  const uniformsRef = React.useRef<Record<string, { value: unknown }> | null>(null);
  React.useEffect(() => {
    const uniforms = uniformsRef.current;
    if (!uniforms) return;
    uniforms.uBakedAoStrength.value = bakedAoStrength;
  }, [bakedAoStrength]);

  const AO_STRENGTH = 0.2;
  const FAKE_LIGHT_DIRECTION = new THREE.Vector3(0.35, 0.58, 0.74).normalize();

  return (
    <meshStandardMaterial
      vertexColors={useVertexColors ?? true}
      color={tintColor}
      emissive="#000000"
      emissiveIntensity={0}
      metalness={0.02}
      roughness={materialRoughness ?? 0.9}
      envMapIntensity={0.34}
      clippingPlanes={clippingPlanes}
      side={THREE.FrontSide}
      flatShading={false}
      onBeforeCompile={(shader) => {
        shader.uniforms.uFakeAoStrength = { value: AO_STRENGTH };
        shader.uniforms.uFakeLightDir = { value: FAKE_LIGHT_DIRECTION.clone() };
        shader.uniforms.uBakedAoStrength = { value: bakedAoStrength };
        uniformsRef.current = shader.uniforms as Record<string, { value: unknown }>;

        shader.vertexShader = `
          attribute float aBakedAo;
          varying float vBakedAo;
        ` + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          `
            #include <begin_vertex>
            vBakedAo = aBakedAo;
          `,
        );

        shader.fragmentShader = `
          uniform float uFakeAoStrength;
          uniform vec3 uFakeLightDir;
          uniform float uBakedAoStrength;
          varying float vBakedAo;
        ` + shader.fragmentShader;

        // `opaque_fragment` is the current name of the final color chunk; the
        // `output_fragment` the fake-AO block below was written against was
        // renamed in three r152, so that replace() has been a no-op ever since.
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          `
            #include <opaque_fragment>
            vec3 n = normalize(normal);
            float nDotL = max(dot(n, normalize(uFakeLightDir)), 0.0);
            float cavity = pow(1.0 - nDotL, 1.35);
            float fakeAo = 1.0 - (cavity * uFakeAoStrength);
            gl_FragColor.rgb *= fakeAo;
            // Ambient occlusion baked per vertex on the native side. Multiplied
            // after the cavity term so the two do not fight: the bake carries
            // the occlusion a viewer reads as shape, the cavity term the
            // per-fragment detail beyond the mesh's own resolution.
            gl_FragColor.rgb *= mix(1.0, clamp(vBakedAo, 0.0, 1.0), uBakedAoStrength);
          `,
        );
      }}
    />
  );
}

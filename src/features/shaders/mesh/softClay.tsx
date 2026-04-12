import * as THREE from 'three';
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
}) {
  const baseColor = meshColor ?? '#a3a3a3';
  const selectedStrength = clampTintStrength(selectedTintStrength, 0.75);
  const hoverStrength = clampTintStrength(hoverTintStrength, 0.5);
  const tintColor = isSelected
    ? blendTintColor(baseColor, selectedTintColor, selectedStrength)
    : isHovered
      ? blendTintColor(baseColor, hoverTintColor, hoverStrength)
      : baseColor;

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

        shader.fragmentShader = `
          uniform float uFakeAoStrength;
          uniform vec3 uFakeLightDir;
        ` + shader.fragmentShader;

        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <output_fragment>',
          `
            #include <output_fragment>
            vec3 n = normalize(normal);
            float nDotL = max(dot(n, normalize(uFakeLightDir)), 0.0);
            float cavity = pow(1.0 - nDotL, 1.35);
            float fakeAo = 1.0 - (cavity * uFakeAoStrength);
            gl_FragColor.rgb *= fakeAo;
          `,
        );
      }}
    />
  );
}

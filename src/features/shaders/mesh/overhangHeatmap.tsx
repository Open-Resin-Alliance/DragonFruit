import React from 'react';
import * as THREE from 'three';
import { blendTintColor, clampTintStrength } from './tint';

export function OverhangHeatmapMaterial({
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
    heatmapMinAngle = 0,
    heatmapMaxAngle = 45,
    heatmapColors,
}: {
    isSelected?: boolean;
    isHovered?: boolean;
    useVertexColors?: boolean;
    meshColor?: string;
    hoverTintColor?: string;
    selectedTintColor?: string;
    hoverTintStrength?: number;
    selectedTintStrength?: number;
    materialRoughness?: number;
    clippingPlanes: THREE.Plane[];
    heatmapMinAngle?: number;
    heatmapMaxAngle?: number;
    heatmapColors?: string[];
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

    const uniformsRef = React.useRef({
        uMinAngle: { value: heatmapMinAngle },
        uMaxAngle: { value: heatmapMaxAngle },
        uHeatmapColors: { value: (heatmapColors ?? []).map((c) => new THREE.Color(c)) },
        uFakeAoStrength: { value: AO_STRENGTH },
        uFakeLightDir: { value: FAKE_LIGHT_DIRECTION.clone() },
    });

    React.useEffect(() => {
        uniformsRef.current.uMinAngle.value = heatmapMinAngle;
        uniformsRef.current.uMaxAngle.value = heatmapMaxAngle;
        if (heatmapColors && heatmapColors.length >= 5) {
            uniformsRef.current.uHeatmapColors.value = heatmapColors.map((c) => new THREE.Color(c));
        }
    }, [heatmapMinAngle, heatmapMaxAngle, heatmapColors]);

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
                shader.uniforms.uFakeAoStrength = uniformsRef.current.uFakeAoStrength;
                shader.uniforms.uFakeLightDir = uniformsRef.current.uFakeLightDir;
                shader.uniforms.uMinAngle = uniformsRef.current.uMinAngle;
                shader.uniforms.uMaxAngle = uniformsRef.current.uMaxAngle;
                shader.uniforms.uHeatmapColors = uniformsRef.current.uHeatmapColors;

                shader.vertexShader = `
          varying vec3 vWorldNormalCustom;
        ` + shader.vertexShader;

                shader.vertexShader = shader.vertexShader.replace(
                    '#include <worldpos_vertex>',
                    `
            #include <worldpos_vertex>
            vWorldNormalCustom = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);
          `
                );

                shader.fragmentShader = `
          uniform float uFakeAoStrength;
          uniform vec3 uFakeLightDir;
          uniform float uMinAngle;
          uniform float uMaxAngle;
          uniform vec3 uHeatmapColors[5];
          varying vec3 vWorldNormalCustom;
        ` + shader.fragmentShader;

                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <color_fragment>',
                    `
            #include <color_fragment>

            // Surface inclination from horizontal, 0° = flat underside (most overhang),
            // 90° = vertical wall (no overhang). Surfaces facing up (nz > 0) clamp to
            // 90° and therefore land in the safe/grey band.
            float overhangDeg = degrees(acos(clamp(-vWorldNormalCustom.z, 0.0, 1.0)));
            float t = clamp((overhangDeg - uMinAngle) / max(uMaxAngle - uMinAngle, 0.001), 0.0, 1.0);

            // Custom heatmap colors
            vec3 red = uHeatmapColors[0];
            vec3 orange = uHeatmapColors[1];
            vec3 yellow = uHeatmapColors[2];
            vec3 green = uHeatmapColors[3];
            vec3 grey = uHeatmapColors[4];

            // Red at the shallowest end (t = 0, at/below the min angle), fading to grey
            // at the max angle and beyond (vertical walls, flat tops).
            vec3 heatColor;
            if (t < 0.25) {
              heatColor = mix(red, orange, t / 0.25);
            } else if (t < 0.5) {
              heatColor = mix(orange, yellow, (t - 0.25) / 0.25);
            } else if (t < 0.75) {
              heatColor = mix(yellow, green, (t - 0.5) / 0.25);
            } else {
              heatColor = mix(green, grey, (t - 0.75) / 0.25);
            }

            // Fixed blend keeps the "clay" feel. The old uHeatmapBlend uniform was never
            // forwarded by the live scene and always fell back to 0.85, so it is folded
            // into a constant here.
            diffuseColor.rgb = mix(diffuseColor.rgb, heatColor, 0.85);
          `
                );

                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <output_fragment>',
                    `
            #include <output_fragment>
            vec3 n = normalize(normal);
            float nDotL = max(dot(n, normalize(uFakeLightDir)), 0.0);
            float cavity = pow(1.0 - nDotL, 1.35);
            float fakeAo = 1.0 - (cavity * uFakeAoStrength);
            gl_FragColor.rgb *= fakeAo;
          `
                );
            }}
        />
    );
}

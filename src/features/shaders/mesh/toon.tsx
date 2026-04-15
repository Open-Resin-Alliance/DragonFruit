import React from 'react';
import * as THREE from 'three';
import { blendTintColor, clampTintStrength } from './tint';

function clampInt(input: unknown, min: number, max: number, fallback: number): number {
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function buildGradientMap(steps: number): THREE.DataTexture {
  const s = clampInt(steps, 2, 16, 5);

  const data = new Uint8Array(s * 4);
  for (let i = 0; i < s; i++) {
    const v = Math.round((i / (s - 1)) * 255);
    data[i * 4 + 0] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }

  const texture = new THREE.DataTexture(data, s, 1, THREE.RGBAFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export function ToonMaterial({
  isSelected,
  isHovered,
  useVertexColors,
  meshColor,
  hoverTintColor,
  selectedTintColor,
  hoverTintStrength,
  selectedTintStrength,
  toonSteps,
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
  toonSteps?: number;
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

  const gradientMap = React.useMemo(() => buildGradientMap(toonSteps ?? 5), [toonSteps]);

  React.useEffect(() => {
    return () => {
      gradientMap.dispose();
    };
  }, [gradientMap]);

  return (
    <meshToonMaterial
      vertexColors={useVertexColors ?? true}
      color={tintColor}
      gradientMap={gradientMap}
      emissive="#000000"
      emissiveIntensity={0}
      clippingPlanes={clippingPlanes}
      side={THREE.FrontSide}
    />
  );
}

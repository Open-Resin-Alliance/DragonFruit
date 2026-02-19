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
  hoverTintColor,
  hoverTintStrength,
  selectedTintStrength,
  toonSteps,
  clippingPlanes,
}: {
  isSelected: boolean;
  isHovered: boolean;
  hoverTintColor?: string;
  hoverTintStrength?: number;
  selectedTintStrength?: number;
  toonSteps?: number;
  clippingPlanes: THREE.Plane[];
}) {
  const selectedStrength = clampTintStrength(selectedTintStrength, 0.75);
  const hoverStrength = clampTintStrength(hoverTintStrength, 0.5);
  const tintColor = isSelected
    ? blendTintColor('#ffffff', hoverTintColor, selectedStrength)
    : isHovered
      ? blendTintColor('#ffffff', hoverTintColor, hoverStrength)
      : '#ffffff';

  const gradientMap = React.useMemo(() => buildGradientMap(toonSteps ?? 5), [toonSteps]);

  React.useEffect(() => {
    return () => {
      gradientMap.dispose();
    };
  }, [gradientMap]);

  return (
    <meshToonMaterial
      vertexColors
      color={tintColor}
      gradientMap={gradientMap}
      emissive="#000000"
      emissiveIntensity={0}
      clippingPlanes={clippingPlanes}
      clipIntersection
      side={THREE.DoubleSide}
    />
  );
}

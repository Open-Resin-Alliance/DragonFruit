import React from 'react';
import * as THREE from 'three';
import type { MatcapVariant } from './types';
import { blendTintColor, clampTintStrength } from './tint';

function createMatcapTexture(variant: MatcapVariant): THREE.Texture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);

  const baseByVariant: Record<MatcapVariant, number> = {
    neutral: 200,
    cool: 185,
    warm: 195,
  };

  const tintByVariant: Record<MatcapVariant, [number, number, number]> = {
    neutral: [1, 1, 1],
    cool: [0.90, 0.97, 1.10],
    warm: [1.10, 0.98, 0.88],
  };

  const base = baseByVariant[variant];
  const [tr, tg, tb] = tintByVariant[variant];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x / (size - 1)) * 2 - 1;
      const ny = (y / (size - 1)) * 2 - 1;
      const r = Math.sqrt(nx * nx + ny * ny);

      const t = Math.max(0, 1 - r);
      const shade = base + Math.round(55 * t);

      const rr = Math.min(255, Math.max(0, Math.round(shade * tr)));
      const gg = Math.min(255, Math.max(0, Math.round(shade * tg)));
      const bb = Math.min(255, Math.max(0, Math.round(shade * tb)));

      const idx = (y * size + x) * 4;
      data[idx + 0] = rr;
      data[idx + 1] = gg;
      data[idx + 2] = bb;
      data[idx + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  return tex;
}

export function MatcapMaterial({
  isSelected,
  isHovered,
  useVertexColors,
  meshColor,
  hoverTintColor,
  hoverTintStrength,
  selectedTintStrength,
  variant,
  clippingPlanes,
}: {
  isSelected: boolean;
  isHovered: boolean;
  useVertexColors?: boolean;
  meshColor?: string;
  hoverTintColor?: string;
  hoverTintStrength?: number;
  selectedTintStrength?: number;
  variant?: MatcapVariant;
  clippingPlanes: THREE.Plane[];
}) {
  const matcap = React.useMemo(() => createMatcapTexture(variant ?? 'neutral'), [variant]);

  React.useEffect(() => {
    return () => {
      matcap.dispose();
    };
  }, [matcap]);

  const baseColor = useVertexColors ? '#ffffff' : (meshColor ?? '#a3a3a3');
  const selectedStrength = clampTintStrength(selectedTintStrength, 0.75);
  const hoverStrength = clampTintStrength(hoverTintStrength, 0.5);
  const tintColor = isSelected
    ? blendTintColor(baseColor, hoverTintColor, selectedStrength)
    : isHovered
      ? blendTintColor(baseColor, hoverTintColor, hoverStrength)
      : baseColor;

  return (
    <meshMatcapMaterial
      vertexColors={useVertexColors ?? true}
      color={tintColor}
      matcap={matcap}
      clippingPlanes={clippingPlanes}
      clipIntersection
      side={THREE.FrontSide}
    />
  );
}

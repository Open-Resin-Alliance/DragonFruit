import * as THREE from 'three';
import { blendTintColor, clampTintStrength } from './tint';

export function FlatUnlitMaterial({
  isSelected,
  isHovered,
  hoverTintColor,
  selectedTintColor,
  hoverTintStrength,
  selectedTintStrength,
  useVertexColors,
  meshColor,
  clippingPlanes,
}: {
  isSelected: boolean;
  isHovered: boolean;
  hoverTintColor?: string;
  selectedTintColor?: string;
  hoverTintStrength?: number;
  selectedTintStrength?: number;
  useVertexColors?: boolean;
  meshColor?: string;
  clippingPlanes: THREE.Plane[];
}) {
  const baseFlatColor = meshColor ?? '#a3a3a3';
  const selectedStrength = clampTintStrength(selectedTintStrength, 0.75);
  const hoverStrength = clampTintStrength(hoverTintStrength, 0.5);
  const tintColor = isSelected
    ? blendTintColor(baseFlatColor, selectedTintColor, selectedStrength)
    : isHovered
      ? blendTintColor(baseFlatColor, hoverTintColor, hoverStrength)
      : baseFlatColor;
  const flatColor = isSelected
    ? blendTintColor(baseFlatColor, selectedTintColor, selectedStrength)
    : isHovered
      ? blendTintColor(baseFlatColor, hoverTintColor, hoverStrength)
      : baseFlatColor;

  return (
    <meshBasicMaterial
      vertexColors={useVertexColors ?? true}
      color={useVertexColors ?? true ? tintColor : flatColor}
      clippingPlanes={clippingPlanes}
      side={THREE.FrontSide}
    />
  );
}

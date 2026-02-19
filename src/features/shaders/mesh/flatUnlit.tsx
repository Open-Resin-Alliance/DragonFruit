import * as THREE from 'three';
import { blendTintColor, clampTintStrength } from './tint';

export function FlatUnlitMaterial({
  isSelected,
  isHovered,
  hoverTintColor,
  hoverTintStrength,
  selectedTintStrength,
  useVertexColors,
  meshColor,
  clippingPlanes,
}: {
  isSelected: boolean;
  isHovered: boolean;
  hoverTintColor?: string;
  hoverTintStrength?: number;
  selectedTintStrength?: number;
  useVertexColors?: boolean;
  meshColor?: string;
  clippingPlanes: THREE.Plane[];
}) {
  const baseFlatColor = meshColor ?? '#ffffff';
  const selectedStrength = clampTintStrength(selectedTintStrength, 0.75);
  const hoverStrength = clampTintStrength(hoverTintStrength, 0.5);
  const tintColor = isSelected
    ? blendTintColor('#ffffff', hoverTintColor, selectedStrength)
    : isHovered
      ? blendTintColor('#ffffff', hoverTintColor, hoverStrength)
      : '#ffffff';
  const flatColor = isSelected
    ? blendTintColor(baseFlatColor, hoverTintColor, selectedStrength)
    : isHovered
      ? blendTintColor(baseFlatColor, hoverTintColor, hoverStrength)
      : baseFlatColor;

  return (
    <meshBasicMaterial
      vertexColors={useVertexColors ?? true}
      color={useVertexColors ?? true ? tintColor : flatColor}
      clippingPlanes={clippingPlanes}
      clipIntersection
      side={THREE.DoubleSide}
    />
  );
}

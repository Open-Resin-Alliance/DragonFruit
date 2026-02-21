import * as THREE from 'three';
import { blendTintColor, clampTintStrength } from './tint';

export function WireframeMaterial({
  isSelected,
  isHovered,
  hoverTintColor,
  hoverTintStrength,
  selectedTintStrength,
  clippingPlanes,
}: {
  isSelected: boolean;
  isHovered: boolean;
  hoverTintColor?: string;
  hoverTintStrength?: number;
  selectedTintStrength?: number;
  clippingPlanes: THREE.Plane[];
}) {
  const selectedStrength = clampTintStrength(selectedTintStrength, 0.75);
  const hoverStrength = clampTintStrength(hoverTintStrength, 0.5);
  const wireColor = isSelected
    ? blendTintColor('#d0d0d0', hoverTintColor, selectedStrength)
    : isHovered
      ? blendTintColor('#d0d0d0', hoverTintColor, hoverStrength)
      : '#d0d0d0';

  return (
    <meshBasicMaterial
      color={wireColor}
      clippingPlanes={clippingPlanes}
      clipIntersection
      side={THREE.FrontSide}
      wireframe
      polygonOffset
      polygonOffsetFactor={-1}
      polygonOffsetUnits={-1}
      transparent
      opacity={0.85}
    />
  );
}

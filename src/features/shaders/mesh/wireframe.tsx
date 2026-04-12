import * as THREE from 'three';
import { blendTintColor, clampTintStrength } from './tint';

export function WireframeMaterial({
  isSelected,
  isHovered,
  meshColor,
  hoverTintColor,
  selectedTintColor,
  hoverTintStrength,
  selectedTintStrength,
  clippingPlanes,
}: {
  isSelected: boolean;
  isHovered: boolean;
  meshColor?: string;
  hoverTintColor?: string;
  selectedTintColor?: string;
  hoverTintStrength?: number;
  selectedTintStrength?: number;
  clippingPlanes: THREE.Plane[];
}) {
  const baseWireColor = meshColor ?? '#a3a3a3';
  const selectedStrength = clampTintStrength(selectedTintStrength, 0.75);
  const hoverStrength = clampTintStrength(hoverTintStrength, 0.5);
  const wireColor = isSelected
    ? blendTintColor(baseWireColor, selectedTintColor, selectedStrength)
    : isHovered
      ? blendTintColor(baseWireColor, hoverTintColor, hoverStrength)
      : baseWireColor;

  return (
    <meshBasicMaterial
      color={wireColor}
      clippingPlanes={clippingPlanes}
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

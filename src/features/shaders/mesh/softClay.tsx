import * as THREE from 'three';
import { blendTintColor, clampTintStrength } from './tint';

export function SoftClayMaterial({
  isSelected,
  isHovered,
  hoverTintColor,
  hoverTintStrength,
  selectedTintStrength,
  materialRoughness,
  clippingPlanes,
}: {
  isSelected: boolean;
  isHovered: boolean;
  hoverTintColor?: string;
  hoverTintStrength?: number;
  selectedTintStrength?: number;
  materialRoughness?: number;
  clippingPlanes: THREE.Plane[];
}) {
  const selectedStrength = clampTintStrength(selectedTintStrength, 0.75);
  const hoverStrength = clampTintStrength(hoverTintStrength, 0.5);
  const tintColor = isSelected
    ? blendTintColor('#ffffff', hoverTintColor, selectedStrength)
    : isHovered
      ? blendTintColor('#ffffff', hoverTintColor, hoverStrength)
      : '#ffffff';

  return (
    <meshStandardMaterial
      vertexColors
      color={tintColor}
      emissive="#000000"
      emissiveIntensity={0}
      metalness={0.0}
      roughness={materialRoughness ?? 1.0}
      clippingPlanes={clippingPlanes}
      clipIntersection
      side={THREE.DoubleSide}
      flatShading={false}
    />
  );
}

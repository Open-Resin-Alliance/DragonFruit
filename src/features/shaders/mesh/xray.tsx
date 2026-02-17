import * as THREE from 'three';

export function XrayMaterial({
  isSelected,
  materialRoughness,
  clippingPlanes,
  opacity,
}: {
  isSelected: boolean;
  materialRoughness?: number;
  clippingPlanes: THREE.Plane[];
  opacity?: number;
}) {
  return (
    <meshStandardMaterial
      vertexColors
      color="#ffffff"
      emissive={isSelected ? '#1a75ff' : '#000000'}
      emissiveIntensity={isSelected ? 0.25 : 0}
      metalness={0.0}
      roughness={materialRoughness ?? 1.0}
      transparent
      opacity={opacity ?? 0.25}
      depthWrite={false}
      clippingPlanes={clippingPlanes}
      clipIntersection
      side={THREE.DoubleSide}
    />
  );
}

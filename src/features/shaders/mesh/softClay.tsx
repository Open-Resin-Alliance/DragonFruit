import * as THREE from 'three';

export function SoftClayMaterial({
  isSelected,
  materialRoughness,
  clippingPlanes,
}: {
  isSelected: boolean;
  materialRoughness?: number;
  clippingPlanes: THREE.Plane[];
}) {
  return (
    <meshStandardMaterial
      vertexColors
      color="#ffffff"
      emissive={isSelected ? '#1a75ff' : '#000000'}
      emissiveIntensity={isSelected ? 0.3 : 0}
      metalness={0.0}
      roughness={materialRoughness ?? 1.0}
      clippingPlanes={clippingPlanes}
      clipIntersection
      side={THREE.DoubleSide}
      flatShading={false}
    />
  );
}

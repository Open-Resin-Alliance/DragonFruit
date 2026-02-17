import * as THREE from 'three';

export function WireframeMaterial({
  clippingPlanes,
}: {
  clippingPlanes: THREE.Plane[];
}) {
  return (
    <meshBasicMaterial
      color="#d0d0d0"
      clippingPlanes={clippingPlanes}
      clipIntersection
      side={THREE.DoubleSide}
      wireframe
      polygonOffset
      polygonOffsetFactor={-1}
      polygonOffsetUnits={-1}
      transparent
      opacity={0.85}
    />
  );
}

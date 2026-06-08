import * as THREE from 'three';

export function OpaqueWireOverlayMaterial({
  clippingPlanes,
}: {
  clippingPlanes: THREE.Plane[];
}) {
  return (
    <meshBasicMaterial
      color="#AAAAAA"
      clippingPlanes={clippingPlanes}
      side={THREE.DoubleSide}
      wireframe
      polygonOffset
      polygonOffsetFactor={-1}
      polygonOffsetUnits={-1}
      transparent
      opacity={0.9}
      depthTest
      depthWrite={false}
    />
  );
}

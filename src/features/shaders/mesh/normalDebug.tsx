import * as THREE from 'three';

export function NormalDebugMaterial({
  clippingPlanes,
}: {
  clippingPlanes: THREE.Plane[];
}) {
  return (
    <meshNormalMaterial
      clippingPlanes={clippingPlanes}
      side={THREE.FrontSide}
    />
  );
}

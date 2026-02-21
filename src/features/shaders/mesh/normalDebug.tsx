import * as THREE from 'three';

export function NormalDebugMaterial({
  clippingPlanes,
}: {
  clippingPlanes: THREE.Plane[];
}) {
  return (
    <meshNormalMaterial
      clippingPlanes={clippingPlanes}
      clipIntersection
      side={THREE.FrontSide}
    />
  );
}

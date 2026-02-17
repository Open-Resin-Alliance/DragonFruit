import * as THREE from 'three';

export function FlatUnlitMaterial({
  useVertexColors,
  meshColor,
  clippingPlanes,
}: {
  useVertexColors?: boolean;
  meshColor?: string;
  clippingPlanes: THREE.Plane[];
}) {
  return (
    <meshBasicMaterial
      vertexColors={useVertexColors ?? true}
      color={useVertexColors ?? true ? '#ffffff' : (meshColor ?? '#ffffff')}
      clippingPlanes={clippingPlanes}
      clipIntersection
      side={THREE.DoubleSide}
    />
  );
}

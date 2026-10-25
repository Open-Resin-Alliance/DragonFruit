import type * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';

/**
 * The out-of-bounds stripe pass draws immediately after the support batches, at
 * the order the proxy's own overlay instances use. The stripe material pulls
 * its pixels forward with a negative polygon offset, so both passes sharing an
 * order is what the proxy does today.
 */
const OUT_OF_BOUNDS_RENDER_ORDER = 100000;

export interface PrepareSupportMeshProps {
  /**
   * One model's merged, world-space support geometry with group 0 = bodies and
   * group 1 = the parts the proxy tints with `discColor`. The caller owns it:
   * this component never disposes it, so a rebuilt geometry can be swapped
   * freely.
   */
  geometry: THREE.BufferGeometry | null;
  /** Body group colour. In the proxy this is the support base colour. */
  bodyColor: string;
  /** Disc-material colour: contact disks, cone tip spheres and root disks. */
  diskColor: string;
  /** Defaults to 1, the proxy's support opacity. */
  opacity?: number;
  /** Defaults to false; `depthWrite` follows it, as in the proxy batches. */
  transparent?: boolean;
  clippingPlanes?: THREE.Plane[] | null;
  visible?: boolean;
  /** Stripe material for the model's out-of-bounds pass; drawn as a second mesh. */
  outOfBoundsMaterial?: THREE.Material | null;
  /** Defaults to 0. The proxy draws its support batches at 100000. */
  renderOrder?: number;
  /**
   * Replaces the mesh's raycast. The Prepare merged layer passes a no-op: the
   * model mesh answers model-level picking, so the support mesh stays out of
   * every pointer raycast.
   */
  raycast?: ((raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) => void) | null;
  onClick?: (event: ThreeEvent<MouseEvent>) => void;
  onPointerOver?: (event: ThreeEvent<PointerEvent>) => void;
  onPointerOut?: (event: ThreeEvent<PointerEvent>) => void;
  onPointerDown?: (event: ThreeEvent<PointerEvent>) => void;
}

/**
 * The Prepare representation of one model's supports: a single mesh over the
 * merged geometry, with one material per group, so moving the model is a parent
 * matrix update over a few draws.
 *
 * Materials mirror the proxy's batches, which set no roughness, metalness or
 * side, so the meshStandardMaterial defaults stand. The disk group carries the
 * contact disk's polygon offset (`factor 1, units 1`) because that is the part
 * of the proxy that fights with the surface it sits on.
 */
export function PrepareSupportMesh({
  geometry,
  bodyColor,
  diskColor,
  opacity = 1,
  transparent = false,
  clippingPlanes = null,
  visible = true,
  outOfBoundsMaterial = null,
  renderOrder = 0,
  raycast,
  onClick,
  onPointerOver,
  onPointerOut,
  onPointerDown,
}: PrepareSupportMeshProps) {
  if (!geometry) return null;

  return (
    <>
      <mesh
        geometry={geometry}
        visible={visible}
        renderOrder={renderOrder}
        raycast={raycast ?? undefined}
        onClick={onClick}
        onPointerOver={onPointerOver}
        onPointerOut={onPointerOut}
        onPointerDown={onPointerDown}
      >
        {/* Group 0: shafts, root cones and spheres, joints, contact cone bodies. */}
        <meshStandardMaterial
          attach="material-0"
          color={bodyColor}
          transparent={transparent}
          opacity={opacity}
          depthWrite={!transparent}
          clippingPlanes={clippingPlanes ?? undefined}
        />
        {/* Group 1: contact disks, the only disc parts the proxy offsets. */}
        <meshStandardMaterial
          attach="material-1"
          color={diskColor}
          transparent={transparent}
          opacity={opacity}
          depthWrite={!transparent}
          clippingPlanes={clippingPlanes ?? undefined}
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
        />
        {/* Group 2: cone tip spheres and root disks, disc colour without offset. */}
        <meshStandardMaterial
          attach="material-2"
          color={diskColor}
          transparent={transparent}
          opacity={opacity}
          depthWrite={!transparent}
          clippingPlanes={clippingPlanes ?? undefined}
        />
      </mesh>
      {outOfBoundsMaterial && (
        <mesh
          geometry={geometry}
          visible={visible}
          renderOrder={OUT_OF_BOUNDS_RENDER_ORDER}
          raycast={() => null}
        >
          <primitive object={outOfBoundsMaterial} attach="material" />
        </mesh>
      )}
    </>
  );
}

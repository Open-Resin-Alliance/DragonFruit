import React, { useCallback, useMemo } from 'react';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import { ScreenSpaceGizmo } from '@/components/gizmo';
import type { GizmoAxis } from '@/components/gizmo';
import type { KeyPreviewFrame } from './types';

/** Max key tilt (radians) — mirrors the Rust `KEY_MAX_TILT_RAD` (~60°). */
const KEY_MAX_TILT_RAD = Math.PI / 3;

export interface OrganicCutKeyGizmoProps {
  /** All loaded models (to find the active one for its geometry/offset). */
  models: LoadedModel[];
  /** The active model's id. */
  activeModelId: string | null;
  /** The active model's transform (plate position/rotation/scale). */
  activeTransform?: ModelTransform;
  /**
   * The previewed key's placement frame in MODEL-LOCAL space (anchor = base center,
   * axis = un-tilted cut normal, u/v = in-plane basis). Null → no gizmo.
   */
  keyFrame: KeyPreviewFrame | null;
  /** Current key tilt / azimuth / roll (radians). */
  keyTiltRad: number;
  keyTiltAzimuthRad: number;
  keyRollRad: number;
  /** Report a new aim/roll (radians); tilt is pre-clamped. */
  onKeyAimChange: (tiltRad: number, azimuthRad: number, rollRad: number) => void;
  /** Notifies the host that a gizmo drag started/ended (to pause OrbitControls). */
  onDragStateChange?: (dragging: boolean) => void;
}

/**
 * The registration-key aim/roll gizmo — the app's standard ScreenSpaceGizmo
 * (rotate-only) mounted at the key's base center, oriented to the key's frame.
 *
 * IMPORTANT: this MUST be mounted INSIDE the scene's PickingProviderWrapper (the
 * same subtree as the main transform gizmo). The gizmo's handle hit-testing flows
 * through the GPU picking system; mounted outside the provider, its handles can't be
 * grabbed (the model mesh in front swallows the pointer). So it's rendered via a
 * SceneCanvas in-provider slot, NOT inside OrganicCutTool (which sits outside it).
 *
 * The key frame is reported in MODEL-LOCAL space; we compose the model's group chain
 * (plate transform → meshLocalOffset) into a WORLD anchor + a WORLD orientation whose
 * local x/y/z map to the key's u/v/axis. The three rotation rings then spin about the
 * key's own basis, and we map the per-axis deltas to tilt/azimuth/roll:
 *   - ring about the normal (z) → roll
 *   - rings in-plane (x/y) → the lean, held as a 2-D vector L = tilt·(cos az, sin az)
 *     in the (u, v) tangent plane; clamped to KEY_MAX_TILT_RAD.
 */
export function OrganicCutKeyGizmo({
  models,
  activeModelId,
  activeTransform,
  keyFrame,
  keyTiltRad,
  keyTiltAzimuthRad,
  keyRollRad,
  onKeyAimChange,
  onDragStateChange,
}: OrganicCutKeyGizmoProps) {
  const activeModel = useMemo(
    () => models.find((m) => m.id === activeModelId),
    [models, activeModelId],
  );
  const transform = activeTransform ?? activeModel?.transform;

  // The model's inner mesh offset (= −bboxCenter): the same nested offset StlMesh
  // applies, so local key-frame coords map to world correctly.
  const meshLocalOffset = useMemo(() => {
    if (!activeModel) return new THREE.Vector3();
    const geometry = activeModel.geometry.geometry;
    const bbox =
      geometry.boundingBox ??
      new THREE.Box3().setFromBufferAttribute(
        geometry.getAttribute('position') as THREE.BufferAttribute,
      );
    const center = bbox.getCenter(new THREE.Vector3());
    return new THREE.Vector3(-center.x, -center.y, -center.z);
  }, [activeModel]);

  // Stable primitive snapshots so the memo below only recomputes when VALUES change,
  // not when the `transform` object identity churns (it's rebuilt every render). An
  // unstable gizmo position/rotation feeds TransformGizmo's per-frame view-cull
  // setState and can spiral into a render loop.
  const tpx = transform?.position.x ?? 0;
  const tpy = transform?.position.y ?? 0;
  const tpz = transform?.position.z ?? 0;
  const trx = transform?.rotation.x ?? 0;
  const try_ = transform?.rotation.y ?? 0;
  const trz = transform?.rotation.z ?? 0;
  const tsx = transform?.scale.x ?? 1;
  const tsy = transform?.scale.y ?? 1;
  const tsz = transform?.scale.z ?? 1;
  const hasTransform = !!transform;

  const worldKeyGizmo = useMemo(() => {
    if (!keyFrame || !transform) return null;
    // Local frame vectors.
    const anchorL = new THREE.Vector3(...keyFrame.anchor);
    const uL = new THREE.Vector3(...keyFrame.u).normalize();
    const vL = new THREE.Vector3(...keyFrame.v).normalize();
    const axisL = new THREE.Vector3(...keyFrame.axis).normalize();
    // The model's local→world matrix = plate(position,quat,scale) ∘ meshLocalOffset.
    const modelQuat = quaternionFromGlobalEuler(transform.rotation);
    const outer = new THREE.Matrix4().compose(
      new THREE.Vector3(transform.position.x, transform.position.y, transform.position.z),
      modelQuat,
      new THREE.Vector3(transform.scale.x, transform.scale.y, transform.scale.z),
    );
    const inner = new THREE.Matrix4().makeTranslation(
      meshLocalOffset.x,
      meshLocalOffset.y,
      meshLocalOffset.z,
    );
    const localToWorld = outer.multiply(inner);
    // World anchor.
    const anchorW = anchorL.clone().applyMatrix4(localToWorld);
    // World basis directions (rotation+scale only → transform as directions, then
    // renormalize, so non-uniform plate scale doesn't skew the gizmo orientation).
    const normalMat = new THREE.Matrix3().getNormalMatrix(localToWorld);
    const uW = uL.clone().applyMatrix3(normalMat).normalize();
    const vW = vL.clone().applyMatrix3(normalMat).normalize();
    const axisW = axisL.clone().applyMatrix3(normalMat).normalize();
    // Build a rotation whose columns are (u, v, axis) → gizmo local x/y/z = u/v/axis.
    const basis = new THREE.Matrix4().makeBasis(uW, vW, axisW);
    const quat = new THREE.Quaternion().setFromRotationMatrix(basis);
    const euler = new THREE.Euler().setFromQuaternion(quat);
    return {
      position: [anchorW.x, anchorW.y, anchorW.z] as [number, number, number],
      rotation: [euler.x, euler.y, euler.z] as [number, number, number],
    };
    // Depend on primitive transform values (not the churning object) + keyFrame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyFrame, meshLocalOffset, hasTransform, tpx, tpy, tpz, trx, try_, trz, tsx, tsy, tsz]);

  const handleGizmoRotate = useCallback(
    (axis: GizmoAxis, delta: number) => {
      // The gizmo's emitted delta is negated relative to our key convention (the key
      // was rotating backwards), so flip it here.
      const d = -delta;
      if (axis === 'z') {
        onKeyAimChange(keyTiltRad, keyTiltAzimuthRad, keyRollRad + d);
        return;
      }
      // Current lean vector in (u, v). Rotating about +u (ring-x) tips the axis
      // toward +v → L.v grows; about +v (ring-y) tips toward −u → L.u shrinks.
      let lu = keyTiltRad * Math.cos(keyTiltAzimuthRad);
      let lv = keyTiltRad * Math.sin(keyTiltAzimuthRad);
      if (axis === 'x') lv += d;
      else lu -= d; // axis === 'y'
      let tilt = Math.hypot(lu, lv);
      const azimuth = tilt > 1e-6 ? Math.atan2(lv, lu) : keyTiltAzimuthRad;
      tilt = Math.min(tilt, KEY_MAX_TILT_RAD);
      onKeyAimChange(tilt, azimuth, keyRollRad);
    },
    [onKeyAimChange, keyTiltRad, keyTiltAzimuthRad, keyRollRad],
  );

  const handleGizmoDragState = useCallback(
    (dragging: boolean) => {
      onDragStateChange?.(dragging);
    },
    [onDragStateChange],
  );

  if (!worldKeyGizmo) return null;

  return (
    <ScreenSpaceGizmo
      position={worldKeyGizmo.position}
      rotation={worldKeyGizmo.rotation}
      followMeshRef={false}
      enableMove={false}
      enableScale={false}
      enableRotate
      showCenter={false}
      showMovePlanes={false}
      onRotate={handleGizmoRotate}
      onDragStateChange={handleGizmoDragState}
    />
  );
}

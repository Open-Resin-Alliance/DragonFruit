import { useCallback, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import { ScreenSpaceGizmo } from '@/components/gizmo';
import type { GizmoAxis } from '@/components/gizmo';
import type { ThreeEvent } from '@react-three/fiber';
import type { TenonPreviewFrame } from './types';
import { clampTenonTilt } from './tenonLeanTransform';
import { useOrganicCutColorNumbers } from './useOrganicCutColors';

/** The tenon has two rotations, not three: the lean (green ring) and the roll. */
const LEAN_AND_ROLL_RINGS: GizmoAxis[] = ['y', 'z'];

export interface OrganicCutTenonGizmoProps {
  /** All loaded models (to find the active one for its geometry/offset). */
  models: LoadedModel[];
  /** The active model's id. */
  activeModelId: string | null;
  /** The active model's transform (plate position/rotation/scale). */
  activeTransform?: ModelTransform;
  /**
   * The previewed tenon's placement frame in MODEL-LOCAL space (anchor = base center,
   * axis = un-tilted cut normal, u/v = in-plane basis). Null → no gizmo.
   */
  tenonFrame: TenonPreviewFrame | null;
  /**
   * Current tenon lean / roll (radians): the lean off the normal (the green ring)
   * and the spin about the tenon's own axis.
   */
  tenonTiltRad: number;
  tenonRollRad: number;
  /** Report a new aim (radians); the lean is pre-clamped. */
  onTenonAimChange: (tiltRad: number, rollRad: number) => void;
  /**
   * Where the tenon sits on the cut face (mm along the frame's u/v), and the
   * reporter for the base handle that slides it. Omit the setter and no handle is
   * drawn — the tenon stays on the centroid.
   */
  tenonAnchor?: [number, number, number] | null;
  /**
   * The contour membrane (flat triangle soup, model-local). The handle drags ON it:
   * a pointer ray against the cut face answers "where did they point" directly, in
   * the one form the cut also speaks — a point. Absent in flat-cut mode, where the
   * cut face IS a plane and the ray meets it exactly.
   */
  membranePreview?: Float32Array | null;
  onTenonAnchorChange?: (anchor: [number, number, number] | null) => void;
  /** Notifies the host that a gizmo drag started/ended (to pause OrbitControls). */
  onDragStateChange?: (dragging: boolean) => void;
}

/**
 * Fold an angle into (−π, π]. Roll is the only unbounded one of the three (tilt is
 * clamped, azimuth comes out of `atan2`), so without this it just keeps counting
 * up as the user spins the ring.
 */
function wrapAngle(rad: number): number {
  const TWO_PI = Math.PI * 2;
  let wrapped = rad % TWO_PI;
  if (wrapped > Math.PI) wrapped -= TWO_PI;
  else if (wrapped <= -Math.PI) wrapped += TWO_PI;
  return wrapped;
}


/**
 * The registration-tenon aim/roll gizmo — the app's standard ScreenSpaceGizmo
 * (rotate-only) mounted at the tenon's base center, oriented to the tenon's frame.
 *
 * IMPORTANT: this MUST be mounted INSIDE the scene's PickingProviderWrapper (the
 * same subtree as the main transform gizmo). The gizmo's handle hit-testing flows
 * through the GPU picking system; mounted outside the provider, its handles can't be
 * grabbed (the model mesh in front swallows the pointer). So it's rendered via a
 * SceneCanvas in-provider slot, NOT inside OrganicCutTool (which sits outside it).
 *
 * The tenon frame is reported in MODEL-LOCAL space; we compose the model's group chain
 * (plate transform → meshLocalOffset) into a WORLD anchor + a WORLD orientation whose
 * local x/y/z map to the tenon's u/v/axis. The three rotation rings then spin about the
 * tenon's own basis, and we map the per-axis deltas to tilt/azimuth/roll:
 *   - ring about the normal (z) → roll: turns the tenon AND the plane it leans in,
 *     as one body (see `leanAzimuthFor`)
 *   - green ring about the tenon's rolled u (y) → the lean off the normal, signed
 *     and clamped to what the geometry allows
 * There is no third ring and no free azimuth. The tenon's spin about its own axis
 * is not a freedom of its own: the lean plane is welded to one of the tenon's narrow
 * faces, so rolling moves both together.
 */
export function OrganicCutTenonGizmo({
  models,
  activeModelId,
  activeTransform,
  tenonFrame,
  tenonTiltRad,
  tenonRollRad,
  onTenonAimChange,
  tenonAnchor,
  membranePreview,
  onTenonAnchorChange,
  onDragStateChange,
}: OrganicCutTenonGizmoProps) {
  // The roll the gizmo's FRAME is drawn at. Frozen while a rotate ring is being
  // dragged: the roll commits to the panel state live (so the tenon rolls in the
  // preview), but if the frame turned with it the ring would rotate under the
  // pointer mid-drag and feed back into the angle — the roll drift. The frame
  // adopts the committed roll only when the drag ends.
  const [basisRoll, setBasisRoll] = useState(tenonRollRad);

  // Frozen initial angles at the start of a rotation drag, so `handleGizmoRotate`
  // computes every frame from one stable reference instead of reading React state
  // from a closure. Without this, rapid pointer events catch a stale
  // tenonRollRad / tenonTiltRad between re-renders and successive deltas overwrite
  // each other — the handle moves more than the tenon does.
  const frozenInitialRef = useRef<{
    tilt: number;
    roll: number;
    frame: TenonPreviewFrame;
  } | null>(null);
  const accumulatedDeltaRef = useRef<{ y: number; z: number }>({
    y: 0,
    z: 0,
  });
  const activeModel = useMemo(
    () => models.find((m) => m.id === activeModelId),
    [models, activeModelId],
  );
  const transform = activeTransform ?? activeModel?.transform;

  // The model's inner mesh offset (= −bboxCenter): the same nested offset StlMesh
  // applies, so local tenon-frame coords map to world correctly.
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

  const worldTenonGizmo = useMemo(() => {
    if (!tenonFrame || !transform) return null;
    // Local frame vectors.
    const anchorL = new THREE.Vector3(...tenonFrame.anchor);
    const uL = new THREE.Vector3(...tenonFrame.u).normalize();
    const vL = new THREE.Vector3(...tenonFrame.v).normalize();
    const axisL = new THREE.Vector3(...tenonFrame.axis).normalize();
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
    // The in-plane basis is ROLLED with the tenon: the lean plane turns with the roll
    // (that is what the roll ring is FOR), so the lean ring has to turn with it or
    // it would stop showing where the tenon is about to tip.
    // Turned by −roll for the sign reason in `leanAzimuthFor`: this is the frame
    // the body actually ends up in.
    const cr = Math.cos(basisRoll);
    const sr = Math.sin(basisRoll);
    const uR = uW.clone().multiplyScalar(cr).sub(vW.clone().multiplyScalar(sr)).normalize();
    const vR = uW.clone().multiplyScalar(sr).add(vW.clone().multiplyScalar(cr)).normalize();
    // The gizmo's local Y is the tenon's rolled u — the axis the lean turns about —
    // so the GREEN ring is the lean. Right-handed with z = axis means x = y × z =
    // u × axis = −v.
    const basis = new THREE.Matrix4().makeBasis(vR.clone().negate(), uR, axisW);
    const quat = new THREE.Quaternion().setFromRotationMatrix(basis);
    const euler = new THREE.Euler().setFromQuaternion(quat);
    return {
      position: [anchorW.x, anchorW.y, anchorW.z] as [number, number, number],
      rotation: [euler.x, euler.y, euler.z] as [number, number, number],
      anchorW,
      axisW,
      // Kept for the base handle's drag: the pointer lands in WORLD space and the
      // offsets are LOCAL millimetres, so the hit has to come back through this.
      worldToLocal: new THREE.Matrix4().copy(localToWorld).invert(),
      uL,
      vL,
      anchorL,
    };
    // Depend on primitive transform values (not the churning object) + tenonFrame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenonFrame, basisRoll, meshLocalOffset, hasTransform, tpx, tpy, tpz, trx, try_, trz, tsx, tsy, tsz]);

  const handleGizmoRotate = useCallback(
    (axis: GizmoAxis, delta: number): number => {
      // When a drag is active, compute every frame from the FROZEN initial values
      // plus the total accumulated delta in a ref — the same pattern
      // HolePunchGizmo uses. This keeps the rotation 1:1 with the handle through
      // a long drag, even when pointer events fire faster than React re-renders.
      const frozen = frozenInitialRef.current;
      if (frozen) {
        if (axis === 'z') {
          // Roll takes the delta UNFLIPPED: the flip the lean ring needs drove the
          // tenon the opposite way to the handle the user was dragging on this one.
          accumulatedDeltaRef.current.z += delta;
          const roll = wrapAngle(frozen.roll + accumulatedDeltaRef.current.z);
          onTenonAimChange(
            frozen.tilt - accumulatedDeltaRef.current.y,
            roll,
          );
          // All of it went through — the roll has no end to run into.
          return delta;
        }
        // axis === 'y': the lean.
        {
          // The lean BEFORE this frame, already through the clamp. We call
          // clampTenonTilt again rather than trusting the accumulator, in case
          // the frame changed (it shouldn't during a drag, but this is free).
          const prevLean = clampTenonTilt(
            frozen.tilt - accumulatedDeltaRef.current.y,
            frozen.frame,
          );
          // What the lean WOULD be if the full raw delta were applied.
          const attemptedLean = clampTenonTilt(
            frozen.tilt - (accumulatedDeltaRef.current.y + delta),
            frozen.frame,
          );
          // Only accumulate the delta that actually changed the lean. When the
          // clamp ceiling stops the tenon, the excess delta is discarded — so
          // the accumulator stays at the clamp value and reversing picks up
          // immediately instead of having to unwind all the excess first.
          const effectiveDelta = prevLean - attemptedLean;
          accumulatedDeltaRef.current.y += effectiveDelta;
          onTenonAimChange(
            attemptedLean,
            frozen.roll + accumulatedDeltaRef.current.z,
          );
          return effectiveDelta;
        }
      }

      // Fallback when no frozen ref exists (drag hasn't started yet — the ref is
      // set synchronously during handleDragStart, so this should be rare).
      if (axis === 'z') {
        const roll = wrapAngle(tenonRollRad + delta);
        onTenonAimChange(tenonTiltRad, roll);
        return delta;
      }
      const tilt = clampTenonTilt(tenonTiltRad - delta, tenonFrame);
      onTenonAimChange(tilt, tenonRollRad);
      return tenonTiltRad - tilt;
    },
    [onTenonAimChange, tenonTiltRad, tenonRollRad, tenonFrame],
  );

  // --- The base handle: slide the tenon across the cut face --------------------
  // It lives HERE, not in OrganicCutTool, for the reason in this file's header:
  // the tenon's anchor sits ON the cut face, buried inside the body, so a handle
  // mounted outside the picking provider loses every click to the model surface
  // in front of it — which then read as "add a waypoint".
  const colors = useOrganicCutColorNumbers();
  const [draggingHandle, setDraggingHandle] = useState(false);
  const draggingRef = useRef(false);

  /**
   * The cut face as a mesh, for hit-testing the drag. Built from the membrane soup
   * once per preview — the same triangles the cut uses, so a point on it is a point
   * the cut can honour.
   */
  const membraneMesh = useMemo(() => {
    if (!membranePreview || membranePreview.length < 9) return null;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(membranePreview, 3));
    geom.computeBoundingSphere();
    return new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  }, [membranePreview]);

  /**
   * Pointer ray → the model-local POINT on the cut face under the cursor.
   *
   * On a contour cut that is a hit against the membrane itself. On a flat cut the
   * face is a plane, so the ray meets it exactly and no mesh is needed. Either way
   * the answer is a place on the cut face — which is precisely what the anchor is,
   * so nothing has to be converted, accumulated, or measured against an origin.
   */
  const facePoint = useCallback(
    (e: ThreeEvent<PointerEvent>): [number, number, number] | null => {
      const g = worldTenonGizmo;
      if (!g) return null;
      if (membraneMesh) {
        // The membrane is in model-local coords, so cast the ray there too.
        const local = new THREE.Ray(
          e.ray.origin.clone().applyMatrix4(g.worldToLocal),
          e.ray.direction.clone().transformDirection(g.worldToLocal).normalize(),
        );
        const raycaster = new THREE.Raycaster();
        raycaster.ray.copy(local);
        raycaster.far = Infinity;
        const hit = raycaster.intersectObject(membraneMesh, false)[0];
        // A ray that misses the face says nothing about where the tenon should go;
        // better to leave it where it is than to invent a point.
        if (!hit) return null;
        return [hit.point.x, hit.point.y, hit.point.z];
      }
      const denom = e.ray.direction.dot(g.axisW);
      if (Math.abs(denom) < 1e-6) return null; // ray parallel to the cut face
      const t = g.anchorW.clone().sub(e.ray.origin).dot(g.axisW) / denom;
      if (!Number.isFinite(t)) return null;
      const hitLocal = e.ray.origin
        .clone()
        .add(e.ray.direction.clone().multiplyScalar(t))
        .applyMatrix4(g.worldToLocal);
      return [hitLocal.x, hitLocal.y, hitLocal.z];
    },
    [worldTenonGizmo, membraneMesh],
  );

  const handlePointerDown = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (e.button !== 0 || !onTenonAnchorChange) return;
      e.stopPropagation();
      try {
        (e.currentTarget as unknown as { setPointerCapture?: (id: number) => void })
          .setPointerCapture?.(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
      // No grab offset to remember: the tenon goes where the pointer is. It used to
      // be dragged grab-relative because the offset accumulated deltas and drift
      // would compound; an absolute point has nothing to accumulate.
      draggingRef.current = true;
      setDraggingHandle(true);
      onDragStateChange?.(true);
      document.body.style.cursor = 'grabbing';
    },
    [onDragStateChange, onTenonAnchorChange],
  );

  const handlePointerMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (!draggingRef.current || !onTenonAnchorChange) return;
      e.stopPropagation();
      const at = facePoint(e);
      if (!at) return;
      onTenonAnchorChange(at);
    },
    [facePoint, onTenonAnchorChange],
  );

  const endHandleDrag = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (!draggingRef.current) return;
      e.stopPropagation();
      try {
        const target = e.currentTarget as unknown as {
          hasPointerCapture?: (id: number) => boolean;
          releasePointerCapture?: (id: number) => void;
        };
        if (target.hasPointerCapture?.(e.pointerId)) target.releasePointerCapture?.(e.pointerId);
      } catch {
        /* best-effort release */
      }
      draggingRef.current = false;
      setDraggingHandle(false);
      onDragStateChange?.(false);
      document.body.style.cursor = '';
    },
    [onDragStateChange],
  );

  const handlePointerOver = useCallback((e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (!draggingRef.current) document.body.style.cursor = 'grab';
  }, []);
  const handlePointerOut = useCallback(() => {
    if (!draggingRef.current) document.body.style.cursor = '';
  }, []);

  /**
   * Crosshair radius in world units, from the tenon's own depth so it scales with
   * the tenon — but small: this marks a point, it must not hide the tenon it sits on.
   */
  const handleRadius = useMemo(() => {
    const depth = tenonFrame?.depth ?? 2.5;
    return Math.min(0.5, Math.max(0.08, depth * 0.06));
  }, [tenonFrame]);

  /** The four ticks of the crosshair, in the cut plane (local XY). */
  const crosshairTicks = useMemo(() => {
    const r = handleRadius;
    const inner = r * 0.45;
    const outer = r * 1.35;
    const pts = [
      inner, 0, 0, outer, 0, 0,
      -inner, 0, 0, -outer, 0, 0,
      0, inner, 0, 0, outer, 0,
      0, -inner, 0, 0, -outer, 0,
    ];
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return geom;
  }, [handleRadius]);

  const crosshairRing = useMemo(
    () => new THREE.RingGeometry(handleRadius * 0.78, handleRadius, 28),
    [handleRadius],
  );

  /**
   * Report this handle as the NEAREST hit, whatever its real depth.
   *
   * R3F sorts intersections by distance and runs the handlers nearest-first, and
   * the tenon's anchor sits on the cut face — buried inside the body. The model
   * surface in front therefore won every click and read it as "add a waypoint",
   * both inside and outside the picking provider. Forcing the distance is the
   * pointer-side twin of the `depthTest: false` this overlay already draws with:
   * if the ray passes through the handle, the handle gets it.
   */
  const grabRaycast = useMemo(() => {
    return function raycastAlwaysNearest(
      this: THREE.Mesh,
      raycaster: THREE.Raycaster,
      intersects: THREE.Intersection[],
    ) {
      const own: THREE.Intersection[] = [];
      THREE.Mesh.prototype.raycast.call(this, raycaster, own);
      for (const hit of own) intersects.push({ ...hit, distance: 1e-6 });
    };
  }, []);

  /**
   * The crosshair's world position: the anchor, which during a drag is already
   * ahead of the frame Rust last sent back. No offsets to reconcile — the anchor
   * IS the place, so the crosshair sits on it and the preview catches up under it.
   */
  const handlePosition = useMemo((): [number, number, number] | null => {
    const g = worldTenonGizmo;
    if (!g) return null;
    if (!tenonAnchor) return g.position;
    const localToWorld = new THREE.Matrix4().copy(g.worldToLocal).invert();
    const p = new THREE.Vector3(...tenonAnchor).applyMatrix4(localToWorld);
    return [p.x, p.y, p.z];
  }, [worldTenonGizmo, tenonAnchor]);

  const handleGizmoDragState = useCallback(
    (dragging: boolean) => {
      if (dragging) {
        // Freeze the initial tenon angles in refs so `handleGizmoRotate` never
        // reads a stale React closure during rapid pointer events.
        frozenInitialRef.current = {
          tilt: tenonTiltRad,
          roll: tenonRollRad,
          frame: tenonFrame!,
        };
        accumulatedDeltaRef.current = { y: 0, z: 0 };
        // Also freeze the gizmo frame's roll so the ring doesn't rotate under
        // the pointer mid-drag and feed back into the angle.
        setBasisRoll(tenonRollRad);
      } else {
        // On release, compute the final roll from the frozen ref (which
        // faithfully tracks every pointer event, not just the last re-render)
        // so the gizmo frame snaps to exactly where the tenon landed.
        const frozen = frozenInitialRef.current;
        if (frozen) {
          setBasisRoll(wrapAngle(frozen.roll + accumulatedDeltaRef.current.z));
        } else {
          setBasisRoll(tenonRollRad);
        }
        frozenInitialRef.current = null;
      }
      onDragStateChange?.(dragging);
    },
    [onDragStateChange, tenonRollRad, tenonTiltRad, tenonFrame],
  );

  if (!worldTenonGizmo) return null;

  return (
    <>
    {onTenonAnchorChange && (
      <group position={handlePosition ?? worldTenonGizmo.position} rotation={worldTenonGizmo.rotation}>
        {/* Invisible grab volume. A sphere rather than a disc in the cut plane:
            seen edge-on a disc is a line and there is nothing left to grab. */}
        <mesh
          raycast={grabRaycast}
          renderOrder={1002}
          frustumCulled={false}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endHandleDrag}
          onPointerCancel={endHandleDrag}
          onPointerOver={handlePointerOver}
          onPointerOut={handlePointerOut}
        >
          <sphereGeometry args={[handleRadius * 2.6, 12, 12]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
        </mesh>
        {/* Crosshair, lying IN the cut plane so it also shows which plane the tenon
            slides on. A filled dot hid the tenon and read as a sticker on it.
            Drawn above the seam's solid pass (which now clears the tenon) so the
            handle you grab is never the thing hidden. */}
        <mesh geometry={crosshairRing} renderOrder={1010} frustumCulled={false}>
          <meshBasicMaterial
            color={colors.tenonHandle}
            depthTest={false}
            transparent
            opacity={draggingHandle ? 1 : 0.85}
            side={THREE.DoubleSide}
          />
        </mesh>
        <lineSegments geometry={crosshairTicks} renderOrder={1011} frustumCulled={false}>
          <lineBasicMaterial
            color={colors.tenonHandle}
            depthTest={false}
            transparent
            opacity={draggingHandle ? 1 : 0.85}
          />
        </lineSegments>
      </group>
    )}
    <ScreenSpaceGizmo
      position={worldTenonGizmo.position}
      rotation={worldTenonGizmo.rotation}
      followMeshRef={false}
      enableMove={false}
      enableScale={false}
      enableRotate
      showCenter={false}
      showMovePlanes={false}
      // Fixed-relative, same as the hole-punch gizmo: rings stay in the tenon's
      // frame (no camera billboarding) and never fade with the view, so the
      // lean/roll handles don't chase the camera or vanish at oblique angles.
      disableArrowFlip
      disableRingBillboard
      disableViewCull
      rotateAxes={LEAN_AND_ROLL_RINGS}
      // The frame's roll is FROZEN during a drag (see `basisRoll`) so the ring
      // doesn't rotate under the pointer — that feedback is the roll drift. So the
      // blue ring no longer carries the handle by turning the frame; the handle
      // advances via the dial instead (like the lean rings), and the frame adopts
      // the committed roll on release.
      onRotate={handleGizmoRotate}
      onDragStateChange={handleGizmoDragState}
    />
    </>
  );
}

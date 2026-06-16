import React, { useCallback, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import type { KeyPreviewFrame, OrganicCutLoopPoint, OrganicCutMode } from './types';
import { cutPlaneFromPoints } from './cutPlane';

interface OrganicCutToolProps {
  models: LoadedModel[];
  activeModelId: string | null;
  activeTransform?: ModelTransform;
  /** Whether the tool is interactive (false while applying). Reserved for future use. */
  active: boolean;
  /** Loop points placed so far (model-local space), owned by the parent. */
  loop: OrganicCutLoopPoint[];
  /** Append a point picked on the surface. Reserved for future in-canvas hooks. */
  onAddPoint: (point: OrganicCutLoopPoint) => void;
  /**
   * Reposition an existing waypoint (drag-to-edit). Called live as the marker is
   * dragged across the surface, with the new model-local surface point.
   */
  onUpdatePoint?: (index: number, point: OrganicCutLoopPoint) => void;
  /**
   * Notifies the host that a marker drag started/ended so it can disable
   * OrbitControls (and any marquee selection) for the duration of the drag.
   */
  onDragStateChange?: (dragging: boolean) => void;
  /**
   * Hover state over the seam line (hover-to-arm for right-click insertion). Null
   * when not hovering. When set, carries the model-local point under the cursor
   * and the chain index AFTER which a new waypoint should be inserted (so it lands
   * between waypoints `afterIndex` and `afterIndex+1`). The host arms its
   * right-click "Add waypoint here" menu from this.
   */
  onLineHoverChange?: (
    info: { localPoint: [number, number, number]; afterIndex: number } | null,
  ) => void;
  /**
   * Left-click on the seam line → insert a waypoint at the clicked point (between
   * waypoints `afterIndex` and `afterIndex+1`). Same result as the right-click
   * "Add waypoint here", but more discoverable.
   */
  onLineClick?: (info: { localPoint: [number, number, number]; afterIndex: number }) => void;
  /** Index of the currently selected waypoint (highlighted), or null. */
  selectedIndex?: number | null;
  /** Select a waypoint (click a marker), or null to clear (click elsewhere). */
  onSelectPoint?: (index: number | null) => void;
  /**
   * Hover state over a WAYPOINT marker (hover-to-arm for right-click delete).
   * Null when not over a marker; otherwise the hovered waypoint index. The host
   * arms a "Delete waypoint" menu from this on right-click.
   */
  onMarkerHoverChange?: (index: number | null) => void;
  /**
   * Surface-following loop polyline (flat xyz, model-local) from the Rust geodesic
   * engine. When present, it's drawn instead of straight chords so the seam hugs
   * the surface. Null until ≥2 points / outside Tauri.
   */
  geodesicPolyline?: Float32Array | null;
  /**
   * Flat vs contour cut. In `contour` mode the flat-plane preview is hidden (the
   * cut follows the curved seam, so a flat quad would be misleading) and only the
   * on-surface geodesic loop is shown.
   */
  cutMode?: OrganicCutMode;
  /**
   * Contour-cut membrane preview as a flat triangle soup (model-local). When
   * present (contour mode), it's rendered translucent so the user sees the exact
   * curved cutter surface the cut will use.
   */
  membranePreview?: Float32Array | null;
  /**
   * Registration-key preview as a flat triangle soup (model-local): the peg AND
   * socket the cut will place. Rendered translucent in a distinct color so the
   * user sees the key straddling the cut before committing.
   */
  keyPreview?: Float32Array | null;
  /**
   * Placement frame of the previewed key (model-local). The key SOUP is built
   * UN-tilted (straight); the tilt is applied LIVE as a rigid rotation of the key
   * mesh here, so dragging the aim gizmo moves the key instantly with no Rust
   * round-trip. Null when no key. (The real cut bakes the tilt in Rust.)
   */
  keyFrame?: KeyPreviewFrame | null;
  /** Live key tilt / azimuth / roll (radians) for the client-side rotation. */
  keyTiltRad?: number;
  keyTiltAzimuthRad?: number;
  keyRollRad?: number;
}

/** Max key tilt (radians) — mirrors the Rust `KEY_MAX_TILT_RAD` (~60°). */
const KEY_MAX_TILT_RAD = Math.PI / 3;

/** Marker radius as a fraction of the model's bbox diagonal (small = precise). */
const MARKER_RADIUS_FRACTION = 0.00075;
/** Clamp the marker radius (model-local units) so it's usable on any model size. */
const MARKER_RADIUS_MIN = 0.005;
const MARKER_RADIUS_MAX = 0.3;
const LOOP_LINE_BIAS_MM = 0.2;

/**
 * In-canvas visualization for the Cutting Mode loop.
 *
 * IMPORTANT: surface picking does NOT happen here. Clicks are captured by the
 * real model mesh (StlMesh) through the scene's camera-aware pointer pipeline
 * (`onOrganicCutClick`, mirroring hole-punch), which is the only reliable way to
 * pick a surface point without fighting OrbitControls. This component only draws
 * the placed loop points + connecting line.
 *
 * Loop points are stored in the model's LOCAL geometry space (the space produced
 * by `hit.object.worldToLocal`, where `hit.object` is StlMesh's INNER mesh).
 * StlMesh nests an outer group at the plate transform and an inner mesh offset by
 * `meshLocalOffset` (= -bboxCenter). We replicate that exact nesting here so the
 * loop markers land precisely on the picked surface points.
 */
export function OrganicCutTool({
  models,
  activeModelId,
  activeTransform,
  loop,
  onUpdatePoint,
  onDragStateChange,
  onLineHoverChange,
  onLineClick,
  selectedIndex = null,
  onSelectPoint,
  onMarkerHoverChange,
  geodesicPolyline,
  cutMode = 'plane',
  membranePreview,
  keyPreview,
  keyFrame,
  keyTiltRad = 0,
  keyTiltAzimuthRad = 0,
  keyRollRad = 0,
}: OrganicCutToolProps) {
  const activeModel = useMemo(() => models.find((m) => m.id === activeModelId), [models, activeModelId]);
  const transform = activeTransform || activeModel?.transform;

  const currentQuaternion = useMemo(() => {
    if (!transform) return new THREE.Quaternion();
    return quaternionFromGlobalEuler(transform.rotation);
  }, [transform]);

  // Mirror StlMesh's inner offset (= -bboxCenter) so our markers share the exact
  // local space the picked points were captured in.
  const meshLocalOffset = useMemo(() => {
    if (!activeModel) return new THREE.Vector3();
    const geometry = activeModel.geometry.geometry;
    const bbox =
      geometry.boundingBox ??
      new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
    const center = bbox.getCenter(new THREE.Vector3());
    return new THREE.Vector3(-center.x, -center.y, -center.z);
  }, [activeModel]);

  // Build the connecting polyline as a concrete THREE.Line so we can render it via
  // <primitive>, avoiding the JSX <line> ambiguity with SVG line elements.
  //
  // PREFER the surface-following geodesic polyline from Rust when available; only
  // fall back to straight chords between points if it hasn't computed yet.
  // Flat xyz positions of the rendered seam polyline (geodesic when available,
  // else straight chords). Shared by the visible line and the pickable tube.
  const loopPositions = useMemo<number[] | null>(() => {
    let positions: number[] | null = null;
    if (geodesicPolyline && geodesicPolyline.length >= 6) {
      // The seam line is the SOURCE OF TRUTH: render it exactly where it is, on
      // the surface, so it's accurate for the cut and stays connected to the
      // waypoints (which are also on the surface). The wafer is built to meet this
      // line, not the other way around.
      positions = Array.from(geodesicPolyline);
      // The Rust geodesic for a CLOSED loop omits the final point (it equals the
      // first), so the rendered line would have a visible gap at the start point.
      // Append the first vertex to draw the loop fully closed. (Only for a real
      // loop — ≥3 waypoints — which is when the Rust side closes it.)
      if (loop.length >= 3) {
        const first = positions.slice(0, 3);
        const lastIdx = positions.length - 3;
        const dx = positions[lastIdx] - first[0];
        const dy = positions[lastIdx + 1] - first[1];
        const dz = positions[lastIdx + 2] - first[2];
        // Only append if the end isn't already at the start (avoid a zero-length
        // duplicate segment).
        if (dx * dx + dy * dy + dz * dz > 1e-10) {
          positions.push(first[0], first[1], first[2]);
        }
      }
    } else if (loop.length >= 2) {
      positions = [];
      const pushBiased = (p: OrganicCutLoopPoint) => {
        positions!.push(
          p.position[0] + p.normal[0] * LOOP_LINE_BIAS_MM,
          p.position[1] + p.normal[1] * LOOP_LINE_BIAS_MM,
          p.position[2] + p.normal[2] * LOOP_LINE_BIAS_MM,
        );
      };
      for (const p of loop) pushBiased(p);
      if (loop.length >= 3) pushBiased(loop[0]);
    }
    return positions && positions.length >= 6 ? positions : null;
  }, [loop, geodesicPolyline]);

  const loopLine = useMemo(() => {
    const positions = loopPositions;
    if (!positions || positions.length < 6) return null;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({ color: 0x37ff7a, depthTest: false, transparent: true });
    const line = new THREE.Line(geom, material);
    line.renderOrder = 999;
    return line;
  }, [loopPositions]);

  // Two tubes along the seam from a shared curve: a THIN visible `glow` tube (the
  // hover highlight) and a WIDER invisible `hit` tube (the pointer/right-click
  // target). Separating them lets the hitbox be comfortably grabbable without
  // fattening the visible highlight. Radii scale with the model.
  const seamTubes = useMemo(() => {
    if (!loopPositions || loopPositions.length < 6 || !activeModel) return null;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i + 2 < loopPositions.length; i += 3) {
      pts.push(new THREE.Vector3(loopPositions[i], loopPositions[i + 1], loopPositions[i + 2]));
    }
    if (pts.length < 2) return null;
    const geometry = activeModel.geometry.geometry;
    const bbox =
      geometry.boundingBox ??
      new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
    const diag = bbox.getSize(new THREE.Vector3()).length();
    const segments = Math.max(8, pts.length);
    const curve = new THREE.CatmullRomCurve3(pts, false);
    const glowRadius = Math.max(0.01, diag * 0.00045);
    const hitRadius = Math.max(0.025, diag * 0.0014); // ~3x the glow, for easy hovering
    const glow = new THREE.TubeGeometry(curve, segments, glowRadius, 6, false);
    glow.computeBoundingSphere();
    const hit = new THREE.TubeGeometry(curve, segments, hitRadius, 6, false);
    hit.computeBoundingSphere();
    return { glow, hit };
  }, [loopPositions, activeModel]);

  // Live cut-plane preview: a translucent quad showing EXACTLY where the slice
  // lands, from the same plane formula the cut uses. Sized to span the model.
  const planePreview = useMemo(() => {
    if (!activeModel) return null;
    // In contour mode or bounded plane mode, a simple flat quad derived from waypoints is hidden/irrelevant.
    if (cutMode === 'contour' || cutMode === 'bounded_plane') return null;
    const plane = cutPlaneFromPoints(loop);
    if (!plane) return null;

    const geometry = activeModel.geometry.geometry;
    const bbox =
      geometry.boundingBox ??
      new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
    const size = bbox.getSize(new THREE.Vector3());
    // Make the quad comfortably larger than the model so it clearly spans it.
    const span = Math.max(size.x, size.y, size.z) * 1.4 + 4;

    // Orient a default-Z-facing quad to face the plane normal, positioned at the
    // plane point (the local bbox center is already removed by meshLocalOffset's
    // parent group, and `plane.point` is in the same local space as the loop).
    const quat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      plane.normal.clone().normalize(),
    );
    return { span, quat, position: plane.point };
  }, [activeModel, loop, cutMode]);

  // Translucent membrane (curved cutter surface or bounded plane cutter slab). Built from the
  // flat triangle soup Rust returns, so it's EXACTLY the surface the cut uses.
  const membraneGeometry = useMemo(() => {
    if ((cutMode !== 'contour' && cutMode !== 'bounded_plane') || !membranePreview || membranePreview.length < 9) return null;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(membranePreview, 3));
    geom.computeVertexNormals();
    // Without a bounding sphere three.js frustum-culls the mesh (treats it as
    // off-screen) → it never draws. Compute it so the membrane is visible.
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    return geom;
  }, [cutMode, membranePreview]);

  // Registration-key preview (peg + socket) for contour/bounded_plane mode. Built from the flat
  // soup Rust returns, so it's EXACTLY the key the cut will place.
  const keyGeometry = useMemo(() => {
    if ((cutMode !== 'contour' && cutMode !== 'bounded_plane') || !keyPreview || keyPreview.length < 9) return null;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(keyPreview, 3));
    geom.computeVertexNormals();
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    return geom;
  }, [cutMode, keyPreview]);

  // Edge outline of the key so its 3D form (the tapered box / dome) reads even as
  // a flat depth-test-off overlay. EdgesGeometry keeps only the sharp silhouette
  // edges (not every triangle), so the peg/socket shape is clear, not a mess.
  const keyWireframe = useMemo(() => {
    if (!keyGeometry) return null;
    const edges = new THREE.EdgesGeometry(keyGeometry, 20);
    edges.computeBoundingSphere();
    return edges;
  }, [keyGeometry]);

  // LIVE key tilt matrix (model-local world space). The key SOUP is built straight
  // (un-tilted) in Rust, so dragging the aim gizmo never triggers a Rust rebuild —
  // instead we rotate the key mesh here, instantly. This MUST match the Rust
  // `LeanXform` EXACTLY so the preview equals the cut.
  //
  // CRITICAL: the soup is built in the Rust BUILD frame (`frame_extruding_toward_
  // part_b`), which is the reported natural frame with the axis NEGATED and u/v
  // SWAPPED. The lean rotation is computed in that build frame. If we instead
  // rotated in the natural frame, the lean would be MIRRORED (the build-frame swap
  // flips handedness). So we reconstruct the build frame here and apply the lean the
  // same way Rust's LeanXform::for_build does.
  const keyTiltMatrix = useMemo(() => {
    if (!keyFrame) return null;
    const anchor = new THREE.Vector3(...keyFrame.anchor);
    // Natural ("orig") frame as reported.
    const axisN = new THREE.Vector3(...keyFrame.axis).normalize();
    const uN = new THREE.Vector3(...keyFrame.u).normalize();
    const vN = new THREE.Vector3(...keyFrame.v).normalize();
    // Build frame = frame_extruding_toward_part_b(natural): negate axis, swap u/v.
    const buildAxis = axisN.clone().multiplyScalar(-1);
    const buildU = vN.clone();
    const buildV = uN.clone();

    const tilt = Math.min(Math.abs(keyTiltRad), KEY_MAX_TILT_RAD) * Math.sign(keyTiltRad || 1);
    const roll = keyRollRad;
    if (Math.abs(tilt) < 1e-6 && Math.abs(roll) < 1e-6) return null;

    // Apply order (matches LeanXform::apply): roll about build +axis, then lean about
    // the in-plane axis k, composed as q = qLean · qRoll.
    const q = new THREE.Quaternion();
    if (Math.abs(roll) >= 1e-6) {
      q.premultiply(new THREE.Quaternion().setFromAxisAngle(buildAxis, roll));
    }
    let sink = 0;
    if (Math.abs(tilt) >= 1e-6) {
      // leanWorld = cos(az)·uN + sin(az)·vN (in the ORIGINAL/natural tangent plane).
      const leanWorld = uN.clone().multiplyScalar(Math.cos(keyTiltAzimuthRad))
        .add(vN.clone().multiplyScalar(Math.sin(keyTiltAzimuthRad)));
      // Project onto the BUILD basis: lu = leanWorld·buildU, lv = leanWorld·buildV.
      const lu = leanWorld.dot(buildU);
      const lv = leanWorld.dot(buildV);
      const len = Math.hypot(lu, lv);
      if (len > 1e-9) {
        // k (build-local) = (−lv, lu, 0)/len → world vector via the build basis.
        const k = buildU.clone().multiplyScalar(-lv / len)
          .add(buildV.clone().multiplyScalar(lu / len))
          .normalize();
        q.premultiply(new THREE.Quaternion().setFromAxisAngle(k, tilt));
        // Sink so the tilted base stays buried (matches the Rust half_diag·sin sink).
        // half_diag ≈ the base footprint reach; depth is the closest proxy we have on
        // the frontend, and the sink only affects how deep the base goes (not the
        // visible orientation), so a small mismatch is harmless.
        sink = keyFrame.depth * 0.9 * Math.sin(Math.abs(tilt));
      }
    }

    // Compose about the anchor: translate to origin, rotate, sink along −buildAxis,
    // translate back. m = back · sink · rot · toOrigin.
    const toOrigin = new THREE.Matrix4().makeTranslation(-anchor.x, -anchor.y, -anchor.z);
    const rot = new THREE.Matrix4().makeRotationFromQuaternion(q);
    const sinkV = buildAxis.clone().multiplyScalar(-sink);
    const sinkM = new THREE.Matrix4().makeTranslation(sinkV.x, sinkV.y, sinkV.z);
    const back = new THREE.Matrix4().makeTranslation(anchor.x, anchor.y, anchor.z);
    return back.multiply(sinkM).multiply(rot).multiply(toOrigin);
  }, [keyFrame, keyTiltRad, keyTiltAzimuthRad, keyRollRad]);

  // Clip the key preview AT THE WAFER: hide everything on the part_a (+normal) side
  // of the cut plane, so the preview shows only the portion that actually goes into
  // the body (below the wafer) — not the full peg poking up above it. The wafer plane
  // is FIXED (it doesn't tilt with the key); as the key leans, its part_a-side
  // overhang is clipped by this stationary plane. The plane is in WORLD space (where
  // three.js clipping planes operate), so we transform the local key frame to world.
  // Stable primitive snapshots of the transform so the plane memo only recomputes
  // when values actually change (not on every render — `transform` is a fresh object
  // each render). A new Plane object each render churns the material's clippingPlanes.
  const ctpx = transform?.position.x ?? 0;
  const ctpy = transform?.position.y ?? 0;
  const ctpz = transform?.position.z ?? 0;
  const ctrx = transform?.rotation.x ?? 0;
  const ctry = transform?.rotation.y ?? 0;
  const ctrz = transform?.rotation.z ?? 0;
  const ctsx = transform?.scale.x ?? 1;
  const ctsy = transform?.scale.y ?? 1;
  const ctsz = transform?.scale.z ?? 1;
  const cHasTransform = !!transform;
  const keyClipPlane = useMemo(() => {
    if (!keyFrame || !cHasTransform) return null;
    const anchorL = new THREE.Vector3(...keyFrame.anchor);
    const axisL = new THREE.Vector3(...keyFrame.axis).normalize();
    // local→world = plate(position, quat, scale) ∘ meshLocalOffset. Build the quat
    // here from the rotation primitives (not the churning currentQuaternion) so this
    // only recomputes when values actually change.
    const quat = quaternionFromGlobalEuler({ x: ctrx, y: ctry, z: ctrz });
    const outer = new THREE.Matrix4().compose(
      new THREE.Vector3(ctpx, ctpy, ctpz),
      quat,
      new THREE.Vector3(ctsx, ctsy, ctsz),
    );
    const inner = new THREE.Matrix4().makeTranslation(meshLocalOffset.x, meshLocalOffset.y, meshLocalOffset.z);
    const localToWorld = outer.multiply(inner);
    const anchorW = anchorL.clone().applyMatrix4(localToWorld);
    const normalMat = new THREE.Matrix3().getNormalMatrix(localToWorld);
    // Keep the part_b side (where the peg extrudes into the body): a clipping plane
    // keeps the half-space its normal points INTO (normal·p + constant ≥ 0), so the
    // kept normal is −axis (toward part_b). Everything on the part_a (+normal) side of
    // the wafer is hidden. No bias — clip exactly at the wafer plane.
    const keepNormalW = axisL.clone().applyMatrix3(normalMat).normalize().multiplyScalar(-1);
    return new THREE.Plane().setFromNormalAndCoplanarPoint(keepNormalW, anchorW);
  }, [keyFrame, cHasTransform, meshLocalOffset, ctpx, ctpy, ctpz, ctrx, ctry, ctrz, ctsx, ctsy, ctsz]);
  // Stable array for the material `clippingPlanes` prop (a new array each render
  // would churn the material every frame).
  const keyClipPlanes = useMemo(() => (keyClipPlane ? [keyClipPlane] : null), [keyClipPlane]);

  // Wireframe of the membrane so we can SEE the triangulation (verify the grid
  // remesh / spot slivers). Edges-only overlay on the translucent surface.
  const membraneWireframe = useMemo(() => {
    if (!membraneGeometry) return null;
    const wire = new THREE.WireframeGeometry(membraneGeometry);
    wire.computeBoundingSphere();
    return wire;
  }, [membraneGeometry]);

  // Marker radius proportional to the model so it's a small, precise dot on any
  // model size (a fixed mm value is wrong for small/large models). Also divided
  // by the model's max scale so on-plate scaling doesn't inflate the markers.
  const markerRadius = useMemo(() => {
    if (!activeModel) return MARKER_RADIUS_MIN;
    const geometry = activeModel.geometry.geometry;
    const bbox =
      geometry.boundingBox ??
      new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
    const diag = bbox.getSize(new THREE.Vector3()).length();
    const maxScale = transform
      ? Math.max(Math.abs(transform.scale.x), Math.abs(transform.scale.y), Math.abs(transform.scale.z), 1e-3)
      : 1;
    const r = (diag * MARKER_RADIUS_FRACTION) / maxScale;
    return Math.min(MARKER_RADIUS_MAX, Math.max(MARKER_RADIUS_MIN, r));
  }, [activeModel, transform]);

  // --- Drag-to-edit waypoints ------------------------------------------------
  // Invisible mesh carrying the model geometry, mounted in the SAME nested group
  // as the markers (so its local space == the loop-point space). We raycast the
  // dragged pointer against it to keep the waypoint glued to the surface, then
  // convert the world hit straight back to loop-point space via worldToLocal.
  const raycastMeshRef = useRef<THREE.Mesh | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  // Whether the in-progress marker drag actually moved (vs a click-in-place). A
  // press that doesn't move is treated as a SELECT on release, not a drag.
  const dragMovedRef = useRef(false);
  // True while the cursor is over the seam tube (arms right-click insertion).
  const [lineHovered, setLineHovered] = useState(false);

  // Highlight the seam line while hovered (the hover-to-arm affordance): brighten
  // the colour so the user sees it's targetable for "Add waypoint here".
  React.useEffect(() => {
    if (!loopLine) return;
    const mat = loopLine.material as THREE.LineBasicMaterial;
    mat.color.set(lineHovered ? 0xc8ffd8 : 0x37ff7a);
  }, [loopLine, lineHovered]);

  const modelGeometry = activeModel?.geometry.geometry ?? null;

  const handleMarkerPointerDown = useCallback(
    (index: number) => (e: ThreeEvent<PointerEvent>) => {
      // LEFT button only. Right-click (button 2) must fall through to the camera
      // (it's the orbit/rotate button) and middle (1) to pan — never start a drag.
      if (e.button !== 0) return;
      // Capture the pointer on the marker so every subsequent move/up routes here
      // regardless of what's under the cursor, and stop the event from reaching
      // the model-click / selection / orbit pipeline beneath. R3F augments the
      // event target (the marker object3D) with setPointerCapture.
      e.stopPropagation();
      try {
        (e.currentTarget as unknown as { setPointerCapture?: (id: number) => void })
          .setPointerCapture?.(e.pointerId);
      } catch {
        /* capture is best-effort; the drag still works via draggingIndex state */
      }
      dragMovedRef.current = false;
      setDraggingIndex(index);
      onDragStateChange?.(true);
      document.body.style.cursor = 'grabbing';
    },
    [onDragStateChange],
  );

  const handleMarkerPointerMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (draggingIndex === null) return;
      const mesh = raycastMeshRef.current;
      if (!mesh || !onUpdatePoint) return;
      e.stopPropagation();

      // e.ray is the world-space camera ray through the current pointer — valid
      // even though the event is captured by the marker. Re-raycast it against
      // the model surface to find where the dragged waypoint should land.
      const raycaster = raycasterRef.current;
      raycaster.set(e.ray.origin, e.ray.direction);
      const hits = raycaster.intersectObject(mesh, false);
      if (hits.length === 0) return; // off the model — keep the last good spot

      const hit = hits[0];
      mesh.updateWorldMatrix(true, false);
      const local = mesh.worldToLocal(hit.point.clone());
      const n = hit.face?.normal
        ? hit.face.normal.clone().normalize()
        : new THREE.Vector3(0, 0, 1);
      dragMovedRef.current = true; // an actual reposition happened → it's a drag
      onUpdatePoint(draggingIndex, {
        position: [local.x, local.y, local.z],
        normal: [n.x, n.y, n.z],
      });
    },
    [draggingIndex, onUpdatePoint],
  );

  const endDrag = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (draggingIndex === null) return;
      e.stopPropagation();
      try {
        const target = e.currentTarget as unknown as {
          hasPointerCapture?: (id: number) => boolean;
          releasePointerCapture?: (id: number) => void;
        };
        if (target.hasPointerCapture?.(e.pointerId)) {
          target.releasePointerCapture?.(e.pointerId);
        }
      } catch {
        /* best-effort release */
      }
      // A press that never moved is a CLICK → select this waypoint.
      if (!dragMovedRef.current) {
        onSelectPoint?.(draggingIndex);
      }
      setDraggingIndex(null);
      onDragStateChange?.(false);
      document.body.style.cursor = '';
    },
    [draggingIndex, onDragStateChange, onSelectPoint],
  );

  // Hover affordance: a grab cursor over a marker, grabbing while dragging.
  const handleMarkerPointerOver = useCallback((e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (draggingIndex === null) document.body.style.cursor = 'grab';
  }, [draggingIndex]);
  const handleMarkerPointerOut = useCallback(() => {
    if (draggingIndex === null) document.body.style.cursor = '';
  }, [draggingIndex]);

  // Compute the seam-insertion target for a pointer over the seam tube: the
  // model-local point ON THE SURFACE under the cursor (re-raycast the model, not
  // the floating tube — an off-surface point would mislocate the geodesic) and
  // the waypoint SEGMENT it falls on (afterIndex). Shared by hover (right-click
  // arm) and left-click (direct insert). Returns null if it can't resolve.
  const computeLineInsertion = useCallback(
    (e: ThreeEvent<PointerEvent>): { localPoint: [number, number, number]; afterIndex: number } | null => {
      const mesh = raycastMeshRef.current;
      if (!mesh) return null;
      mesh.updateWorldMatrix(true, false);
      const raycaster = raycasterRef.current;
      raycaster.set(e.ray.origin, e.ray.direction);
      const hits = raycaster.intersectObject(mesh, false);
      const worldHit = hits.length > 0 ? hits[0].point : e.point;
      const local = mesh.worldToLocal(worldHit.clone());

      // Nearest waypoint-pair segment to the point. For a closed loop the final
      // segment wraps last→first, so afterIndex === n-1 inserts at the end.
      const n = loop.length;
      let bestAfter = Math.max(0, n - 1);
      if (n >= 2) {
        const segCount = n >= 3 ? n : n - 1;
        let bestD = Infinity;
        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        const ab = new THREE.Vector3();
        for (let i = 0; i < segCount; i += 1) {
          const p0 = loop[i].position;
          const p1 = loop[(i + 1) % n].position;
          a.set(p0[0], p0[1], p0[2]);
          b.set(p1[0], p1[1], p1[2]);
          ab.copy(b).sub(a);
          const t = THREE.MathUtils.clamp(
            local.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-9),
            0,
            1,
          );
          const d = a.clone().addScaledVector(ab, t).distanceToSquared(local);
          if (d < bestD) {
            bestD = d;
            bestAfter = i;
          }
        }
      }
      return { localPoint: [local.x, local.y, local.z], afterIndex: bestAfter };
    },
    [loop],
  );

  const reportLineHover = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (!onLineHoverChange) return;
      onLineHoverChange(computeLineInsertion(e));
    },
    [onLineHoverChange, computeLineInsertion],
  );

  const handleLinePointerOver = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      setLineHovered(true);
      document.body.style.cursor = 'context-menu';
      reportLineHover(e);
    },
    [reportLineHover],
  );
  const handleLinePointerMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (draggingIndex !== null) return; // ignore while dragging a marker
      e.stopPropagation();
      // Also set hover here: R3F's onPointerOver doesn't always fire (e.g. when
      // the tube first appears under a stationary cursor), but move is reliable.
      setLineHovered(true);
      document.body.style.cursor = 'context-menu';
      reportLineHover(e);
    },
    [reportLineHover, draggingIndex],
  );
  const handleLinePointerOut = useCallback(() => {
    setLineHovered(false);
    document.body.style.cursor = '';
    onLineHoverChange?.(null);
  }, [onLineHoverChange]);

  // Left-click on the seam → insert a waypoint at the clicked point.
  const handleLineClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      if (!onLineClick) return;
      if (e.button !== undefined && e.button !== 0) return; // left only
      if (draggingIndex !== null) return;
      e.stopPropagation();
      const info = computeLineInsertion(e as unknown as ThreeEvent<PointerEvent>);
      if (info) onLineClick(info);
    },
    [onLineClick, computeLineInsertion, draggingIndex],
  );

  if (!activeModelId || !activeModel || !transform) return null;

  return (
    <group
      position={transform.position}
      quaternion={currentQuaternion}
      scale={transform.scale}
    >
      <group position={meshLocalOffset}>
        {/* Invisible copy of the model geometry used ONLY as a manual raycast
            target for dragging waypoints. Sharing this group's local space means
            a world hit converts straight back to loop-point space via
            worldToLocal. `visible={false}` keeps it from rendering AND keeps R3F's
            event system from dispatching to it — we intersect it by hand with our
            own raycaster (intersectObject works on invisible meshes). */}
        {modelGeometry && (
          <mesh ref={raycastMeshRef} geometry={modelGeometry} visible={false} />
        )}

        {/* Seam hover: a WIDE invisible hit tube (carries the pointer handlers /
            arms the right-click menu) plus a THIN visible glow tube (the
            highlight). Both must stay `visible` for R3F events; the hit tube
            paints nothing (colorWrite off), and the glow tube only shows when
            hovered. Separating them keeps the hitbox comfortably grabbable
            without fattening the visible highlight. */}
        {seamTubes && onLineHoverChange && (
          <>
            <mesh
              geometry={seamTubes.hit}
              renderOrder={995}
              frustumCulled={false}
              onPointerOver={handleLinePointerOver}
              onPointerMove={handleLinePointerMove}
              onPointerOut={handleLinePointerOut}
              onClick={handleLineClick}
            >
              <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
            </mesh>
            <mesh geometry={seamTubes.glow} renderOrder={996} frustumCulled={false}>
              <meshBasicMaterial
                color={0xeafff0}
                transparent
                opacity={lineHovered ? 0.85 : 0}
                depthTest={false}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
          </>
        )}

        {/* Contour membrane preview: the exact curved cutter surface. */}
        {membraneGeometry && (
          <mesh geometry={membraneGeometry} renderOrder={997} frustumCulled={false}>
            <meshBasicMaterial
              color={0x37ff7a}
              transparent
              opacity={0.25}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
        )}

        {/* Wireframe overlay so the triangulation (grid remesh) is visible. */}
        {membraneWireframe && (
          <lineSegments geometry={membraneWireframe} renderOrder={998} frustumCulled={false}>
            <lineBasicMaterial
              color={0xcccccc}
              transparent
              opacity={0.15}
              depthTest={false}
              depthWrite={false}
            />
          </lineSegments>
        )}

        {/* Registration-key preview (peg + socket) — amber so it reads distinctly
            from the green membrane. `depthTest={false}` so it always draws THROUGH
            the model (an X-ray overlay), like the membrane wireframe — the key is
            mostly buried inside the body, so without this it'd be hidden.

            The soup is built STRAIGHT (un-tilted) in Rust; the live tilt is applied
            here as a rigid rotation matrix about the base, so the aim gizmo moves the
            key instantly with no Rust round-trip. Wrapped in a group carrying that
            matrix (identity when un-tilted). It's CLIPPED at the wafer so only the
            portion going into the body (part_b side) shows — not the overhang above. */}
        {keyGeometry && (
          <group
            matrixAutoUpdate={false}
            ref={(g) => {
              if (!g) return;
              if (keyTiltMatrix) g.matrix.copy(keyTiltMatrix);
              else g.matrix.identity();
              g.matrixWorldNeedsUpdate = true;
            }}
          >
            <mesh geometry={keyGeometry} renderOrder={1000} frustumCulled={false}>
              <meshBasicMaterial
                color={0xffa630}
                transparent
                opacity={0.4}
                side={THREE.DoubleSide}
                depthTest={false}
                depthWrite={false}
                clippingPlanes={keyClipPlanes}
              />
            </mesh>
            {/* Key edge outline so the peg/socket 3D form reads through the model. */}
            {keyWireframe && (
              <lineSegments geometry={keyWireframe} renderOrder={1001} frustumCulled={false}>
                <lineBasicMaterial
                  color={0xff7a00}
                  transparent
                  opacity={0.9}
                  depthTest={false}
                  depthWrite={false}
                  clippingPlanes={keyClipPlanes}
                />
              </lineSegments>
            )}
          </group>
        )}

        {/* Live translucent cut-plane preview (what the slice will look like). */}
        {planePreview && (
          <mesh
            position={planePreview.position}
            quaternion={planePreview.quat}
            renderOrder={998}
          >
            <planeGeometry args={[planePreview.span, planePreview.span]} />
            <meshBasicMaterial
              color={0x37ff7a}
              transparent
              opacity={0.22}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
        )}

        {/* Placed loop points. First point is green (closure target), rest amber.
            Dragging → cyan. SELECTED → blue (the waypoint Delete/right-click will
            remove). Each marker is draggable: a press that moves repositions it; a
            press that doesn't is a select. */}
        {cutMode !== 'bounded_plane' && loop.map((p, idx) => {
          const isDragging = draggingIndex === idx;
          const isSelected = selectedIndex === idx;
          const color = isSelected
            ? 0x0091ff
            : isDragging
              ? 0x35e3ff
              : idx === 0
                ? 0x37ff7a
                : 0xffd24a;
          const scale = isDragging ? 1.5 : 1;
          // A larger invisible hit-sphere makes the small dots easy to grab.
          const hitRadius = markerRadius * 4;
          // Markers stay at the TRUE surface position (NOT lifted to the wafer
          // edge): the click/drag pipeline raycasts the surface and stores the
          // surface point, so the interactive geometry must sit exactly there or
          // grabbing/placing drifts from the cursor. The 0.1mm gap to the lifted
          // seam line is sub-pixel and not noticeable.
          return (
            <group key={idx} position={[p.position[0], p.position[1], p.position[2]]}>
              {/* Generous invisible grab/click/hover target. */}
              <mesh
                renderOrder={1000}
                onPointerDown={handleMarkerPointerDown(idx)}
                onPointerMove={handleMarkerPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onPointerOver={(e) => { handleMarkerPointerOver(e); onMarkerHoverChange?.(idx); }}
                onPointerOut={() => { handleMarkerPointerOut(); onMarkerHoverChange?.(null); }}
              >
                <sphereGeometry args={[hitRadius, 12, 12]} />
                <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
              </mesh>
              {/* Visible dot. */}
              <mesh renderOrder={1002} scale={scale}>
                <sphereGeometry args={[markerRadius, 16, 16]} />
                <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.95} />
              </mesh>
            </group>
          );
        })}

        {/* Connecting polyline through the points (and closing segment). */}
        {cutMode !== 'bounded_plane' && loopLine && <primitive object={loopLine} />}
      </group>
    </group>
  );
}

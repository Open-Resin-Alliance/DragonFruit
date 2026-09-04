import React, { useCallback, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import type { TenonPreviewFrame, OrganicCutLoopPoint, OrganicCutMode } from './types';
import { cutPlaneFromPoints } from './cutPlane';
import { tenonLeanMatrix } from './tenonLeanTransform';
import type { PlaneMeshCurve } from './planeMeshIntersection';
import { useOrganicCutColorNumbers } from './useOrganicCutColors';
import { TENON_WONT_FIT_COLORS } from './organicCutColors';
import { CutLeakPins } from './CutLeakPins';

interface OrganicCutToolProps {
  models: LoadedModel[];
  activeModelId: string | null;
  activeTransform?: ModelTransform;
  /** Whether the tool is interactive (false while applying). Reserved for future use. */
  active: boolean;
  /**
   * Where the last refused cut went wrong, model-local. Drawn as bright markers on
   * the surface, because this is the one thing the user cannot work out for
   * themselves: a coordinate in the panel text names a place they have no way to
   * find. Empty when the last cut succeeded or was never made.
   */
  cutLeakPoints?: [number, number, number][];
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
   * Toggle a waypoint's locked (pinned) state — double-click a marker. A locked
   * point is left untouched by Snap to Edges, so a point sitting exactly where
   * it's needed can't be dragged off onto a nearby edge.
   */
  onToggleLockPoint?: (index: number) => void;
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
   * PLANE mode only: the curves where the cutting plane meets the mesh. This is
   * the seam the flat cut actually produces, so it is drawn as the real result
   * while the waypoint chords above only show what the user placed.
   */
  planeCurves?: PlaneMeshCurve[] | null;
  /**
   * Seam polylines (flat xyz, model-local) of the INACTIVE loops in a multi-loop
   * cut. Drawn dimmed so the user sees every loop the Cut will sever, alongside the
   * active loop being drawn/edited. Empty/undefined when there's only one loop.
   */
  inactiveLoopPolylines?: Float32Array[];
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
   * Registration-tenon preview as a flat triangle soup (model-local): the tenon AND
   * mortise the cut will place. Rendered translucent in a distinct color so the
   * user sees the tenon straddling the cut before committing.
   */
  tenonPreview?: Float32Array | null;
  /**
   * How many of `tenonPreview`'s triangles are the TENON. The soup is the tenon
   * followed by the mortise, and they are drawn in different colours — without
   * that the Fit Tolerance knob looks dead, since it only grows the mortise.
   */
  tenonTriangleCount?: number;
  /**
   * Whether the previewed tenon fits where it sits. When false the tenon is drawn
   * in [`TENON_WONT_FIT_COLORS`] instead of its own — it is still drawn, and still
   * carries its gizmo, so the user can move it somewhere it does fit.
   */
  tenonFits?: boolean;
  /**
   * Placement frame of the previewed tenon (model-local). The tenon SOUP is built
   * UN-tilted (straight); the tilt is applied LIVE as a rigid rotation of the tenon
   * mesh here, so dragging the aim gizmo moves the tenon instantly with no Rust
   * round-trip. Null when no tenon. (The real cut bakes the tilt in Rust.)
   */
  tenonFrame?: TenonPreviewFrame | null;
  /**
   * Where the tenon has been dragged to, as a model-local point. While the handle
   * is dragged the soup is NOT rebuilt (that would be a Rust round-trip per frame),
   * so the difference between this and the built frame's own anchor is applied here
   * as a translation — which is what makes the tenon follow the handle instead of
   * jumping when the drag ends.
   */
  tenonAnchor?: [number, number, number] | null;
  /** Live tenon lean / roll (radians) for the client-side rotation. */
  tenonTiltRad?: number;
  tenonRollRad?: number;
  /**
   * Show the translucent cut-plan preview surfaces (the flat plane quad, the
   * contour membrane + its wireframe, and the registration tenon). When false,
   * only the seam line + loop markers (the editable handles) draw, so the model
   * is unobscured. Default true.
   */
  showPreview?: boolean;
}

/** Marker radius as a fraction of the model's bbox diagonal (small = precise). */
const MARKER_RADIUS_FRACTION = 0.00075;
/** Clamp the marker radius (model-local units) so it's usable on any model size. */
const MARKER_RADIUS_MIN = 0.005;
const MARKER_RADIUS_MAX = 0.3;

/**
 * How much of its own opacity an overlay keeps where the model hides it.
 *
 * The seam and its waypoints used to draw with the depth test off entirely, so a
 * point on the far side of the model looked exactly like one on this side — it
 * read as reachable, and the cursor went straight through it to the surface
 * behind. Everything on the surface is now drawn TWICE: solid where the camera
 * can see it, and this faint underneath, so a buried point still says where it
 * is without pretending to be in front.
 */
const OCCLUDED_OPACITY_FACTOR = 0.22;

/**
 * Depth nudge toward the camera, in NDC z, for overlays that sit exactly ON the
 * surface (the seam line). With a plain depth test the triangles it lies on win
 * roughly half its pixels and stipple the line into dashes. Biasing in clip
 * space — rather than along each point's normal, which pushed the line off the
 * markers in a different direction at every vertex — moves it toward the eye by
 * the same amount from every angle.
 */
const SURFACE_DEPTH_BIAS = 2e-4;

/** Patch a material's vertex shader to apply {@link SURFACE_DEPTH_BIAS}. */
function biasTowardCamera(material: THREE.Material): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      gl_Position.z -= ${SURFACE_DEPTH_BIAS} * gl_Position.w;`,
    );
  };
}

/**
 * How far ABOVE its own render order the seam's solid pass is drawn, so it lands
 * above the tenon and mortise previews (990-1001).
 *
 * Those previews draw with the depth test off, so nothing they cover can win on
 * depth — whatever draws first loses, and the seam drew first. The stretch of
 * seam the camera can actually see was painted over by the tenon crossing in
 * front of it. Lifting only the SOLID pass keeps the depth cue intact: the near
 * side of the seam draws over the tenon, while the faint ghost pass — the "this
 * bit is round the back" cue — stays underneath it, where it belongs.
 */
const SEAM_SOLID_ABOVE_TENON = 8;

/**
 * A seam polyline as the depth-cue pair described at
 * {@link OCCLUDED_OPACITY_FACTOR}: the ghost pass (no depth test) under a solid
 * pass (depth-tested, biased off the surface). Both share one geometry.
 */
function occludedLinePair(
  positions: number[],
  color: number,
  opacity: number,
  renderOrder: number,
): THREE.Group {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const ghost = new THREE.Line(
    geom,
    new THREE.LineBasicMaterial({
      color,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: opacity * OCCLUDED_OPACITY_FACTOR,
    }),
  );
  ghost.renderOrder = renderOrder;
  const solid = new THREE.Line(
    geom,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
  );
  biasTowardCamera(solid.material);
  solid.renderOrder = renderOrder + SEAM_SOLID_ABOVE_TENON;
  const group = new THREE.Group();
  group.add(ghost, solid);
  return group;
}

/**
 * Free a GPU resource once React has swapped in its replacement.
 *
 * Every seam edit rebuilds the membrane, the seam tubes and the tenon preview, and
 * three.js keeps the old buffers on the GPU until something disposes them. Nothing
 * did: an afternoon of dragging waypoints leaked every intermediate mesh. `useMemo`
 * has no teardown, so the disposal rides an effect tenoned on the value itself —
 * which runs AFTER the new one is on screen, so the object being freed is never the
 * one being drawn.
 */
function useDisposeWhenReplaced(value: { dispose: () => void } | null): void {
  React.useEffect(() => {
    if (!value) return;
    return () => value.dispose();
  }, [value]);
}

/** {@link useDisposeWhenReplaced} for a whole object graph (a Group, a Line). */
function useDisposeTreeWhenReplaced(root: THREE.Object3D | THREE.Object3D[] | null): void {
  React.useEffect(() => {
    if (!root) return;
    const roots = Array.isArray(root) ? root : [root];
    return () => {
      for (const r of roots) {
        r.traverse((node) => {
          const holder = node as Partial<THREE.Mesh>;
          holder.geometry?.dispose();
          const material = holder.material;
          if (Array.isArray(material)) material.forEach((m) => m.dispose());
          else material?.dispose();
        });
      }
    };
  }, [root]);
}

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
  cutLeakPoints,
  loop,
  onUpdatePoint,
  onDragStateChange,
  onLineHoverChange,
  onLineClick,
  selectedIndex = null,
  onSelectPoint,
  onToggleLockPoint,
  onMarkerHoverChange,
  geodesicPolyline,
  planeCurves,
  inactiveLoopPolylines,
  cutMode = 'plane',
  membranePreview,
  tenonPreview,
  tenonTriangleCount = 0,
  tenonFits = true,
  tenonFrame,
  tenonAnchor,
  tenonTiltRad = 0,
  tenonRollRad = 0,
  showPreview = true,
}: OrganicCutToolProps) {
  // Every colour this tool paints with, from the saved preference (see
  // organicCutColors.ts). Changing one repaints without a reload.
  const colors = useOrganicCutColorNumbers();
  // A tenon that can't be placed is painted as a status, not as itself: its three
  // colours are replaced wholesale so it reads as wrong from any angle, not as a
  // tenon with an odd outline. See TENON_WONT_FIT_COLORS.
  const tenonColors = useMemo(
    () =>
      tenonFits
        ? { front: colors.tenonFront, back: colors.tenonBack, edge: colors.tenonEdge }
        : {
            front: parseInt(TENON_WONT_FIT_COLORS.front.slice(1), 16),
            back: parseInt(TENON_WONT_FIT_COLORS.back.slice(1), 16),
            edge: parseInt(TENON_WONT_FIT_COLORS.edge.slice(1), 16),
          },
    [tenonFits, colors.tenonFront, colors.tenonBack, colors.tenonEdge],
  );
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
      // Straight chords through the waypoints EXACTLY where the markers are. The
      // line renders with depthTest:false, so there is no z-fighting to bias
      // away from — and biasing along each point's own normal pushed the line off
      // the markers by a different direction at every vertex.
      positions = [];
      const push = (p: OrganicCutLoopPoint) => {
        positions!.push(p.position[0], p.position[1], p.position[2]);
      };
      for (const p of loop) push(p);
      if (loop.length >= 3) push(loop[0]);
    }
    return positions && positions.length >= 6 ? positions : null;
  }, [loop, geodesicPolyline]);

  // PLANE mode: the plane ∩ mesh curves — where the flat cut really lands. Drawn
  // in amber so they read as "the result" against the green waypoint chords, and
  // as an occluded pair so the far side of the curve stays visible but dim.
  const planeCurveLines = useMemo(() => {
    if (cutMode !== 'plane' || !planeCurves || planeCurves.length === 0) return [];
    return planeCurves
      .map((curve) => {
        if (curve.points.length < 6) return null;
        const positions = Array.from(curve.points);
        // A closed curve omits the repeat of its first point; append it so the
        // loop draws shut instead of showing a gap.
        if (curve.closed) {
          positions.push(positions[0], positions[1], positions[2]);
        }
        return occludedLinePair(positions, colors.seam, 0.95, 998);
      })
      .filter((l) => l !== null);
  }, [cutMode, planeCurves, colors]);

  const loopLine = useMemo(() => {
    const positions = loopPositions;
    if (!positions || positions.length < 6) return null;
    return occludedLinePair(positions, colors.seam, 1, 999);
  }, [loopPositions, colors]);

  // Dimmed seam lines for the INACTIVE loops of a multi-loop cut. Each is drawn
  // closed (the geodesic omits the repeated final point) in a muted green so it
  // reads as an inactive loop next to the bright active one.
  const inactiveSeamLines = useMemo(() => {
    if (!inactiveLoopPolylines || inactiveLoopPolylines.length === 0) return [];
    return inactiveLoopPolylines
      .map((poly) => {
        if (!poly || poly.length < 6) return null;
        const positions = Array.from(poly);
        // Close the loop: append the first vertex if the end isn't already on it.
        if (poly.length >= 9) {
          const dx = positions[positions.length - 3] - positions[0];
          const dy = positions[positions.length - 2] - positions[1];
          const dz = positions[positions.length - 1] - positions[2];
          if (dx * dx + dy * dy + dz * dz > 1e-10) {
            positions.push(positions[0], positions[1], positions[2]);
          }
        }
        return occludedLinePair(positions, colors.seamInactive, 0.7, 994);
      })
      .filter((l): l is THREE.Group => l !== null);
  }, [inactiveLoopPolylines, colors]);

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
    // In contour mode the cut is curved — a flat quad would mislead. Hide it.
    if (cutMode === 'contour') return null;
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

  // Translucent membrane (curved cutter surface) for contour mode. Built from the
  // flat triangle soup Rust returns, so it's EXACTLY the surface the cut uses.
  // Everything above is rebuilt on every seam edit; hand the old buffers back to
  // the GPU once the new ones are on screen.
  useDisposeTreeWhenReplaced(loopLine);
  useDisposeTreeWhenReplaced(inactiveSeamLines);
  useDisposeTreeWhenReplaced(planeCurveLines);
  useDisposeWhenReplaced(seamTubes?.glow ?? null);
  useDisposeWhenReplaced(seamTubes?.hit ?? null);

  const membraneGeometry = useMemo(() => {
    if (cutMode !== 'contour' || !membranePreview || membranePreview.length < 9) return null;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(membranePreview, 3));
    geom.computeVertexNormals();
    // Without a bounding sphere three.js frustum-culls the mesh (treats it as
    // off-screen) → it never draws. Compute it so the membrane is visible.
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    return geom;
  }, [cutMode, membranePreview]);

  // Registration-tenon preview, in BOTH cut modes. Built from the flat soup Rust
  // returns, so it's EXACTLY the tenon the cut will place — the flat cut's tenon is
  // framed on the plane, the contour's on the membrane, but both arrive here the
  // same way.
  //
  // The soup holds the tenon first and the mortise after it, and they are drawn as
  // two geometries in two colours. Together they sit almost on top of each other
  // (the mortise IS the tenon plus the fit tolerance), so in one colour the Fit
  // Tolerance field read as dead: the thing it grows is the mortise, and the tenon
  // never budges.
  const [tenonGeometry, mortiseGeometry] = useMemo(() => {
    if (!tenonPreview || tenonPreview.length < 9) return [null, null];
    const build = (data: Float32Array) => {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(data, 3));
      geom.computeVertexNormals();
      geom.computeBoundingBox();
      geom.computeBoundingSphere();
      return geom;
    };
    // No split reported (an older backend, or a soup that is tenon-only) → draw it
    // all as the tenon rather than dropping half the tenon on the floor.
    const split = Math.min(Math.max(tenonTriangleCount, 0) * 9, tenonPreview.length);
    if (split === 0 || split === tenonPreview.length) return [build(tenonPreview), null];
    return [build(tenonPreview.subarray(0, split)), build(tenonPreview.subarray(split))];
  }, [tenonPreview, tenonTriangleCount]);

  // Edge outlines so each 3D form (the tapered box / dome) reads even as a flat
  // depth-test-off overlay. EdgesGeometry keeps only the sharp silhouette edges
  // (not every triangle), so the shape is clear, not a mess.
  const tenonWireframe = useMemo(() => {
    if (!tenonGeometry) return null;
    const edges = new THREE.EdgesGeometry(tenonGeometry, 20);
    edges.computeBoundingSphere();
    return edges;
  }, [tenonGeometry]);
  const mortiseWireframe = useMemo(() => {
    if (!mortiseGeometry) return null;
    const edges = new THREE.EdgesGeometry(mortiseGeometry, 20);
    edges.computeBoundingSphere();
    return edges;
  }, [mortiseGeometry]);

  // LIVE tenon lean/roll (model-local world space), applied to the straight soup so
  // dragging the gizmo never round-trips to Rust. The maths is in
  // `tenonLeanTransform` — it has to mirror Rust's LeanXform sign for sign, so it
  // lives where it can be tested.
  const tenonTiltMatrix = useMemo(
    () => (tenonFrame ? tenonLeanMatrix(tenonFrame, tenonTiltRad, tenonRollRad) : null),
    [tenonFrame, tenonTiltRad, tenonRollRad],
  );

  /**
   * Carries the built tenon to where it has been dragged, until the next preview
   * arrives with it built there. Both are POINTS in the same space, so this is
   * their plain difference — no basis to pick and none to get wrong. (It used to
   * be a displacement along the frame's u/v, which is what made the stand-in tenon
   * set off at an angle to where the real one was going.)
   */
  const tenonOffsetMatrix = useMemo(() => {
    if (!tenonFrame || !tenonAnchor) return null;
    const from = new THREE.Vector3(...tenonFrame.anchor);
    const to = new THREE.Vector3(...tenonAnchor);
    const d = to.sub(from);
    if (d.lengthSq() < 1e-12) return null;
    return new THREE.Matrix4().makeTranslation(d.x, d.y, d.z);
  }, [tenonFrame, tenonAnchor]);

  // Clip the tenon preview AT THE WAFER: hide everything on the part_a (+normal) side
  // of the cut plane, so the preview shows only the portion that actually goes into
  // the body (below the wafer) — not the full tenon poking up above it. The wafer plane
  // is FIXED (it doesn't tilt with the tenon); as the tenon leans, its part_a-side
  // overhang is clipped by this stationary plane. The plane is in WORLD space (where
  // three.js clipping planes operate), so we transform the local tenon frame to world.
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
  const tenonClipPlane = useMemo(() => {
    if (!tenonFrame || !cHasTransform) return null;
    const anchorL = new THREE.Vector3(...tenonFrame.anchor);
    const axisL = new THREE.Vector3(...tenonFrame.axis).normalize();
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
    // Keep the part_b side (where the tenon extrudes into the body): a clipping plane
    // keeps the half-space its normal points INTO (normal·p + constant ≥ 0), so the
    // kept normal is −axis (toward part_b). Everything on the part_a (+normal) side of
    // the wafer is hidden. No bias — clip exactly at the wafer plane.
    const keepNormalW = axisL.clone().applyMatrix3(normalMat).normalize().multiplyScalar(-1);
    return new THREE.Plane().setFromNormalAndCoplanarPoint(keepNormalW, anchorW);
  }, [tenonFrame, cHasTransform, meshLocalOffset, ctpx, ctpy, ctpz, ctrx, ctry, ctrz, ctsx, ctsy, ctsz]);
  // Stable array for the material `clippingPlanes` prop (a new array each render
  // would churn the material every frame).
  const tenonClipPlanes = useMemo(() => (tenonClipPlane ? [tenonClipPlane] : null), [tenonClipPlane]);

  // Wireframe of the membrane so we can SEE the triangulation (verify the grid
  // remesh / spot slivers). Edges-only overlay on the translucent surface.
  const membraneWireframe = useMemo(() => {
    if (!membraneGeometry) return null;
    const wire = new THREE.WireframeGeometry(membraneGeometry);
    wire.computeBoundingSphere();
    return wire;
  }, [membraneGeometry]);

  useDisposeWhenReplaced(membraneGeometry);
  useDisposeWhenReplaced(membraneWireframe);
  useDisposeWhenReplaced(tenonGeometry);
  useDisposeWhenReplaced(mortiseGeometry);
  useDisposeWhenReplaced(tenonWireframe);
  useDisposeWhenReplaced(mortiseWireframe);

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
    // Both passes of the pair (ghost + solid) recolour together.
    for (const pass of loopLine.children) {
      const mat = (pass as THREE.Line).material as THREE.LineBasicMaterial;
      mat.color.set(lineHovered ? colors.seamHover : colors.seam);
    }
  }, [loopLine, lineHovered, colors]);

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

  /**
   * Did the press that produced this click START on the seam?
   *
   * A click is delivered on release, to whatever is under the pointer THEN. Aim the
   * tenon with the gizmo while its rings happen to lie over the seam, let go, and
   * the seam collected a click it never saw the press for — so a waypoint appeared
   * out of nowhere, mid-way through aiming. Inserting on the seam is a deliberate
   * act: it takes a press and a release, both here.
   */
  const pressStartedOnLine = useRef(false);
  const handleLinePointerDown = useCallback((e: ThreeEvent<PointerEvent>) => {
    pressStartedOnLine.current = e.button === 0;
  }, []);

  // Left-click on the seam → insert a waypoint at the clicked point.
  const handleLineClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      const started = pressStartedOnLine.current;
      pressStartedOnLine.current = false;
      if (!onLineClick || !started) return;
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
              onPointerDown={handleLinePointerDown}
              onClick={handleLineClick}
            >
              <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
            </mesh>
            <mesh geometry={seamTubes.glow} renderOrder={996} frustumCulled={false}>
              <meshBasicMaterial
                color={colors.seamGlow}
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
        {showPreview && membraneGeometry && (
          <mesh geometry={membraneGeometry} renderOrder={997} frustumCulled={false}>
            <meshBasicMaterial
              color={colors.cutSurface}
              transparent
              opacity={0.25}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
        )}

        {/* Wireframe overlay so the triangulation (grid remesh) is visible. */}
        {showPreview && membraneWireframe && (
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

        {/* Registration-tenon preview (the tenon) — amber so it reads distinctly
            from the green membrane. `depthTest={false}` so it always draws THROUGH
            the model (an X-ray overlay), like the membrane wireframe — the tenon is
            mostly buried inside the body, so without this it'd be hidden.

            The soup is built STRAIGHT (un-tilted) in Rust; the live tilt is applied
            here as a rigid rotation matrix about the base, so the aim gizmo moves the
            tenon instantly with no Rust round-trip. Wrapped in a group carrying that
            matrix (identity when un-tilted). It's CLIPPED at the wafer so only the
            portion going into the body (part_b side) shows — not the overhang above. */}
        {showPreview && tenonGeometry && (
          <group
            matrixAutoUpdate={false}
            ref={(g) => {
              if (!g) return;
              // Slide first, then lean: the lean pivots about the anchor, so
              // applying the translation on the OUTSIDE keeps the aim unchanged.
              if (tenonTiltMatrix) g.matrix.copy(tenonTiltMatrix);
              else g.matrix.identity();
              if (tenonOffsetMatrix) g.matrix.premultiply(tenonOffsetMatrix);
              g.matrixWorldNeedsUpdate = true;
            }}
          >
            {/* Drawn in TWO passes, back faces then front, instead of one
                double-sided one. A flat translucent solid with no depth testing is
                a Necker cube: every face is the same colour, nothing says which is
                nearer, and after a few seconds the tenon reads inside-out. Shading
                the far side darker gives the eye the cue the depth buffer isn't
                providing — and since both passes are unlit, it holds from every
                camera angle instead of depending on where the lights are. */}
            <mesh geometry={tenonGeometry} renderOrder={999} frustumCulled={false}>
              <meshBasicMaterial
                color={tenonColors.back}
                transparent
                opacity={0.5}
                side={THREE.BackSide}
                depthTest={false}
                depthWrite={false}
                clippingPlanes={tenonClipPlanes}
              />
            </mesh>
            <mesh geometry={tenonGeometry} renderOrder={1000} frustumCulled={false}>
              <meshBasicMaterial
                color={tenonColors.front}
                transparent
                opacity={0.7}
                side={THREE.FrontSide}
                depthTest={false}
                depthWrite={false}
                clippingPlanes={tenonClipPlanes}
              />
            </mesh>
            {/* The MORTISE, under the tenon (lower renderOrder) and fainter: it
                encloses the tenon — it is the tenon grown by the fit tolerance — so
                drawn on top or at equal weight it would swallow it. Seeing the
                gap between the two IS the Fit Tolerance readout. */}
            {mortiseGeometry && (
              <>
                <mesh geometry={mortiseGeometry} renderOrder={990} frustumCulled={false}>
                  <meshBasicMaterial
                    color={colors.mortiseBack}
                    transparent
                    opacity={0.25}
                    side={THREE.BackSide}
                    depthTest={false}
                    depthWrite={false}
                    clippingPlanes={tenonClipPlanes}
                  />
                </mesh>
                <mesh geometry={mortiseGeometry} renderOrder={991} frustumCulled={false}>
                  <meshBasicMaterial
                    color={colors.mortiseFront}
                    transparent
                    opacity={0.35}
                    side={THREE.FrontSide}
                    depthTest={false}
                    depthWrite={false}
                    clippingPlanes={tenonClipPlanes}
                  />
                </mesh>
                {mortiseWireframe && (
                  <lineSegments geometry={mortiseWireframe} renderOrder={992} frustumCulled={false}>
                    <lineBasicMaterial
                      color={colors.mortiseEdge}
                      transparent
                      opacity={0.6}
                      depthTest={false}
                      depthWrite={false}
                      clippingPlanes={tenonClipPlanes}
                    />
                  </lineSegments>
                )}
              </>
            )}
            {/* Tenon edge outline so its 3D form reads through the model. */}
            {tenonWireframe && (
              <lineSegments geometry={tenonWireframe} renderOrder={1001} frustumCulled={false}>
                <lineBasicMaterial
                  color={tenonColors.edge}
                  transparent
                  opacity={0.9}
                  depthTest={false}
                  depthWrite={false}
                  clippingPlanes={tenonClipPlanes}
                />
              </lineSegments>
            )}
          </group>
        )}


        {/* Live translucent cut-plane preview (what the slice will look like). */}
        {showPreview && planePreview && (
          <mesh
            position={planePreview.position}
            quaternion={planePreview.quat}
            renderOrder={998}
          >
            <planeGeometry args={[planePreview.span, planePreview.span]} />
            <meshBasicMaterial
              color={colors.cutSurface}
              transparent
              opacity={0.22}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
        )}

        {/* Placed loop points. First point is green (closure target), rest amber.
            Dragging → cyan. SELECTED → blue (the waypoint Delete/right-click will
            remove). A LOCKED (pinned) point wears a white wireframe cage and won't
            be moved by Snap to Edges. Each marker is draggable: a press that moves
            repositions it; a press that doesn't is a select; a double-click toggles
            the lock. */}
        {/* Where the last refused cut went wrong, pinned rather than blobbed: the
            user is being told to nudge the seam across these exact spots, so what
            marks them must not cover them. See `CutLeakPins`. */}
        <CutLeakPins points={cutLeakPoints ?? []} />

        {loop.map((p, idx) => {
          const isDragging = draggingIndex === idx;
          const isSelected = selectedIndex === idx;
          const isLocked = !!p.locked;
          const color = isSelected
            ? colors.markerSelected
            : isDragging
              ? colors.markerDragging
              : idx === 0
                ? colors.markerFirst
                : colors.markerPoint;
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
                onDoubleClick={(e) => { e.stopPropagation(); onToggleLockPoint?.(idx); }}
                onPointerOver={(e) => { handleMarkerPointerOver(e); onMarkerHoverChange?.(idx); }}
                onPointerOut={() => { handleMarkerPointerOut(); onMarkerHoverChange?.(null); }}
              >
                <sphereGeometry args={[hitRadius, 12, 12]} />
                <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
              </mesh>
              {/* Visible dot, drawn as the occluded pair: the ghost carries
                  through the model, the solid one only where the dot is really
                  in front. The sphere straddles the surface, so its outer half
                  clears the depth test with no bias needed. */}
              <mesh renderOrder={1002} scale={scale}>
                <sphereGeometry args={[markerRadius, 16, 16]} />
                <meshBasicMaterial
                  color={color}
                  depthTest={false}
                  depthWrite={false}
                  transparent
                  opacity={0.95 * OCCLUDED_OPACITY_FACTOR}
                />
              </mesh>
              <mesh renderOrder={1003} scale={scale}>
                <sphereGeometry args={[markerRadius, 16, 16]} />
                <meshBasicMaterial color={color} transparent opacity={0.95} />
              </mesh>
              {/* Locked (pinned) cage: a white wireframe sphere — orientation-free,
                  so it reads as "pinned" from any angle — that Snap to Edges spares.
                  Same two passes as the dot it wraps. */}
              {isLocked && (
                <>
                <mesh renderOrder={1004} scale={scale}>
                  <sphereGeometry args={[markerRadius * 1.9, 10, 8]} />
                  <meshBasicMaterial
                    color={0xffffff}
                    wireframe
                    depthTest={false}
                    depthWrite={false}
                    transparent
                    opacity={0.85 * OCCLUDED_OPACITY_FACTOR}
                  />
                </mesh>
                <mesh renderOrder={1005} scale={scale}>
                  <sphereGeometry args={[markerRadius * 1.9, 10, 8]} />
                  <meshBasicMaterial color={0xffffff} wireframe transparent opacity={0.85} />
                </mesh>
                </>
              )}
            </group>
          );
        })}

        {/* Inactive multi-loop seams (dimmed), drawn behind the active loop. */}
        {inactiveSeamLines.map((line, i) => (
          <primitive key={`inactive-seam-${i}`} object={line} />
        ))}

        {/* Connecting polyline through the points (and closing segment). */}
        {loopLine && <primitive object={loopLine} />}

        {/* Plane-mode seam: the real plane ∩ mesh intersection curve(s). */}
        {planeCurveLines.map((line, i) => (
          <primitive key={`plane-curve-${i}`} object={line} />
        ))}
      </group>
    </group>
  );
}

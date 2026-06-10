import React, { useMemo } from 'react';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import type { OrganicCutLoopPoint } from './types';
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
   * Surface-following loop polyline (flat xyz, model-local) from the Rust geodesic
   * engine. When present, it's drawn instead of straight chords so the seam hugs
   * the surface. Null until ≥2 points / outside Tauri.
   */
  geodesicPolyline?: Float32Array | null;
}

/** Marker radius as a fraction of the model's bbox diagonal (small = precise). */
const MARKER_RADIUS_FRACTION = 0.0015;
/** Clamp the marker radius (model-local units) so it's usable on any model size. */
const MARKER_RADIUS_MIN = 0.01;
const MARKER_RADIUS_MAX = 0.6;
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
  geodesicPolyline,
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
  const loopLine = useMemo(() => {
    let positions: number[] | null = null;

    if (geodesicPolyline && geodesicPolyline.length >= 6) {
      // The geodesic polyline already hugs the surface; nudge slightly outward is
      // unnecessary (it sits on vertices). Use as-is.
      positions = Array.from(geodesicPolyline);
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

    if (!positions || positions.length < 6) return null;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({ color: 0x37ff7a, depthTest: false, transparent: true });
    const line = new THREE.Line(geom, material);
    line.renderOrder = 999;
    return line;
  }, [loop, geodesicPolyline]);

  // Live cut-plane preview: a translucent quad showing EXACTLY where the slice
  // lands, from the same plane formula the cut uses. Sized to span the model.
  const planePreview = useMemo(() => {
    if (!activeModel) return null;
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
  }, [activeModel, loop]);

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

  if (!activeModelId || !activeModel || !transform) return null;

  return (
    <group
      position={transform.position}
      quaternion={currentQuaternion}
      scale={transform.scale}
    >
      <group position={meshLocalOffset}>
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

        {/* Placed loop points. First point is green (closure target), rest amber. */}
        {loop.map((p, idx) => (
          <mesh key={idx} position={[p.position[0], p.position[1], p.position[2]]} renderOrder={999}>
            <sphereGeometry args={[markerRadius, 16, 16]} />
            <meshBasicMaterial color={idx === 0 ? 0x37ff7a : 0xffd24a} depthTest={false} transparent opacity={0.95} />
          </mesh>
        ))}

        {/* Connecting polyline through the points (and closing segment). */}
        {loopLine && <primitive object={loopLine} />}
      </group>
    </group>
  );
}

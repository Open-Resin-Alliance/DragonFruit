'use client';

import React from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import {
  getMeshSmoothingBrushState,
  subscribeToMeshSmoothingBrushState,
} from './brushController';
import {
  getMeshSmoothingSettings,
  subscribeToMeshSmoothingSettings,
} from './settings';

export function MeshSmoothingBrushCursor() {
  const brushState = React.useSyncExternalStore(
    subscribeToMeshSmoothingBrushState,
    getMeshSmoothingBrushState,
    getMeshSmoothingBrushState,
  );

  const settings = React.useSyncExternalStore(
    subscribeToMeshSmoothingSettings,
    getMeshSmoothingSettings,
    getMeshSmoothingSettings,
  );

  const { camera, size, gl } = useThree();

  const hover = brushState.hoverPoint ?? brushState.strokeLastPoint;
  const normal = (brushState.hoverNormal ?? brushState.strokeLastNormal ?? new THREE.Vector3(0, 0, 1)).clone().normalize();

  const radius = Math.max(0.1, settings.brushSizeMm);

  const cursorPosition = React.useMemo(() => {
    return (hover ?? new THREE.Vector3(0, 0, 0)).clone();
  }, [hover]);

  const unitsPerPixel = React.useMemo(() => {
    if (!camera || !size.height) return 0.01;

    // Convert screen pixels to world units at the cursor position.
    // This keeps the ring/dot thickness constant even when zooming.
    if ((camera as any).isPerspectiveCamera) {
      const perspective = camera as THREE.PerspectiveCamera;
      const dist = perspective.position.distanceTo(cursorPosition);
      const vFov = THREE.MathUtils.degToRad(perspective.fov);
      const worldHeightAtDist = 2 * dist * Math.tan(vFov / 2);
      return worldHeightAtDist / size.height;
    }

    if ((camera as any).isOrthographicCamera) {
      const ortho = camera as THREE.OrthographicCamera;
      const worldHeight = ortho.top - ortho.bottom;
      return worldHeight / size.height;
    }

    return 0.01;
  }, [camera, cursorPosition, size.height]);

  const thickness = React.useMemo(() => {
    const desiredPx = 1.25;
    const world = unitsPerPixel * desiredPx;
    return Math.max(0.01, Math.min(0.15, world));
  }, [unitsPerPixel]);

  const innerRadius = Math.max(0.001, radius - thickness);

  const dotRadius = React.useMemo(() => {
    const desiredPx = 1.75;
    const world = unitsPerPixel * desiredPx;
    return Math.max(0.01, Math.min(0.18, world));
  }, [unitsPerPixel]);

  const surfaceOffset = React.useMemo(() => {
    // Keep cursor slightly above the mesh to reduce z-fighting.
    return Math.max(0.01, Math.min(0.08, unitsPerPixel * 2.5));
  }, [unitsPerPixel]);

  const markerSurfaceOffset = React.useMemo(() => {
    // Marker needs a little more clearance than the cursor ring to avoid z-fighting flicker while dragging.
    return Math.max(surfaceOffset, Math.min(0.5, surfaceOffset * 6.0));
  }, [surfaceOffset]);

  const cursorQuaternion = React.useMemo(() => {
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    return q;
  }, [normal]);

  const color = brushState.isStrokeActive ? '#60a5fa' : '#93c5fd';
  const opacity = brushState.isStrokeActive ? 0.92 : 0.75;
  const markerOpacity = 0.68;

  const MAX_MARKER_INSTANCES = 8192;
  const markerRef = React.useRef<THREE.InstancedMesh | null>(null);
  const markerDummy = React.useMemo(() => new THREE.Object3D(), []);
  const lastMarkerStencilClearFrameRef = React.useRef(-1);
  const lastMarkerInstanceCountRef = React.useRef(0);
  const lastMarkerRadiusRef = React.useRef(-1);

  React.useEffect(() => {
    const mesh = markerRef.current;
    if (!mesh) return;

    if (!brushState.isStrokeActive) {
      mesh.count = 0;
      lastMarkerInstanceCountRef.current = 0;
      return;
    }

    const count = Math.min(MAX_MARKER_INSTANCES, brushState.strokePreviewCount | 0);
    if (count <= 0) {
      mesh.count = 0;
      lastMarkerInstanceCountRef.current = 0;
      return;
    }

    // If brush radius changes mid-stroke, rebuild matrices so stamp size updates.
    if (lastMarkerRadiusRef.current !== radius) {
      lastMarkerRadiusRef.current = radius;
      lastMarkerInstanceCountRef.current = 0;
    }

    const start = 0;
    const posSrc = brushState.strokePreviewPositions;
    const nrmSrc = brushState.strokePreviewNormals;
    const up = new THREE.Vector3(0, 0, 1);
    const n = new THREE.Vector3();
    const p = new THREE.Vector3();

    let from = lastMarkerInstanceCountRef.current;
    if (from < 0) from = 0;
    if (from > count) from = 0;

    for (let i = from; i < count; i++) {
      const idxPoint = start + i;
      const i3 = idxPoint * 3;

      p.set(posSrc[i3 + 0]!, posSrc[i3 + 1]!, posSrc[i3 + 2]!);
      n.set(nrmSrc[i3 + 0]!, nrmSrc[i3 + 1]!, nrmSrc[i3 + 2]!).normalize();
      p.addScaledVector(n, markerSurfaceOffset);

      markerDummy.position.copy(p);
      markerDummy.quaternion.setFromUnitVectors(up, n);
      markerDummy.scale.set(radius, radius, radius);
      markerDummy.updateMatrix();
      mesh.setMatrixAt(i, markerDummy.matrix);
    }

    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    lastMarkerInstanceCountRef.current = count;
  }, [brushState.isStrokeActive, brushState.strokePreviewCount, brushState.strokePreviewVersion, markerDummy, markerSurfaceOffset, radius]);

  if (!hover) return null;

  // Use a single dedicated stencil bit so we don't interfere with other stencil users.
  // We clear ONLY this bit each frame before drawing the marker.
  // This guarantees no transparency stacking: each pixel is shaded at most once per frame.
  const markerStencilMask = 0x80;
  const markerStencilRef = markerStencilMask;

  return (
    <group raycast={() => null}>
      {/* Color pass with stencil: each pixel is shaded at most once (NO transparency stacking). */}
      <instancedMesh
        ref={markerRef}
        args={[undefined as any, undefined as any, MAX_MARKER_INSTANCES]}
        renderOrder={99998}
        frustumCulled={false}
        onBeforeRender={() => {
          const frame = gl.info.render.frame;
          if (lastMarkerStencilClearFrameRef.current === frame) return;
          lastMarkerStencilClearFrameRef.current = frame;

          const ctx = gl.getContext();
          // Clear only our bit (stencil clear is masked by stencilMask).
          ctx.stencilMask(markerStencilMask);
          ctx.clearStencil(0);
          ctx.clear(ctx.STENCIL_BUFFER_BIT);
          // Restore default mask.
          ctx.stencilMask(0xff);
        }}
      >
        <circleGeometry args={[1, 28]} />
        <meshBasicMaterial
          color={new THREE.Color(settings.highlightColor)}
          transparent
          opacity={markerOpacity}
          side={THREE.DoubleSide}
          depthTest={false}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-2}
          polygonOffsetUnits={-2}
          stencilWrite
          stencilRef={markerStencilRef}
          stencilFunc={THREE.NotEqualStencilFunc}
          stencilFail={THREE.KeepStencilOp}
          stencilZFail={THREE.KeepStencilOp}
          stencilZPass={THREE.ReplaceStencilOp}
          stencilFuncMask={markerStencilMask}
          stencilWriteMask={markerStencilMask}
        />
      </instancedMesh>

      <group
        position={[
          cursorPosition.x + normal.x * surfaceOffset,
          cursorPosition.y + normal.y * surfaceOffset,
          cursorPosition.z + normal.z * surfaceOffset,
        ]}
        quaternion={cursorQuaternion}
      >
        <mesh renderOrder={99999}>
          <ringGeometry args={[innerRadius, radius, 96]} />
          <meshBasicMaterial
            color={new THREE.Color(color)}
            transparent
            opacity={opacity}
            depthTest={false}
            depthWrite={false}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
          />
        </mesh>
        <mesh renderOrder={99999}>
          <sphereGeometry args={[dotRadius, 12, 12]} />
          <meshBasicMaterial
            color={new THREE.Color(color)}
            transparent
            opacity={opacity}
            depthTest={false}
            depthWrite={false}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
          />
        </mesh>
      </group>
    </group>
  );
}

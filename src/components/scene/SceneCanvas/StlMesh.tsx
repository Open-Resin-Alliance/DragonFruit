"use client";

import React, { useEffect } from 'react';
import * as THREE from 'three';
import { usePicking } from '@/components/picking';
import { MeshShaderMaterial, type MeshShaderType } from '@/features/shaders/mesh';
import { OpaqueWireOverlayMaterial } from '@/features/shaders/mesh/opaqueWireMesh';
import {
  beginMeshSmoothingStroke,
  updateMeshSmoothingStroke,
  setMeshSmoothingHover,
} from '@/features/mesh-smoothing/brushController';
import {
  beginMeshSmoothingEngineStroke,
  recordMeshSmoothingEngineStrokeSample,
  ensureMeshSmoothingEngineReady,
} from '@/features/mesh-smoothing/meshSmoothingEngine';
import { clampMeshSmoothingBrushSizeMm, getMeshSmoothingSettings } from '@/features/mesh-smoothing/settings';
import type { TransformMode, ModelTransform } from '@/hooks/useModelTransform';
import type { SupportMode } from '@/supports/types';

export function StlMesh({
  geometry,
  clipLower,
  clipUpper,
  meshColor,
  meshRef,
  actualMeshRef,
  materialRoughness,
  shaderType,
  matcapVariant,
  flatUseVertexColors,
  toonSteps,
  xrayOpacity,
  transform,
  mode,
  transformMode,
  isActiveModel,
  onSmoothingGeometryActivate,
  onSupportClick,
  onSupportHover,
  onActiveModelChange,
  disableRaycast,
  blockSupportPlacement,
  suppressNextClickRef,
  modelId,
  isSelected,
  isBranchPlacementActive,
  isLeafPlacementActive,
  isBracePlacementActive,
  onModelHoverPointChange,
}: {
  geometry: THREE.BufferGeometry;
  clipLower?: number | null;
  clipUpper?: number | null;
  meshColor?: string;
  /** Ref to the group (for gizmo positioning) */
  meshRef?: React.Ref<THREE.Mesh | null>;
  /** Ref to the actual mesh (for outline effect) */
  actualMeshRef?: React.Ref<THREE.Mesh | null>;
  materialRoughness?: number;
  shaderType: MeshShaderType;
  matcapVariant?: import('@/features/shaders/mesh').MatcapVariant;
  flatUseVertexColors?: boolean;
  toonSteps?: number;
  xrayOpacity?: number;
  transform?: ModelTransform | null;
  mode?: SupportMode;
  transformMode?: TransformMode;
  isActiveModel?: boolean;
  onSmoothingGeometryActivate?: (geometry: THREE.BufferGeometry | null) => void;
  onSupportClick?: (hit: THREE.Intersection) => void;
  onSupportHover?: (hit: THREE.Intersection | null) => void;
  onActiveModelChange?: (id: string | null) => void;
  disableRaycast?: boolean;
  blockSupportPlacement?: boolean;
  suppressNextClickRef?: React.RefObject<boolean>;
  /** Model ID for picking registration */
  modelId: string;
  /** Whether model is selected (tints material) */
  isSelected?: boolean;
  /** Whether branch placement mode is active (Alt held) */
  isBranchPlacementActive?: boolean;
  /** Whether leaf placement mode is active (Alt+Shift held) */
  isLeafPlacementActive?: boolean;
  isBracePlacementActive?: boolean;
  onModelHoverPointChange?: (point: THREE.Vector3 | null) => void;
}) {
  // Access GPU picking state to detect gizmo hover
  // Note: This works because StlMesh is rendered inside PickingProvider
  const { hit } = usePicking(); // Import usePicking at top if not already used inside StlMesh

  const smoothingScratchLocalPointRef = React.useRef(new THREE.Vector3());

  // Build clipping planes for a band [clipLower, clipUpper] on Z axis
  // Clipping planes work in WORLD space
  // clipLower/clipUpper are already in world space (0 = bottom of mesh)
  const planes = React.useMemo(() => {
    const ps: THREE.Plane[] = [];

    if (clipLower != null) {
      // Clip below clipLower in world space
      // Normal points up (0,0,1), hide points where world Z < clipLower
      ps.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), -clipLower));
    }
    if (clipUpper != null) {
      // Clip above clipUpper in world space
      // Normal points down (0,0,-1), hide points where world Z > clipUpper
      ps.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), clipUpper));
    }
    return ps;
  }, [clipLower, clipUpper]);

  React.useEffect(() => {
    if (mode === 'prepare' && transformMode === 'smoothing' && isActiveModel) {
      ensureMeshSmoothingEngineReady(geometry);
    }
  }, [geometry, isActiveModel, mode, transformMode]);

  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [SceneCanvas] StlMesh received new geometry for ${modelId}`);
  }, [geometry, modelId]);

  // Calculate center offset for positioning
  const centerOffset = React.useMemo(() => {
    const bbox =
      geometry.boundingBox ??
      new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
    return bbox.getCenter(new THREE.Vector3());
  }, [geometry]);

  const meshLocalOffset = React.useMemo(
    () => new THREE.Vector3(-centerOffset.x, -centerOffset.y, -centerOffset.z),
    [centerOffset.x, centerOffset.y, centerOffset.z],
  );

  // Internal ref for the mesh element to control raycasting
  const internalMeshRef = React.useRef<THREE.Mesh>(null);

  // Toggle raycasting based on camera movement to optimize performance
  const previousDisableState = React.useRef<boolean | undefined>(undefined);

  React.useEffect(() => {
    // Always use internalMeshRef - meshRef points to the group, not the mesh
    const mesh = internalMeshRef.current;
    if (mesh && previousDisableState.current !== disableRaycast) {
      previousDisableState.current = disableRaycast;

      if (disableRaycast) {
        // Disable raycasting during camera movement (no-op function)
        console.log('[Raycast] DISABLED - performance mode active');
        mesh.raycast = () => {};
      } else {
        // Restore normal raycasting behavior
        console.log('[Raycast] ENABLED - normal interaction mode');
        mesh.raycast = THREE.Mesh.prototype.raycast;
      }
    }
  }, [disableRaycast]);

  // Use a group for proper gizmo positioning
  // Group has the transform, mesh inside is offset to center the geometry
  const baseShaderType: MeshShaderType = shaderType === 'opaque_wire_mesh' ? 'soft_clay' : shaderType;
  const showOpaqueWireOverlay = shaderType === 'opaque_wire_mesh';

  return (
    <group
      ref={meshRef}
      position={transform?.position || new THREE.Vector3(0, 0, 0)}
      rotation={transform?.rotation || new THREE.Euler(0, 0, 0)}
      scale={transform?.scale || new THREE.Vector3(1, 1, 1)}
    >
      <mesh
        ref={(node) => {
          // Assign to refs
          internalMeshRef.current = node;
          if (typeof actualMeshRef === 'function') actualMeshRef(node);
          else if (actualMeshRef) (actualMeshRef as React.MutableRefObject<THREE.Mesh | null>).current = node;
        }}
        userData={{ modelId }}
        geometry={geometry}
        position={meshLocalOffset}
        onClick={(e) => {
          console.log('[SceneCanvas] Mesh clicked, mode:', mode, 'id:', modelId);

          // Model selection in prepare mode - dispatch custom event
          if (mode === 'prepare') {
            e.stopPropagation();
            window.__modelClickedThisFrame = true;
            window.dispatchEvent(
              new CustomEvent('model-clicked', {
                detail: { modelId: modelId },
              }),
            );

            // Update active model in parent state
            if (onActiveModelChange) {
              onActiveModelChange(modelId);
            }
          }

          // Support placement in support mode
          if (mode === 'support' && onSupportClick) {
            e.stopPropagation();
            onSupportClick(e as unknown as THREE.Intersection);
          }
        }}
        onPointerMove={(e) => {
          if (hit.category === 'gizmo' || hit.category === 'support') {
            onModelHoverPointChange?.(null);
          } else {
            onModelHoverPointChange?.(e.point.clone());
          }

          if (mode === 'prepare' && transformMode === 'smoothing' && isActiveModel) {
            if (hit.category === 'gizmo' || hit.category === 'support') {
              setMeshSmoothingHover(null, null);
            } else {
              const normal = e.face?.normal
                ? e.face.normal
                    .clone()
                    .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(e.object.matrixWorld))
                    .normalize()
                : null;
              updateMeshSmoothingStroke(e.point.clone(), normal);

              // Apply smoothing only while the left mouse button is held.
              if ((e.buttons & 1) === 1 && !disableRaycast) {
                const localPoint = smoothingScratchLocalPointRef.current;
                localPoint.copy(e.point);
                e.object.worldToLocal(localPoint);

                recordMeshSmoothingEngineStrokeSample(geometry, localPoint);
              }
            }
          }

          if (mode === 'support' && onSupportHover) {
            // Mute hover when placement is blocked
            if (blockSupportPlacement) return;

            // Mute hover if hovering a gizmo OR support (using GPU picking for accuracy)
            if (hit.category === 'gizmo' || hit.category === 'support') {
              onSupportHover(null);
              return;
            }

            e.stopPropagation();
            onSupportHover(e);
          }
        }}
        onPointerOut={() => {
          onModelHoverPointChange?.(null);

          if (mode === 'prepare' && transformMode === 'smoothing' && isActiveModel) {
            setMeshSmoothingHover(null, null);
          }

          if (mode === 'support' && onSupportHover) {
            onSupportHover(null);
          }
        }}
        onPointerDown={(e) => {
          if (mode === 'prepare' && transformMode === 'smoothing' && isActiveModel && e.button === 0) {
            const normal = e.face?.normal
              ? e.face.normal
                  .clone()
                  .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(e.object.matrixWorld))
                  .normalize()
              : null;
            beginMeshSmoothingStroke(e.point.clone(), normal);

            onSmoothingGeometryActivate?.(geometry);
            beginMeshSmoothingEngineStroke(geometry);
          }
        }}
      >
        <MeshShaderMaterial
          shaderType={baseShaderType}
          isSelected={!!isSelected}
          meshColor={meshColor}
          matcapVariant={matcapVariant}
          flatUseVertexColors={flatUseVertexColors}
          toonSteps={toonSteps}
          materialRoughness={materialRoughness}
          clippingPlanes={planes}
          xrayOpacity={xrayOpacity}
        />
      </mesh>

      {showOpaqueWireOverlay && (
        <mesh geometry={geometry} position={meshLocalOffset} renderOrder={1} raycast={() => null}>
          <OpaqueWireOverlayMaterial clippingPlanes={planes} />
        </mesh>
      )}
    </group>
  );
}

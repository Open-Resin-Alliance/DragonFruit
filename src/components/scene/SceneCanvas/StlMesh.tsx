"use client";

import React, { useEffect } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
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
import { quaternionFromGlobalEuler } from '@/utils/rotation';

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
  isMarqueeCandidate,
  isBranchPlacementActive,
  isLeafPlacementActive,
  isBracePlacementActive,
  onModelHoverPointChange,
  onModelHoverModelChange,
  revealGhostOpacity,
  hoverTintColor,
  hoverTintStrength,
  selectedTintStrength,
  supportNonSelectedOpacity,
  interactionLodActive,
  showOutOfBoundsOverlay,
  outOfBoundsMin,
  outOfBoundsMax,
  outOfBoundsStripeColor,
  suppressModelInteraction,
  externalHoveredModelId,
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
  onActiveModelChange?: (id: string | null, options?: { selectionMode?: 'single' | 'toggle' | 'add' }) => void;
  disableRaycast?: boolean;
  blockSupportPlacement?: boolean;
  suppressNextClickRef?: React.RefObject<boolean>;
  /** Model ID for picking registration */
  modelId: string;
  /** Whether model is selected (tints material) */
  isSelected?: boolean;
  /** Whether model is currently inside marquee drag window */
  isMarqueeCandidate?: boolean;
  /** Whether branch placement mode is active (Alt held) */
  isBranchPlacementActive?: boolean;
  /** Whether leaf placement mode is active (Alt+Shift held) */
  isLeafPlacementActive?: boolean;
  isBracePlacementActive?: boolean;
  onModelHoverPointChange?: (point: THREE.Vector3 | null) => void;
  onModelHoverModelChange?: (modelId: string | null) => void;
  revealGhostOpacity?: number;
  hoverTintColor?: string;
  hoverTintStrength?: number;
  selectedTintStrength?: number;
  supportNonSelectedOpacity?: number;
  interactionLodActive?: boolean;
  showOutOfBoundsOverlay?: boolean;
  outOfBoundsMin?: THREE.Vector3 | null;
  outOfBoundsMax?: THREE.Vector3 | null;
  outOfBoundsStripeColor?: string;
  suppressModelInteraction?: boolean;
  externalHoveredModelId?: string | null;
}) {
  // Access GPU picking state to detect gizmo hover
  // Note: This works because StlMesh is rendered inside PickingProvider
  const { hit } = usePicking(); // Import usePicking at top if not already used inside StlMesh
  const [isPointerHovered, setIsPointerHovered] = React.useState(false);
  const { camera } = useThree();

  const smoothingScratchLocalPointRef = React.useRef(new THREE.Vector3());
  const supportDimCameraLocalPointRef = React.useRef(new THREE.Vector3());
  const supportDimWorldScaleRef = React.useRef(new THREE.Vector3());
  const supportDimMaterialRef = React.useRef<THREE.MeshStandardMaterial | null>(null);

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

  const localGeometryBounds = React.useMemo(() => {
    return (
      geometry.boundingBox?.clone()
      ?? new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute)
    );
  }, [geometry]);

  const hasVertexColorAttribute = React.useMemo(() => {
    const colorAttr = geometry.getAttribute('color');
    return !!colorAttr && colorAttr.count > 0;
  }, [geometry]);

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

  const schedulePointerHover = React.useCallback((next: boolean) => {
    setIsPointerHovered((prev) => (prev === next ? prev : next));
  }, []);

  // Use a group for proper gizmo positioning
  // Group has the transform, mesh inside is offset to center the geometry
  const baseShaderType: MeshShaderType = shaderType === 'opaque_wire_mesh' ? 'soft_clay' : shaderType;
  const showOpaqueWireOverlay = shaderType === 'opaque_wire_mesh';
  const hasGpuModelHoverId = hit.category === 'model' && typeof hit.objectId === 'string' && hit.objectId.length > 0;
  const isGizmoHoverCategory = hit.category === 'gizmo';
  const isSupportLikeHoverCategory = hit.category === 'support' || hit.category === 'segment' || hit.category === 'joint' || hit.category === 'knot' || hit.category === 'raft';
  const shouldSuppressModelInteraction = !!suppressModelInteraction;
  const isExternallyHoveredModel = !shouldSuppressModelInteraction
    && !!externalHoveredModelId
    && externalHoveredModelId === modelId;
  const isHoveredModel = isExternallyHoveredModel || (!shouldSuppressModelInteraction && (
    hasGpuModelHoverId
      ? hit.objectId === modelId
      : (!isGizmoHoverCategory && isPointerHovered)
  ));
  const isMarqueeHovered = !shouldSuppressModelInteraction && !!isMarqueeCandidate;
  const isSupportDimmed = typeof supportNonSelectedOpacity === 'number';
  const dimmedBaseOpacity = isSupportDimmed
    ? Math.min(0.95, Math.max(0.04, supportNonSelectedOpacity))
    : null;
  const dimmedInsideOpacity = isSupportDimmed
    ? 0.0
    : null;

  useFrame(() => {
    if (!isSupportDimmed) return;

    const mesh = internalMeshRef.current;
    const material = supportDimMaterialRef.current;
    if (!mesh || !material || dimmedBaseOpacity == null || dimmedInsideOpacity == null) return;

    const localPoint = supportDimCameraLocalPointRef.current;
    localPoint.copy(camera.position);
    mesh.worldToLocal(localPoint);

    const localDistanceToBounds = localGeometryBounds.distanceToPoint(localPoint);
    mesh.getWorldScale(supportDimWorldScaleRef.current);
    const worldScale = supportDimWorldScaleRef.current;
    const distanceScaleFactor = Math.max(
      1e-6,
      Math.max(Math.abs(worldScale.x), Math.abs(worldScale.y), Math.abs(worldScale.z)),
    );
    const distanceToBoundsMm = localDistanceToBounds * distanceScaleFactor;

    const proximityFadeRangeMm = 24;
    const proximityT = THREE.MathUtils.clamp(1 - (distanceToBoundsMm / proximityFadeRangeMm), 0, 1);
    const targetOpacity = THREE.MathUtils.lerp(dimmedBaseOpacity, dimmedInsideOpacity, proximityT);
    const nextOpacity = THREE.MathUtils.lerp(material.opacity, targetOpacity, 0.18);

    if (Math.abs(nextOpacity - material.opacity) > 0.0005) {
      material.opacity = nextOpacity;
    }

    const shouldDepthWrite = nextOpacity > 0.2;
    if (material.depthWrite !== shouldDepthWrite) {
      material.depthWrite = shouldDepthWrite;
      material.needsUpdate = true;
    }
  });

  const interactionLodColor = React.useMemo(() => {
    const base = new THREE.Color(hasVertexColorAttribute ? '#ffffff' : (meshColor ?? '#a3a3a3'));
    const tint = new THREE.Color(hoverTintColor ?? '#ec2a77');

    const selectionStrength = Math.min(1, Math.max(0, selectedTintStrength ?? 0.75));
    const hoverStrength = Math.min(1, Math.max(0, hoverTintStrength ?? 0.5));

    if (isSelected) {
      return base.clone().lerp(tint, selectionStrength).getStyle();
    }

    if (isHoveredModel || isMarqueeHovered) {
      return base.clone().lerp(tint, hoverStrength).getStyle();
    }

    return base.getStyle();
  }, [hasVertexColorAttribute, hoverTintColor, hoverTintStrength, isHoveredModel, isMarqueeHovered, isSelected, meshColor, selectedTintStrength]);

  const outOfBoundsMaterial = React.useMemo(() => {
    if (!showOutOfBoundsOverlay || !outOfBoundsMin || !outOfBoundsMax) return null;

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      uniforms: {
        boundsMin: { value: outOfBoundsMin.clone() },
        boundsMax: { value: outOfBoundsMax.clone() },
        stripeFreq: { value: 0.22 },
        stripeAlpha: { value: 0.42 },
        stripeColor: { value: new THREE.Color(outOfBoundsStripeColor ?? '#b6ff2e') },
      },
      vertexShader: `
        varying vec3 vWorldPos;
        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPos = worldPos.xyz;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        varying vec3 vWorldPos;
        uniform vec3 boundsMin;
        uniform vec3 boundsMax;
        uniform float stripeFreq;
        uniform float stripeAlpha;
        uniform vec3 stripeColor;

        void main() {
          bool outside =
            vWorldPos.x < boundsMin.x || vWorldPos.x > boundsMax.x ||
            vWorldPos.y < boundsMin.y || vWorldPos.y > boundsMax.y ||
            vWorldPos.z < boundsMin.z || vWorldPos.z > boundsMax.z;

          if (!outside) discard;

          float stripeSeed = (vWorldPos.x + vWorldPos.y + vWorldPos.z) * stripeFreq;
          float band = step(0.5, fract(stripeSeed));
          vec3 colorA = stripeColor;
          vec3 colorB = vec3(1.0, 1.0, 1.0);
          vec3 color = mix(colorA, colorB, band);

          gl_FragColor = vec4(color, stripeAlpha);
        }
      `,
    });

    return material;
  }, [outOfBoundsMax, outOfBoundsMin, outOfBoundsStripeColor, showOutOfBoundsOverlay]);

  React.useEffect(() => {
    return () => {
      outOfBoundsMaterial?.dispose();
    };
  }, [outOfBoundsMaterial]);

  return (
    <group
      ref={meshRef}
      position={transform?.position || new THREE.Vector3(0, 0, 0)}
      quaternion={transform ? quaternionFromGlobalEuler(transform.rotation) : new THREE.Quaternion()}
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
        renderOrder={isSupportDimmed ? 2 : 0}
        onClick={(e) => {
          if (shouldSuppressModelInteraction) {
            e.stopPropagation();
            return;
          }

          console.log('[SceneCanvas] Mesh clicked, mode:', mode, 'id:', modelId);

          // Prepare mode selection is handled on pointer-down for lower latency.
          if (mode === 'prepare') {
            // When transforming the already-active model, avoid consuming clicks so
            // gizmo handles (e.g. center XY disc) can receive the event chain.
            if (transformMode === 'transform' && isActiveModel) {
              return;
            }

            // Let gizmo handles (especially center XY disc) receive clicks without
            // model-level event swallowing.
            if (isGizmoHoverCategory) {
              return;
            }
            e.stopPropagation();
            return;
          }

          if (mode === 'support' && onActiveModelChange && !isActiveModel) {
            e.stopPropagation();
            onActiveModelChange(modelId);

            // In support mode, first click should select the model only.
            // Placement is allowed only after a model is actively selected.
            return;
          }

          // Support placement in support mode
          if (mode === 'support' && onSupportClick) {
            if (blockSupportPlacement) return;
            e.stopPropagation();
            onSupportClick(e as unknown as THREE.Intersection);
          }
        }}
        onPointerMove={(e) => {
          if (shouldSuppressModelInteraction || isGizmoHoverCategory) {
            schedulePointerHover(false);
            onModelHoverPointChange?.(null);
            onModelHoverModelChange?.(null);
            return;
          }

          const isTopMostIntersection = e.intersections[0]?.object === e.object;
          if (!isTopMostIntersection) {
            schedulePointerHover(false);
            return;
          }

          schedulePointerHover(true);
          onModelHoverPointChange?.(e.point.clone());
          onModelHoverModelChange?.(modelId);
          window.dispatchEvent(new CustomEvent('model-pointer-hover-immediate', {
            detail: { modelId },
          }));

          if (mode === 'prepare' && transformMode === 'smoothing' && isActiveModel) {
            if (isGizmoHoverCategory || isSupportLikeHoverCategory) {
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

            // Preview should only appear on the actively selected model.
            if (!isActiveModel) {
              onSupportHover(null);
              return;
            }

            // Mute hover if hovering a gizmo OR support (using GPU picking for accuracy)
            if (isGizmoHoverCategory || isSupportLikeHoverCategory) {
              onSupportHover(null);
              return;
            }

            onSupportHover(e);
          }
        }}
        onPointerOut={(e) => {
          const stillOverAnyModel = Array.isArray(e.intersections)
            && e.intersections.some((entry) => !!entry?.object?.userData?.modelId);

          if (stillOverAnyModel) {
            return;
          }

          schedulePointerHover(false);
          onModelHoverPointChange?.(null);
          onModelHoverModelChange?.(null);
          window.dispatchEvent(new CustomEvent('model-pointer-hover-immediate', {
            detail: { modelId: null },
          }));

          if (mode === 'prepare' && transformMode === 'smoothing' && isActiveModel) {
            setMeshSmoothingHover(null, null);
          }

          if (mode === 'support' && onSupportHover) {
            onSupportHover(null);
          }
        }}
        onPointerDown={(e) => {
          if (!shouldSuppressModelInteraction && mode === 'prepare' && e.button === 0) {
            // While transforming the selected model, don't consume pointer-down at
            // the model layer; this keeps gizmo handle clicks responsive.
            if (transformMode === 'transform' && isActiveModel) {
              return;
            }

            // If the pointer is over a gizmo handle, do not consume the event at
            // the model layer; let gizmo drag interactions win.
            if (isGizmoHoverCategory) {
              return;
            }

            e.stopPropagation();
            window.__modelClickGuardUntil = performance.now() + 48;
            window.__modelClickedThisFrame = true;
            window.setTimeout(() => {
              window.__modelClickedThisFrame = false;
            }, 0);
            window.dispatchEvent(
              new CustomEvent('model-clicked', {
                detail: { modelId: modelId },
              }),
            );

            if (onActiveModelChange) {
              const native = (e as unknown as { nativeEvent?: MouseEvent }).nativeEvent;
              const selectionMode = native?.ctrlKey || native?.metaKey
                ? 'toggle'
                : native?.shiftKey
                  ? 'add'
                  : 'single';
              onActiveModelChange(modelId, { selectionMode });
            }
          }

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
        {typeof revealGhostOpacity === 'number' ? (
          <meshStandardMaterial
            color={meshColor ?? '#c8c8ce'}
            transparent
            opacity={Math.min(0.95, Math.max(0.04, revealGhostOpacity))}
            roughness={0.55}
            metalness={0.02}
            clippingPlanes={planes}
            side={THREE.FrontSide}
            depthWrite={false}
          />
        ) : typeof supportNonSelectedOpacity === 'number' ? (
          <meshStandardMaterial
            ref={supportDimMaterialRef}
            color={meshColor ?? '#c8c8ce'}
            transparent
            opacity={dimmedBaseOpacity ?? 0.5}
            roughness={0.55}
            metalness={0.02}
            clippingPlanes={planes}
            side={THREE.FrontSide}
            depthWrite
          />
        ) : interactionLodActive ? (
          <meshStandardMaterial
            vertexColors={hasVertexColorAttribute}
            color={interactionLodColor}
            roughness={materialRoughness ?? 0.9}
            metalness={0.0}
            clippingPlanes={planes}
            clipIntersection
            side={THREE.FrontSide}
          />
        ) : (
          <MeshShaderMaterial
            shaderType={baseShaderType}
            isSelected={!!isSelected}
            isHovered={isHoveredModel || isMarqueeHovered}
            useVertexColors={hasVertexColorAttribute}
            hoverTintColor={hoverTintColor}
            hoverTintStrength={hoverTintStrength}
            selectedTintStrength={selectedTintStrength}
            meshColor={meshColor}
            matcapVariant={matcapVariant}
            flatUseVertexColors={flatUseVertexColors}
            toonSteps={toonSteps}
            materialRoughness={materialRoughness}
            clippingPlanes={planes}
            xrayOpacity={xrayOpacity}
          />
        )}
      </mesh>

      {showOpaqueWireOverlay && (
        <mesh geometry={geometry} position={meshLocalOffset} renderOrder={1} raycast={() => null}>
          <OpaqueWireOverlayMaterial clippingPlanes={planes} />
        </mesh>
      )}

      {outOfBoundsMaterial && (
        <mesh geometry={geometry} position={meshLocalOffset} renderOrder={3} raycast={() => null}>
          <primitive object={outOfBoundsMaterial} attach="material" />
        </mesh>
      )}
    </group>
  );
}

"use client";

import React, { useEffect } from 'react';
import dynamic from 'next/dynamic';
import * as THREE from 'three';
import { OrbitControls } from '@react-three/drei';
import { useThree, useFrame } from '@react-three/fiber';
import { CrossSectionCap } from '@/components/scene/CrossSectionCap';
import { IslandOverlay } from '@/components/scene/IslandOverlay';
import { IslandVoxelVisualization } from '@/components/scene/IslandVoxelVisualization';
import { IslandExpansionVisualization } from '@/components/scene/IslandExpansionVisualization';
import { MeshClassificationRenderer } from '@/components/scene/MeshClassificationRenderer';
import { IslandIdLabels } from '@/components/scene/IslandIdLabels';
import { AxisLabels } from '@/components/scene/AxisLabels';
import { ScreenSpaceGizmo as UnifiedGizmo } from '@/components/gizmo';
import { CameraFocusController } from '@/components/scene/CameraFocusController';
import { PickingProvider, PickingDebugOverlay, usePicking } from '@/components/picking';
import { SelectionProvider, SelectionManager, SelectionOutlineRenderer, SelectionSpotlight, useSelection } from '@/components/selection';
import type { SelectionHighlightMode } from '@/components/selection';
import type { IslandMarker } from '@/volumeAnalysis/IslandScan/islandOverlayLogic';
import type { ScanResults } from '@/volumeAnalysis/islandVolume/steps/voxelization/ScanOrchestrator';
import type { BasinFillSimulator } from '@/volumeAnalysis/islandVolume/steps/expansion/BasinFillSimulator';
import type { BasinFillProxy } from '@/volumeAnalysis/islandVolume/steps/expansion/BasinFillProxy';
import type { TransformMode, ModelTransform } from '@/hooks/useModelTransform';
import type { SupportMode } from '@/supports/types';
import { SupportRenderer } from '@/supports/SupportRenderer';
import { SupportBuilder } from '@/supports/rendering';
import type { SupportData } from '@/supports/rendering';
import { SupportPreview } from '@/supports_legacy/SupportPreview';
import RaftRenderer from '@/supports/Rafts/Crenelated/rendering/RaftRenderer';
import LineRaftRenderer from '@/supports/Rafts/Crenelated/rendering/LineRaftRenderer';
import FootprintBorderRenderer from '@/supports/Rafts/Crenelated/rendering/FootprintBorderRenderer';
import { JointPlacementPreview } from '@/supports/SupportPrimitives/Joint/JointPlacementPreview';
import { BranchPlacementController } from '@/supports/SupportTypes/Branch/BranchPlacementController';
import { LeafPlacementController } from '@/supports/SupportTypes/Leaf/LeafPlacementController';
import { BracePlacementController } from '@/supports/SupportTypes/Brace/BracePlacementController';
import { BracePreviewRenderer } from '@/supports/SupportTypes/Brace/BracePreviewRenderer';
import { clearSelection } from '@/supports/interaction/SupportSelection';
import { SupportLimitationFeedback } from '@/supports/PlacementLogic/SupportLimitations';
import { useCurveInteractionState } from '@/supports/Curves/curveInteractionState';
import { DEFAULT_TIP_CONTACT_DIAMETER_MM } from '@/supports/Settings/defaults';

import { GhostOverlay } from '@/features/lys-ghost/GhostOverlay';
import { subscribe, getSnapshot } from '@/supports/state';
import { PickingStateSyncer } from './PickingStateSyncer';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { CameraFocusHotkeyController, CameraIntroController, useStlLoadCameraIntro } from '@/components/scene/camera';

const Canvas = dynamic(() => import('@react-three/fiber').then(m => m.Canvas), { ssr: false });

function SelectionSync({ activeModelId }: { activeModelId: string | null }) {
  const { select, deselect, state } = useSelection();

  useEffect(() => {
    if (activeModelId && state.selectedModelId !== activeModelId) {
      select(activeModelId);
    } else if (!activeModelId && state.selectedModelId !== null) {
      deselect();
    }
  }, [activeModelId, select, deselect, state.selectedModelId]);

  return null;
}

function useInteractionWarning() {
  const [warning, setWarning] = React.useState(getSnapshot().interactionWarning);
  React.useEffect(() => {
    return subscribe(() => {
      const w = getSnapshot().interactionWarning;
      setWarning(w);
    });
  }, []);
  return warning;
}

/**
 * Wrapper that always applies PickingProvider, but conditionally enables debug mode.
 */
function PickingProviderWrapper({ enabled, children }: { enabled?: boolean; children: React.ReactNode }) {
  // Always render PickingProvider, pass enabled as debug flag
  return <PickingProvider debug={enabled}>{children}</PickingProvider>;
}

function LoggingHelper({ mode }: { mode?: string }) {
  React.useEffect(() => {
    console.log('[SceneCanvas] Mode in Canvas:', mode);
  }, [mode]);
  return null;
}

function EnableLocalClipping() {
  const { gl } = useThree();
  useEffect(() => {
    gl.localClippingEnabled = true;
  }, [gl]);
  return null;
}

function CameraProvider({ cameraRef }: { cameraRef: React.MutableRefObject<THREE.Camera | null> }) {
  const { camera, size } = useThree();
  React.useEffect(() => {
    cameraRef.current = camera;
  }, [camera, cameraRef]);
  return null;
}

function CameraClipPlaneStabilizer() {
  const { camera, controls } = useThree();

  useFrame(() => {
    const perspective = camera as THREE.PerspectiveCamera;
    if ((perspective as any).isPerspectiveCamera !== true) return;

    const orbitTarget = (controls as any)?.target as THREE.Vector3 | undefined;
    if (!orbitTarget) return;

    const dist = perspective.position.distanceTo(orbitTarget);
    if (!Number.isFinite(dist) || dist <= 0) return;

    // Depth precision fix:
    // A too-small near plane combined with a too-large far plane causes depth-buffer precision
    // issues that can make the model fail to occlude small geometry when zoomed in.
    // Keep near reasonably small but not extreme, and keep far tight.
    const desiredNear = Math.max(0.02, Math.min(0.5, dist / 200));
    const desiredFar = Math.min(5000, Math.max(200, dist * 50));

    if (Math.abs(perspective.near - desiredNear) > 1e-6 || Math.abs(perspective.far - desiredFar) > 1e-3) {
      perspective.near = desiredNear;
      perspective.far = desiredFar;
      perspective.updateProjectionMatrix();
    }
  });

  return null;
}

function Lights({ ambientIntensity, directionalIntensity }: { ambientIntensity: number; directionalIntensity: number }) {
  return (
    <>
      <ambientLight intensity={ambientIntensity} />
      <directionalLight position={[5, 10, 5]} intensity={directionalIntensity} />
      <directionalLight position={[-5, -5, -5]} intensity={directionalIntensity * 0.5} />
      <hemisphereLight args={['#ffffff', '#444444', ambientIntensity * 0.6]} />
    </>
  );
}

function Helpers() {
  const nullRaycast = () => null;

  return (
    <>
      {/* Grid on XY plane (horizontal) - rotate 90° around X */}
      <gridHelper
        args={[200, 40, '#333333', '#333333']}
        position={[0, 0, 0]}
        rotation={[Math.PI / 2, 0, 0]}
        raycast={nullRaycast}
      />
      {/* Axes: X=red, Y=green, Z=blue(up) */}
      <axesHelper
        args={[100]}
        raycast={nullRaycast}
      />
      <AxisLabels size={100} />
    </>
  );
}

function StlMesh({ geometry, clipLower, clipUpper, meshColor, meshRef, actualMeshRef, materialRoughness, transform, mode, onSupportClick, onSupportHover, onActiveModelChange, disableRaycast, blockSupportPlacement, suppressNextClickRef, modelId, isSelected, isBranchPlacementActive, isLeafPlacementActive, isBracePlacementActive, onModelHoverPointChange }: {
  geometry: THREE.BufferGeometry;
  clipLower?: number | null;
  clipUpper?: number | null;
  meshColor?: string;
  /** Ref to the group (for gizmo positioning) */
  meshRef?: React.Ref<THREE.Mesh | null>;
  /** Ref to the actual mesh (for outline effect) */
  actualMeshRef?: React.Ref<THREE.Mesh | null>;
  materialRoughness?: number;
  transform?: ModelTransform | null;
  mode?: SupportMode;
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

  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [SceneCanvas] StlMesh received new geometry for ${modelId}`);
  }, [geometry, modelId]);

  // Calculate center offset for positioning
  const centerOffset = React.useMemo(() => {
    const bbox = geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
    return bbox.getCenter(new THREE.Vector3());
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
        mesh.raycast = () => { };
      } else {
        // Restore normal raycasting behavior
        console.log('[Raycast] ENABLED - normal interaction mode');
        mesh.raycast = THREE.Mesh.prototype.raycast;
      }
    }
  }, [disableRaycast]);

  // Use a group for proper gizmo positioning
  // Group has the transform, mesh inside is offset to center the geometry
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
        position={new THREE.Vector3(-centerOffset.x, -centerOffset.y, -centerOffset.z)}
        castShadow
        receiveShadow
        onClick={(e) => {
          console.log('[SceneCanvas] Mesh clicked, mode:', mode, 'id:', modelId);

          // Model selection in prepare mode - dispatch custom event
          if (mode === 'prepare') {
            e.stopPropagation();
            window.__modelClickedThisFrame = true;
            window.dispatchEvent(new CustomEvent('model-clicked', {
              detail: { modelId: modelId }
            }));

            // Update active model in parent state
            if (onActiveModelChange) {
              onActiveModelChange(modelId);
            }

            return; // Don't process further in prepare mode
          }

          if (mode === 'support') {
            // Suppress single click after external drag end
            if (suppressNextClickRef?.current) {
              suppressNextClickRef.current = false;
              e.stopPropagation();
              // @ts-ignore
              if (e.nativeEvent?.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
              return;
            }

            // Block support placement while joint gizmo is active/selected
            if (blockSupportPlacement) {
              e.stopPropagation();
              // @ts-ignore
              if (e.nativeEvent?.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
              return;
            }

            // Deselect any selected support when clicking on the model
            // BUT not when in branch placement mode (we're setting the tip, not deselecting)
            if (!isBranchPlacementActive && !isLeafPlacementActive && !isBracePlacementActive) {
              clearSelection();
            }

            if (onSupportClick) {
              console.log('[SceneCanvas Mesh] Calling onSupportClick with event, branchMode:', isBranchPlacementActive);
              e.stopPropagation();
              onSupportClick(e);
            }
          }
        }}
        onPointerMove={(e) => {
          if (hit.category === 'gizmo' || hit.category === 'support') {
            onModelHoverPointChange?.(null);
          } else {
            onModelHoverPointChange?.(e.point.clone());
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

          if (mode === 'support' && onSupportHover) {
            onSupportHover(null);
          }
        }}
      >
        <meshStandardMaterial
          vertexColors
          color="#ffffff"
          emissive={isSelected ? "#1a75ff" : "#000000"}
          emissiveIntensity={isSelected ? 0.3 : 0}
          metalness={0.0}
          roughness={materialRoughness ?? 1.0}
          clippingPlanes={planes}
          clipIntersection
          side={THREE.DoubleSide}
          flatShading={false}
        />
      </mesh>
    </group>
  );
}

function SceneCanvasComponent({
  models = [],
  activeModelId,
  // Legacy props kept for compatibility if needed, but models replaces geom
  // geom, 
  clipLower,
  clipUpper,
  meshColor, // Global fallback color? Each model has color.
  meshVisible, // Global fallback visibility?
  disableRaycast,
  hideCrossSectionCap,
  onCameraChange,
  onCameraEnd,
  islandMarkers,
  overlayBrushRadius,
  overlayColor,
  overlayOpacity,
  overlaySelectedIslandId,
  ambientIntensity,
  directionalIntensity,
  materialRoughness,
  scanResults,
  layerHeightMm,
  scanBBox,
  voxelEnabled,
  voxelColorScheme,
  voxelSelectedIslandId,
  voxelShowMerged,
  voxelShowTerritory,
  voxelOpacity,
  transformMode,
  transform,
  onTransformChange,
  onTransformChangeEnd, // Was onTransformEnd in previous code, checking usage
  onTransformEnd,
  crossSectionMode,
  pxMm,
  showIslandIdLabels,
  mode,
  onSupportClick,
  onSupportHover,
  onActiveModelChange,
  trunkPlacementPreview,
  branchPlacementPreview,
  leafPlacementPreview,
  bracePlacementPreview,
  jointPlacementPreview,
  gpuPickingTest,
  selectionHighlightMode,
  blockSupportPlacement,
  supportsRef,
  ghostData,
  isBranchPlacementActive,
  isLeafPlacementActive,
  isBracePlacementActive,
  branchTipPosition,
  branchHoverPosition,
  leafTipPosition,
  leafHoverPosition,
  children,
  expansionSimulator,
  showExpansion,
  classificationFaceLabels,
  classificationGeometry,
  showClassification
}: {
  models?: LoadedModel[];
  activeModelId?: string | null;
  // geom: GeometryWithBounds | null;
  clipLower?: number | null;
  clipUpper?: number | null;
  meshColor?: string;
  meshVisible?: boolean;
  disableRaycast?: boolean;
  hideCrossSectionCap?: boolean;
  onCameraChange?: () => void;
  onCameraEnd?: () => void;
  islandMarkers?: IslandMarker[];
  overlayBrushRadius?: number;
  overlayColor?: string;
  overlayOpacity?: number;
  overlaySelectedIslandId?: number | null;
  ambientIntensity?: number;
  directionalIntensity?: number;
  materialRoughness?: number;
  scanResults?: ScanResults | null;
  layerHeightMm?: number;
  scanBBox?: THREE.Box3 | null;
  voxelEnabled?: boolean;
  voxelColorScheme?: 'unique' | 'lifecycle' | 'height';
  voxelSelectedIslandId?: number | null;
  voxelShowMerged?: boolean;
  voxelShowTerritory?: boolean;
  voxelOpacity?: number;
  transformMode?: TransformMode;
  transform?: ModelTransform;
  onTransformChange?: (position: THREE.Vector3, rotation: THREE.Euler, scale: THREE.Vector3) => void;
  onTransformChangeEnd?: (position: THREE.Vector3, rotation: THREE.Euler, scale: THREE.Vector3) => void;
  onTransformEnd?: (operation: 'move' | 'rotate' | 'scale') => void;
  crossSectionMode?: 'smooth' | 'rasterized';
  pxMm?: number;
  showIslandIdLabels?: boolean;
  mode?: SupportMode;
  onSupportClick?: (hit: THREE.Intersection) => void;
  onSupportHover?: (hit: THREE.Intersection | null) => void;
  onActiveModelChange?: (id: string | null) => void;
  trunkPlacementPreview?: SupportData | null;
  branchPlacementPreview?: SupportData | null;
  leafPlacementPreview?: SupportData | null;
  bracePlacementPreview?: import('@/supports/SupportTypes/Brace/bracePlacementState').BracePreviewData | null;
  jointPlacementPreview?: { pos: { x: number; y: number; z: number }; diameter: number } | null;
  gpuPickingTest?: boolean;
  selectionHighlightMode?: SelectionHighlightMode;
  blockSupportPlacement?: boolean;
  supportsRef?: React.RefObject<THREE.Group | null>;
  ghostData?: any;
  isBranchPlacementActive?: boolean;
  isLeafPlacementActive?: boolean;
  isBracePlacementActive?: boolean;
  branchTipPosition?: { x: number; y: number; z: number } | null;
  branchHoverPosition?: { x: number; y: number; z: number } | null;
  leafTipPosition?: { x: number; y: number; z: number } | null;
  leafHoverPosition?: { x: number; y: number; z: number } | null;

  children?: React.ReactNode;

  // Expansion Visuals
  expansionSimulator?: BasinFillSimulator | BasinFillProxy | null;
  showExpansion?: boolean;

  // Classification Visuals
  classificationFaceLabels?: Int32Array;
  classificationGeometry?: THREE.BufferGeometry;
  showClassification?: boolean;
}) {
  const meshRefs = React.useRef<Record<string, THREE.Mesh | null>>({});
  const actualMeshRefs = React.useRef<Record<string, THREE.Mesh | null>>({});

  const prevBranchHoverDotVisibleRef = React.useRef<boolean | null>(null);
  const prevLeafHoverDotVisibleRef = React.useRef<boolean | null>(null);

  const [isModelSelected, setIsModelSelected] = React.useState(true); // Track for gizmo visibility
  const [isGizmoDragging, setIsGizmoDragging] = React.useState(false);
  const initialScaleRef = React.useRef<THREE.Vector3>(new THREE.Vector3(1, 1, 1));

  const cameraRef = React.useRef<THREE.Camera | null>(null);
  const suppressNextCanvasClickRef = React.useRef(false);

  const { defaultCamera, orbitTarget, setOrbitTargetFromPoint, introBoundsSnapshot, cameraIntroRunId } = useStlLoadCameraIntro(models);

  const lastHoveredModelPointRef = React.useRef<THREE.Vector3 | null>(null);
  const onModelHoverPointChange = React.useCallback((point: THREE.Vector3 | null) => {
    lastHoveredModelPointRef.current = point;
  }, []);

  const [isCameraBelowBuildPlate, setIsCameraBelowBuildPlate] = React.useState(false);

  const updateCameraBelowBuildPlate = React.useCallback(() => {
    const cameraZ = cameraRef.current?.position?.z;
    if (typeof cameraZ !== 'number') return;

    const next = cameraZ < -0.01;
    setIsCameraBelowBuildPlate((prev) => (prev === next ? prev : next));
  }, []);

  React.useEffect(() => {
    const visible = !!branchHoverPosition && !branchTipPosition && !branchPlacementPreview;
    if (prevBranchHoverDotVisibleRef.current === null) {
      prevBranchHoverDotVisibleRef.current = visible;
      return;
    }
    if (prevBranchHoverDotVisibleRef.current !== visible) {
      prevBranchHoverDotVisibleRef.current = visible;
      console.log('[BranchHoverDot]', visible ? 'show' : 'hide', {
        pos: branchHoverPosition,
        isBranchPlacementActive,
        time: performance.now(),
      });
    }
  }, [branchHoverPosition, branchTipPosition, branchPlacementPreview, isBranchPlacementActive]);

  React.useEffect(() => {
    const visible = !!leafHoverPosition && !leafTipPosition && !leafPlacementPreview;
    if (prevLeafHoverDotVisibleRef.current === null) {
      prevLeafHoverDotVisibleRef.current = visible;
      return;
    }
    if (prevLeafHoverDotVisibleRef.current !== visible) {
      prevLeafHoverDotVisibleRef.current = visible;
      console.log('[LeafHoverDot]', visible ? 'show' : 'hide', {
        pos: leafHoverPosition,
        isLeafPlacementActive,
        time: performance.now(),
      });
    }
  }, [leafHoverPosition, leafTipPosition, leafPlacementPreview, isLeafPlacementActive]);

  // Computed refs for active model
  const activeGroupRef = React.useMemo(() => ({
    get current() { return activeModelId ? meshRefs.current[activeModelId] : null }
  }), [activeModelId]);

  const activeActualMeshRef = React.useMemo(() => ({
    get current() { return activeModelId ? actualMeshRefs.current[activeModelId] : null }
  }), [activeModelId]);



  const activeModel = React.useMemo(() => {
    if (!activeModelId) return null;
    return models.find(m => m.id === activeModelId) ?? null;
  }, [models, activeModelId]);

  const activeModelTransform = React.useMemo(() => {
    if (!activeModel) return null;
    if (transform && activeModelId === activeModel.id) return transform;
    return activeModel.transform;
  }, [activeModel, transform, activeModelId]);

  // Interaction State
  const { isDraggingHandle } = useCurveInteractionState();
  const interactionWarning = useInteractionWarning();

  // Listen for selection events to show/hide gizmo
  React.useEffect(() => {
    const handleModelClicked = () => setIsModelSelected(true);
    const handleModelDeselected = () => setIsModelSelected(false);

    window.addEventListener('model-clicked', handleModelClicked);
    window.addEventListener('model-deselected', handleModelDeselected);

    return () => {
      window.removeEventListener('model-clicked', handleModelClicked);
      window.removeEventListener('model-deselected', handleModelDeselected);
    };
  }, []);

  // Handle canvas background clicks (deselect support)
  const handleCanvasClick = React.useCallback((e: React.MouseEvent) => {
    console.log('[Canvas] handleCanvasClick fired, mode:', mode);

    // If model was just clicked, ignore this background click
    if (window.__modelClickedThisFrame) {
      console.log('[Canvas] Ignoring click (model clicked this frame)');
      return;
    }

    // If a gizmo drag just ended, ignore this click
    if (suppressNextCanvasClickRef.current || (window as any).__gizmoDragEndedThisFrame) {
      suppressNextCanvasClickRef.current = false;
      (window as any).__gizmoDragEndedThisFrame = false;
      e.stopPropagation();
      // @ts-ignore
      if (e.nativeEvent?.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
      return;
    }

    if (mode === 'prepare') {
      // Deselect model if background is clicked
      if (onActiveModelChange) {
        console.log('[Canvas] Background clicked, deselecting model');
        onActiveModelChange(null);
      }
      return;
    }

    if (mode !== 'support') return;

    // Background was clicked, deselect via V2 logic
    console.log('[Canvas] Background clicked, deselecting');
    clearSelection();
  }, [mode, onActiveModelChange]);

  React.useEffect(() => {
    updateCameraBelowBuildPlate();
  }, [updateCameraBelowBuildPlate]);

  const hidePlateContactPrimitives = isCameraBelowBuildPlate;

  const handleOrbitChange = React.useCallback(() => {
    updateCameraBelowBuildPlate();
    onCameraChange?.();
  }, [onCameraChange, updateCameraBelowBuildPlate]);

  const handleOrbitEnd = React.useCallback(() => {
    updateCameraBelowBuildPlate();
    onCameraEnd?.();
  }, [onCameraEnd, updateCameraBelowBuildPlate]);

  return (
    <div
      style={{ width: '100%', height: '100%' }}
      onClick={handleCanvasClick}
    >
      <Canvas
        style={{ width: '100%', height: '100%', backgroundColor: '#202020', display: 'block' }}
        camera={defaultCamera}
        shadows
        dpr={[1, 10]}
        gl={{ stencil: true, logarithmicDepthBuffer: true }}
      >
        <LoggingHelper mode={mode} />
        <Lights ambientIntensity={ambientIntensity ?? 1.2} directionalIntensity={directionalIntensity ?? 0.3} />
        <Helpers />
        <EnableLocalClipping />
        <CameraProvider cameraRef={cameraRef} />
        <CameraClipPlaneStabilizer />
        {/* GPU Picking Provider - wraps all pickable content when enabled */}
        <PickingProviderWrapper enabled={gpuPickingTest}>
          <PickingStateSyncer />

          {/* Selection Provider - manages model selection state */}
          <SelectionProvider initialSelection={activeModelId || "default-model"}>
            <SelectionSync activeModelId={activeModelId ?? null} />
            {/* Selection Manager - handles click-to-select/deselect logic */}
            <SelectionManager enabled={mode === 'prepare'} mode={mode} />

            <React.Suspense fallback={null}>
              {models.map(model => {
                const isActive = model.id === activeModelId;
                // Use props.transform if active (for smooth drag), else model.transform
                const transformToUse = isActive && transform ? transform : model.transform;
                // Use per-model visibility
                if (!model.visible) return null;

                return (
                  <React.Fragment key={model.id}>
                    <StlMesh
                      modelId={model.id}
                      geometry={model.geometry.geometry}
                      clipLower={clipLower}
                      clipUpper={clipUpper}
                      meshColor={model.color || meshColor} // Use model color
                      meshRef={(el: THREE.Mesh | null) => { meshRefs.current[model.id] = el; }}
                      actualMeshRef={(el: THREE.Mesh | null) => { actualMeshRefs.current[model.id] = el; }}
                      materialRoughness={materialRoughness}
                      transform={transformToUse}
                      mode={mode}
                      onSupportClick={onSupportClick}
                      onSupportHover={onSupportHover}
                      onActiveModelChange={onActiveModelChange}
                      disableRaycast={disableRaycast}
                      blockSupportPlacement={isGizmoDragging || blockSupportPlacement}
                      suppressNextClickRef={suppressNextCanvasClickRef}
                      isSelected={isActive && isModelSelected && mode === 'prepare' && selectionHighlightMode === 'tint'}
                      isBranchPlacementActive={isBranchPlacementActive}
                      isLeafPlacementActive={isLeafPlacementActive}
                      isBracePlacementActive={isBracePlacementActive}
                      onModelHoverPointChange={onModelHoverPointChange}
                    />

                    {/* Cross-section cap (fill) at the cut plane - Render per model */}
                    {clipUpper != null && !hideCrossSectionCap && (
                      <CrossSectionCap
                        geometry={model.geometry.geometry}
                        y={clipUpper}
                        color="#FFFFFF"
                        // We need the matrix for THIS model
                        transformMatrix={(() => {
                          // Duplicate logic from previous SceneCanvas to build matrix
                          const t = transformToUse;
                          if (!t) return undefined;

                          const bbox = model.geometry.bbox;
                          const center = model.geometry.center;

                          const matrix = new THREE.Matrix4();
                          matrix.compose(t.position, new THREE.Quaternion().setFromEuler(t.rotation), t.scale);
                          const offsetMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
                          matrix.multiply(offsetMatrix);
                          return matrix;
                        })()}
                        mode={crossSectionMode}
                        pxMm={pxMm}
                        visible={!hideCrossSectionCap && clipUpper != null}
                      />
                    )}
                  </React.Fragment>
                );
              })}

              {/* Raft system (Crenelated) - uses supports roots + active model footprint */}
              {!hidePlateContactPrimitives && (
                <>
                  <RaftRenderer />
                  <LineRaftRenderer />
                  <FootprintBorderRenderer
                    modelGeometry={activeModel ? activeModel.geometry : null}
                    modelTransform={activeModelTransform}
                  />
                </>
              )}

              {/* Gizmo attached to active model */}
              {mode === 'prepare' && transformMode === 'transform' && activeModelId && isModelSelected && (
                <UnifiedGizmo
                  meshRef={activeGroupRef as React.RefObject<THREE.Mesh>}
                  position={[
                    transform?.position.x ?? 0,
                    transform?.position.y ?? 0,
                    transform?.position.z ?? 0
                  ]}
                  rotation={[0, 0, 0]}
                  enableMove
                  enableRotate
                  enableScale
                  enableLighting
                  onDragStateChange={setIsGizmoDragging}
                  onMove={(delta) => {
                    if (activeGroupRef.current) {
                      activeGroupRef.current.position.add(delta);
                    }
                  }}
                  onMoveEnd={() => {
                    window.__gizmoDragEndedThisFrame = true;
                    if (activeGroupRef.current && onTransformChange) {
                      onTransformChange(
                        activeGroupRef.current.position.clone(),
                        activeGroupRef.current.rotation.clone(),
                        activeGroupRef.current.scale.clone()
                      );
                    }
                  }}
                  onRotate={(axis, angle) => {
                    if (activeGroupRef.current) {
                      const worldAxis = new THREE.Vector3(
                        axis === 'x' ? 1 : 0,
                        axis === 'y' ? 1 : 0,
                        axis === 'z' ? 1 : 0
                      );
                      const quaternion = new THREE.Quaternion().setFromAxisAngle(worldAxis, -angle);
                      activeGroupRef.current.quaternion.premultiply(quaternion);
                    }
                  }}
                  onRotateEnd={() => {
                    window.__gizmoDragEndedThisFrame = true;
                    if (activeGroupRef.current && onTransformChange) {
                      onTransformChange(
                        activeGroupRef.current.position.clone(),
                        activeGroupRef.current.rotation.clone(),
                        activeGroupRef.current.scale.clone()
                      );
                    }
                    onTransformEnd?.('rotate');
                  }}
                  onScaleStart={() => {
                    if (activeGroupRef.current) {
                      initialScaleRef.current.copy(activeGroupRef.current.scale);
                    }
                  }}
                  onScale={(axis, factor) => {
                    if (activeGroupRef.current) {
                      if (axis === 'uniform') {
                        activeGroupRef.current.scale.copy(initialScaleRef.current).multiplyScalar(factor);
                      } else {
                        activeGroupRef.current.scale.copy(initialScaleRef.current);
                        if (axis === 'x') activeGroupRef.current.scale.x *= factor;
                        if (axis === 'y') activeGroupRef.current.scale.y *= factor;
                        if (axis === 'z') activeGroupRef.current.scale.z *= factor;
                      }
                    }
                  }}
                  onScaleEnd={() => {
                    window.__gizmoDragEndedThisFrame = true;
                    if (activeGroupRef.current && onTransformChange) {
                      onTransformChange(
                        activeGroupRef.current.position.clone(),
                        activeGroupRef.current.rotation.clone(),
                        activeGroupRef.current.scale.clone()
                      );
                    }
                  }}
                />
              )}

              {/* Render supports (New V2 System) */}
              {/* Note: SupportRenderer renders supports from store. TODO: Filter by active model or show all? */}
              <SupportRenderer mode={mode} ref={supportsRef} hidePlateContactPrimitives={hidePlateContactPrimitives} />



              <IslandOverlay
                markers={islandMarkers ?? []}
                meshRef={activeActualMeshRef.current}
                brushRadiusMm={overlayBrushRadius ?? 2}
                color={overlayColor ?? '#FF0000'}
                opacity={overlayOpacity ?? 0.5}
                transform={transform}
                selectedIslandId={overlaySelectedIslandId}
                clipLower={clipLower}
                clipUpper={clipUpper}
              />

              <IslandVoxelVisualization
                scanResults={scanResults ?? null}
                layerHeightMm={layerHeightMm ?? 0.05}
                enabled={voxelEnabled ?? false}
                opacity={voxelOpacity}
                colorScheme={voxelColorScheme}
                selectedIslandId={voxelSelectedIslandId}
                showMerged={voxelShowMerged}
                showTerritory={voxelShowTerritory}
                transform={transform}
                zOffset={scanBBox?.min.z ?? 0}
                clipLower={clipLower}
                clipUpper={clipUpper}
              />

              <IslandExpansionVisualization
                simulator={expansionSimulator ?? null}
                transform={transform}
                enabled={showExpansion ?? false}
              />

              <MeshClassificationRenderer
                geometry={classificationGeometry}
                faceLabels={classificationFaceLabels}
                transform={transform}
                visible={showClassification ?? false}
              />

              {scanResults && (
                <IslandIdLabels
                  islands={scanResults.islands}
                  scanResults={scanResults}
                  layerHeightMm={layerHeightMm ?? 0.05}
                  enabled={showIslandIdLabels ?? false}
                  bboxMinZ={scanBBox?.min.z ?? 0}
                />
              )}

              {/* Render V2 Trunk Placement Preview (hide when in branch/leaf mode) */}
              {trunkPlacementPreview && !blockSupportPlacement && !isDraggingHandle && !isBranchPlacementActive && !isLeafPlacementActive && !branchPlacementPreview && (
                <SupportBuilder
                  data={trunkPlacementPreview}
                  isPreview
                  hidePlateContactPrimitives={hidePlateContactPrimitives}
                />
              )}

              {/* Render Branch Hover Preview Dot - shows when Alt is held before first click */}
              {/* Uses tip contact diameter to match actual tip size */}
              {branchHoverPosition && !branchTipPosition && !branchPlacementPreview && (
                <mesh position={[branchHoverPosition.x, branchHoverPosition.y, branchHoverPosition.z]} raycast={() => null}>
                  <sphereGeometry args={[DEFAULT_TIP_CONTACT_DIAMETER_MM / 2, 16, 16]} />
                  <meshStandardMaterial color="#00ff00" transparent opacity={0.5} emissive="#00ff00" emissiveIntensity={0.3} />
                </mesh>
              )}

              {/* Render Branch Tip Marker - only show when NO preview is visible */}
              {/* Once preview shows, the contact cone at the tip replaces this marker */}
              {isBranchPlacementActive && branchTipPosition && !branchPlacementPreview && (
                <mesh position={[branchTipPosition.x, branchTipPosition.y, branchTipPosition.z]} raycast={() => null}>
                  <sphereGeometry args={[DEFAULT_TIP_CONTACT_DIAMETER_MM / 2, 16, 16]} />
                  <meshStandardMaterial color="#00ff00" transparent opacity={0.7} />
                </mesh>
              )}

              {/* Render Branch Placement Preview - ALWAYS show when data exists */}
              {/* Don't check blockSupportPlacement - branch placement needs to work while hovering supports */}
              {branchPlacementPreview && isBranchPlacementActive && !isDraggingHandle && (
                <SupportBuilder
                  data={branchPlacementPreview}
                  isPreview
                  hidePlateContactPrimitives={hidePlateContactPrimitives}
                />
              )}

              {/* Render Leaf Hover Preview Dot - shows when Alt+Shift is held before first click */}
              {/* Uses tip contact diameter to match actual tip size */}
              {leafHoverPosition && !leafTipPosition && !leafPlacementPreview && (
                <mesh position={[leafHoverPosition.x, leafHoverPosition.y, leafHoverPosition.z]} raycast={() => null}>
                  <sphereGeometry args={[DEFAULT_TIP_CONTACT_DIAMETER_MM / 2, 16, 16]} />
                  <meshStandardMaterial color="#00ff00" transparent opacity={0.5} emissive="#00ff00" emissiveIntensity={0.3} />
                </mesh>
              )}

              {/* Render Leaf Tip Marker - only show when NO preview is visible */}
              {/* Once preview shows, the contact cone at the tip replaces this marker */}
              {isLeafPlacementActive && leafTipPosition && !leafPlacementPreview && (
                <mesh position={[leafTipPosition.x, leafTipPosition.y, leafTipPosition.z]} raycast={() => null}>
                  <sphereGeometry args={[DEFAULT_TIP_CONTACT_DIAMETER_MM / 2, 16, 16]} />
                  <meshStandardMaterial color="#00ff00" transparent opacity={0.7} />
                </mesh>
              )}

              {/* Render Leaf Placement Preview - ALWAYS show when data exists */}
              {/* Don't check blockSupportPlacement - leaf placement needs to work while hovering supports */}
              {leafPlacementPreview && !isDraggingHandle && (
                <SupportBuilder
                  data={leafPlacementPreview}
                  isPreview
                  hidePlateContactPrimitives={hidePlateContactPrimitives}
                />
              )}

              {/* Render Brace Placement Preview */}
              {bracePlacementPreview && !isDraggingHandle && (
                <BracePreviewRenderer preview={bracePlacementPreview} />
              )}

              {/* Render V2 Joint Placement Preview */}
              {jointPlacementPreview && (
                <JointPlacementPreview position={jointPlacementPreview.pos} diameter={jointPlacementPreview.diameter} />
              )}

              {/* Branch Placement Controller - handles snapping logic */}
              {mode === 'support' && <BranchPlacementController />}

              {/* Leaf Placement Controller - handles snapping logic */}
              {mode === 'support' && <LeafPlacementController />}

              {/* Brace Placement Controller - handles snapping logic */}
              {mode === 'support' && <BracePlacementController />}

              {/* LYS Ghost Viewer (Temporary) */}
              <GhostOverlay data={ghostData} visible={!!ghostData} />
            </React.Suspense>

          </SelectionProvider>
        </PickingProviderWrapper>
        {/* Selection outline - renders when model is selected */}
        <SelectionOutlineRenderer
          meshRef={activeActualMeshRef as React.RefObject<THREE.Mesh>}
          enabled={mode === 'prepare' && selectionHighlightMode === 'fresnel'}
          color="#82ccff"
          intensity={0.38}
          power={3.5}
          rimMin={0.22}
          rimMax={0.5}
          alphaCut={0.03}
        />
        {/* Selection spotlight - illuminates only the selected model via layers */}
        <SelectionSpotlight
          meshRef={activeActualMeshRef as React.RefObject<THREE.Mesh>}
          enabled={mode === 'prepare' && isModelSelected && selectionHighlightMode === 'spotlight'}
          color="#ffeacc"
          intensity={1.5}
          angle={Math.PI / 3}
          penumbra={0}
          elevation={60}
          radius={60}
          affectAll
        />
        <OrbitControls
          makeDefault
          enableDamping={false}
          enabled={!isGizmoDragging}
          onChange={handleOrbitChange}
          onEnd={handleOrbitEnd}
          target={orbitTarget}
          mouseButtons={
            mode === 'support'
              ? { MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
              : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
          }
        />
        <CameraFocusHotkeyController
          hoverPointRef={lastHoveredModelPointRef}
          setOrbitTargetFromPoint={setOrbitTargetFromPoint}
        />
        <CameraIntroController
          bounds={introBoundsSnapshot}
          runId={cameraIntroRunId}
          onComplete={() => { }}
        />
        <CameraFocusController
          selectedIslandId={overlaySelectedIslandId ?? null}
          islandMarkers={islandMarkers ?? []}
        />
        {/* Selection outline effect - rendered by SelectionOutlineRenderer inside SelectionProvider */}
        {children}
      </Canvas>

      {/* Support Limitation Tooltip Overlay */}
      <SupportLimitationFeedback
        error={leafPlacementPreview?.error ?? (isBranchPlacementActive ? branchPlacementPreview?.error : null) ?? trunkPlacementPreview?.error ?? null}
        warning={
          leafPlacementPreview?.warning ??
          (isBranchPlacementActive ? branchPlacementPreview?.warning : null) ??
          trunkPlacementPreview?.warning ??
          interactionWarning ??
          null
        }
      />

      {/* GPU Picking Debug Overlay - shows what's under cursor */}
      {gpuPickingTest && <PickingDebugOverlay position="top-right" />}
    </div>
  );
}
export const SceneCanvas = SceneCanvasComponent;

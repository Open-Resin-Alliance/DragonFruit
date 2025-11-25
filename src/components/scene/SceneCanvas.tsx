"use client";

import React, { useEffect } from 'react';
import dynamic from 'next/dynamic';
import * as THREE from 'three';
import { OrbitControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { CrossSectionCap } from '@/components/scene/CrossSectionCap';
import { IslandOverlay } from '@/components/scene/IslandOverlay';
import { IslandVoxelVisualization } from '@/components/scene/IslandVoxelVisualization';
import { IslandIdLabels } from '@/components/scene/IslandIdLabels';
import { AxisLabels } from '@/components/scene/AxisLabels';
import { ScreenSpaceGizmo as UnifiedGizmo } from '@/components/gizmo';
import { CameraFocusController } from '@/components/scene/CameraFocusController';
import { PickingProvider, PickingDebugOverlay } from '@/components/picking';
import { SelectionProvider, SelectionManager, SelectionOutlineRenderer } from '@/components/selection';
import type { IslandMarker } from '@/modules/island/islandOverlayLogic';
import type { ScanResults } from '@/modules/island/ScanOrchestrator';
import type { TransformMode, ModelTransform } from '@/hooks/useModelTransform';
import type { SupportMode, SupportInstance, SupportSettings } from '@/supports/types';
import { SupportRenderer } from '@/supports/SupportRenderer';
import { SupportPreview } from '@/supports/SupportPreview';
import BranchPreview from '../../supports/BranchSupports/rendering/BranchPreview';
import { JointPreviewSphere } from '@/supports/components/JointPreviewSphere';
import RaftRenderer from '@/supports/Rafts/Crenelated/rendering/RaftRenderer';
import FootprintBorderRenderer from '@/supports/Rafts/Crenelated/rendering/FootprintBorderRenderer';
import { getCurrentSupportSettings, addJointToSupport, updateJointPosition, updateJointPositionLive } from '@/supports/state';
import { constrainBranchJointToShaft } from '@/supports/BranchSupports/constraints/branchJointConstraint';
import { updateBranchJointsForParent } from '@/supports/BranchSupports/constraints/updateBranchJoints';

const Canvas = dynamic(() => import('@react-three/fiber').then(m => m.Canvas), { ssr: false });

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

/**
 * Wrapper that conditionally applies PickingProvider.
 * When disabled, just renders children directly.
 */
function PickingProviderWrapper({ enabled, children }: { enabled?: boolean; children: React.ReactNode }) {
  if (enabled) {
    return <PickingProvider debug>{children}</PickingProvider>;
  }
  return <>{children}</>;
}

function Helpers() {
  return (
    <>
      {/* Grid on XY plane (horizontal) - rotate 90° around X */}
      <gridHelper args={[200, 40, '#333333', '#333333']} position={[0, 0, 0]} rotation={[Math.PI / 2, 0, 0]} />
      {/* Axes: X=red, Y=green, Z=blue(up) */}
      <axesHelper args={[100]} />
      <AxisLabels size={100} />
    </>
  );
}

function StlMesh({ geometry, clipLower, clipUpper, meshColor, meshRef, actualMeshRef, materialRoughness, transform, mode, onSupportClick, onSupportHover, onSupportSelect, disableRaycast, blockSupportPlacement, suppressNextClickRef, modelId }: {
  geometry: THREE.BufferGeometry;
  clipLower?: number | null;
  clipUpper?: number | null;
  meshColor?: string;
  /** Ref to the group (for gizmo positioning) */
  meshRef?: React.RefObject<THREE.Mesh | null>;
  /** Ref to the actual mesh (for outline effect) */
  actualMeshRef?: React.MutableRefObject<THREE.Mesh | null>;
  materialRoughness?: number;
  transform?: ModelTransform | null;
  mode?: SupportMode;
  onSupportClick?: (hit: THREE.Intersection) => void;
  onSupportHover?: (hit: THREE.Intersection | null) => void;
  onSupportSelect?: (id: string | null) => void;
  disableRaycast?: boolean;
  blockSupportPlacement?: boolean;
  suppressNextClickRef?: React.RefObject<boolean>;
  /** Model ID for picking registration */
  modelId?: string;
}) {
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
    console.log(`[${new Date().toISOString()}] [SceneCanvas] StlMesh received new geometry`);
  }, [geometry]);

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
      ref={meshRef as any}
      position={transform?.position || new THREE.Vector3(0, 0, 0)}
      rotation={transform?.rotation || new THREE.Euler(0, 0, 0)}
      scale={transform?.scale || new THREE.Vector3(1, 1, 1)}
    >
      <mesh
          ref={(node) => {
            // Assign to refs
            internalMeshRef.current = node;
            if (actualMeshRef) actualMeshRef.current = node;
          }}
          geometry={geometry}
          position={new THREE.Vector3(-centerOffset.x, -centerOffset.y, -centerOffset.z)}
          castShadow
          receiveShadow
          onClick={(e) => {
          console.log('[SceneCanvas] Mesh clicked, mode:', mode);
          
          // Model selection in prepare mode - dispatch custom event
          if (mode === 'prepare') {
            e.stopPropagation();
            window.__modelClickedThisFrame = true;
            window.dispatchEvent(new CustomEvent('model-clicked', { 
              detail: { modelId: modelId || 'default-model' } 
            }));
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
            if (onSupportSelect) onSupportSelect(null);

            if (onSupportClick) {
              console.log('[SceneCanvas Mesh] Calling onSupportClick with event');
              e.stopPropagation();
              onSupportClick(e);
            }
          }
        }}
        onPointerMove={(e) => {
          if (mode === 'support' && onSupportHover) {
            // Mute hover when placement is blocked
            if (blockSupportPlacement) return;
            e.stopPropagation();
            onSupportHover(e);
          }
        }}
        onPointerOut={() => {
          if (mode === 'support' && onSupportHover) {
            onSupportHover(null);
          }
        }}
      >
        <meshStandardMaterial
          vertexColors
          color="#ffffff"
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

export function SceneCanvas({
  geom,
  clipLower,
  clipUpper,
  meshColor,
  meshVisible,
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
  voxelOpacity,
  transformMode,
  transform,
  onTransformChange,
  onTransformEnd,
  crossSectionMode,
  pxMm,
  showIslandIdLabels,
  mode,
  supports,
  onSupportClick,
  onSupportHover,
  supportPreview,
  selectedSupportId,
  onSupportSelect,
  hoveredSupportId,
  onSupportHoverChange,
  jointCreationMode,
  jointPreview,
  onJointPreviewChange,
  selectedJointId,
  onJointSelect,
  hoveredJointId,
  onJointHoverChange,
  branchPreviewState,
  branchStateRef,
  branchBasePosition,
  leafPreviewState,
  leafStateRef,
  leafSocketPosition,
  gpuPickingTest = false,
}: {
  geom: GeometryWithBounds | null;
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
  voxelOpacity?: number;
  transformMode?: TransformMode;
  transform?: ModelTransform;
  onTransformChange?: (position: THREE.Vector3, rotation: THREE.Euler, scale: THREE.Vector3) => void;
  onTransformEnd?: (operation: 'move' | 'rotate' | 'scale') => void;
  crossSectionMode?: 'smooth' | 'rasterized';
  pxMm?: number;
  showIslandIdLabels?: boolean;
  mode?: SupportMode;
  supports?: SupportInstance[];
  onSupportClick?: (hit: THREE.Intersection) => void;
  onSupportHover?: (hit: THREE.Intersection | null) => void;
  supportPreview?: { tip: { x: number; y: number; z: number }; base: { x: number; y: number; z: number }; tipNormal: { x: number; y: number; z: number }; validationLevel?: 'valid' | 'invalid'; joints?: any[]; parentBaseId?: string | null } | null;
  selectedSupportId?: string | null;
  onSupportSelect?: (id: string | null) => void;
  hoveredSupportId?: string | null;
  onSupportHoverChange?: (id: string | null) => void;
  jointCreationMode?: boolean;
  jointPreview?: { supportId: string; position: { x: number; y: number; z: number }; segmentIndex: number } | null;
  onJointPreviewChange?: (preview: { supportId: string; position: { x: number; y: number; z: number }; segmentIndex: number } | null) => void;
  selectedJointId?: string | null;
  onJointSelect?: (id: string | null) => void;
  hoveredJointId?: string | null;
  onJointHoverChange?: (id: string | null) => void;
  branchPreviewState?: import('@/supports/BranchSupports/types').BranchPlacementState;
  branchStateRef?: React.RefObject<import('@/supports/BranchSupports/types').BranchPlacementState>;
  branchBasePosition?: import('@/supports/types').Vec3 | null;
  leafPreviewState?: import('@/supports/LeafSupports/types').LeafPlacementState;
  leafStateRef?: React.RefObject<import('@/supports/LeafSupports/types').LeafPlacementState>;
  leafSocketPosition?: import('@/supports/types').Vec3 | null;
  /** Enable GPU picking test mode - shows test gizmo and debug overlay */
  gpuPickingTest?: boolean;
}) {
  const meshRef = React.useRef<THREE.Mesh>(null);
  const actualMeshRef = React.useRef<THREE.Mesh | null>(null);
  const [isModelSelected, setIsModelSelected] = React.useState(true); // Track for gizmo visibility
  const [isGizmoDragging, setIsGizmoDragging] = React.useState(false);
  const initialScaleRef = React.useRef<THREE.Vector3>(new THREE.Vector3(1, 1, 1));
  const [mouseScreenY, setMouseScreenY] = React.useState<number>(0.5); // 0 = top, 1 = bottom
  const [mouseScreenPos, setMouseScreenPos] = React.useState<{ x: number; y: number }>({ x: 0.5, y: 0.5 }); // NDC coords
  const onJointPreviewChangeRef = React.useRef(onJointPreviewChange);
  const supportsRef = React.useRef(supports);
  const lastHoveredSupportRef = React.useRef<string | null>(null);
  const cameraRef = React.useRef<THREE.Camera | null>(null);
  const canvasSizeRef = React.useRef({ width: 0, height: 0 });
  // Live-selected joint info and position ref for gizmo (must be stable hooks order)
  const jointLivePosRef = React.useRef<THREE.Vector3 | null>(null);
  // Suppress the very next canvas click after gizmo drag ends
  const suppressNextCanvasClickRef = React.useRef(false);
  const selectedJointInfo = React.useMemo(() => {
    if (!supports || !selectedJointId) return null;
    for (const s of supports) {
      const j = s.joints?.find(j => j.id === selectedJointId);
      if (j) {
        return { supportId: s.id, position: j.position } as {
          supportId: string;
          position: { x: number; y: number; z: number };
        };
      }
    }
    return null;
  }, [supports, selectedJointId]);

  // Keep live position in sync when selection changes
  React.useEffect(() => {
    if (selectedJointInfo) {
      if (!jointLivePosRef.current) {
        jointLivePosRef.current = new THREE.Vector3(
          selectedJointInfo.position.x,
          selectedJointInfo.position.y,
          selectedJointInfo.position.z
        );
      } else {
        jointLivePosRef.current.set(
          selectedJointInfo.position.x,
          selectedJointInfo.position.y,
          selectedJointInfo.position.z
        );
      }
    } else {
      jointLivePosRef.current = null;
    }
  }, [selectedJointInfo]);

  // Keep refs updated
  React.useEffect(() => {
    onJointPreviewChangeRef.current = onJointPreviewChange;
    supportsRef.current = supports;
  }, [onJointPreviewChange, supports]);

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

  // Update joint preview position based on mouse screen Y and joint creation mode
  React.useEffect(() => {
    const callback = onJointPreviewChangeRef.current;
    if (!callback) return;
    // If not in joint creation mode, do nothing (parent clears on keyup)
    if (!jointCreationMode) return;

    // In joint creation mode, use hovered support OR last hovered support
    if (jointCreationMode) {
      // Update last hovered if we're currently hovering
      if (hoveredSupportId) {
        lastHoveredSupportRef.current = hoveredSupportId;
      }

      const targetSupportId = lastHoveredSupportRef.current;

      if (targetSupportId && supportsRef.current) {
        const support = supportsRef.current.find(s => s.id === targetSupportId);
        if (support) {
          // Calculate shaft endpoints based on support type
          const tipLength = support.settings.tip.lengthMm;
          const baseHeight = support.settings.base.heightMm;
          const tipNormal = support.tipNormal;
          const tipDir = { x: tipNormal.x, y: tipNormal.y, z: tipNormal.z };
          const isBranch = !!support.parentBaseId;

          const tipEnd = {
            x: support.tip.x + tipDir.x * tipLength,
            y: support.tip.y + tipDir.y * tipLength,
            z: support.tip.z + tipDir.z * tipLength,
          };

          let shaftEnd: { x: number; y: number; z: number };
          if (isBranch) {
            // For branches: shaft ends at branch joint
            const branchJoint = support.joints?.find(j => j.type === 'branch');
            if (branchJoint) {
              shaftEnd = branchJoint.position;
            } else {
              // Fallback: use base if no branch joint
              shaftEnd = support.base;
            }
          } else {
            // For trunks: shaft ends at base top
            shaftEnd = {
              x: support.base.x,
              y: support.base.y,
              z: support.base.z + baseHeight,
            };
          }

          // Project shaft endpoints to screen space for accurate mapping
          let t = mouseScreenY;

          if (cameraRef.current) {
            const camera = cameraRef.current;

            // Project shaft start and end to screen space
            const tipEndVec = new THREE.Vector3(tipEnd.x, tipEnd.y, tipEnd.z);
            const shaftEndVec = new THREE.Vector3(shaftEnd.x, shaftEnd.y, shaftEnd.z);

            tipEndVec.project(camera);
            shaftEndVec.project(camera);

            // Convert from NDC (-1 to 1) to screen space (0 to 1)
            const tipScreenY = (1 - tipEndVec.y) / 2;
            const shaftScreenY = (1 - shaftEndVec.y) / 2;

            // Map mouse Y relative to shaft's screen position
            if (Math.abs(shaftScreenY - tipScreenY) > 0.001) {
              t = (mouseScreenY - tipScreenY) / (shaftScreenY - tipScreenY);
              t = Math.max(0, Math.min(1, t));
            }
          } else {
            // Fallback to sensitivity-based mapping if camera not available
            const sensitivity = 1.3;
            const adjustedY = (mouseScreenY - 0.5) * sensitivity + 0.5;
            t = Math.max(0, Math.min(1, adjustedY));
          }

          // Build current shaft path: tipEnd -> joints (in order) -> shaftEnd
          const joints = (support.joints || []).slice().sort((a, b) => a.order - b.order);
          const pathPoints: THREE.Vector3[] = [
            new THREE.Vector3(tipEnd.x, tipEnd.y, tipEnd.z),
            ...joints.map(j => new THREE.Vector3(j.position.x, j.position.y, j.position.z)),
            new THREE.Vector3(shaftEnd.x, shaftEnd.y, shaftEnd.z),
          ];

          // Compute total length
          const segLengths: number[] = [];
          let totalLen = 0;
          for (let i = 0; i < pathPoints.length - 1; i++) {
            const len = pathPoints[i].distanceTo(pathPoints[i + 1]);
            segLengths.push(len);
            totalLen += len;
          }

          // Find position along the polyline at distance d = t * totalLen
          let d = t * totalLen;
          let pos = new THREE.Vector3(pathPoints[0].x, pathPoints[0].y, pathPoints[0].z);
          for (let i = 0; i < segLengths.length; i++) {
            if (d <= segLengths[i]) {
              const a = pathPoints[i];
              const b = pathPoints[i + 1];
              const lt = segLengths[i] === 0 ? 0 : d / segLengths[i];
              pos.set(
                a.x + (b.x - a.x) * lt,
                a.y + (b.y - a.y) * lt,
                a.z + (b.z - a.z) * lt,
              );
              break;
            }
            d -= segLengths[i];
            if (i === segLengths.length - 1) {
              pos.copy(pathPoints[pathPoints.length - 1]);
            }
          }

          const position = { x: pos.x, y: pos.y, z: pos.z };

          callback({
            supportId: targetSupportId,
            position,
            segmentIndex: 0,
          });
        } else {
          callback(null);
        }
      } else {
        callback(null);
      }
    } else {
      // Clear last hovered when exiting joint creation mode
      lastHoveredSupportRef.current = null;
    }
  }, [jointCreationMode, hoveredSupportId, mouseScreenY]);

  // Compute 3D world position for branch base-follow from screen coords
  const branchBaseWorldPos = React.useMemo(() => {
    if (!branchPreviewState || branchPreviewState.stage === 'idle' || !branchPreviewState.contact || !cameraRef.current) {
      return null;
    }

    // Use contact point Z as the depth plane for unprojection
    const contactZ = branchPreviewState.contact.z;
    const camera = cameraRef.current;

    // Convert screen coords (0-1) to NDC (-1 to 1)
    const ndcX = mouseScreenPos.x * 2 - 1;
    const ndcY = -(mouseScreenPos.y * 2 - 1); // Y is flipped in NDC

    // Unproject at contact Z depth
    const contactVec = new THREE.Vector3(branchPreviewState.contact.x, branchPreviewState.contact.y, branchPreviewState.contact.z);
    contactVec.project(camera);

    // Use contact's NDC Z for consistent depth
    const worldPos = new THREE.Vector3(ndcX, ndcY, contactVec.z);
    worldPos.unproject(camera);

    return { x: worldPos.x, y: worldPos.y, z: worldPos.z };
  }, [branchPreviewState, mouseScreenPos]);

  // Compute 3D world position for leaf socket-follow from screen coords
  const leafSocketWorldPos = React.useMemo(() => {
    if (!leafPreviewState || !leafPreviewState.isActive || !leafPreviewState.contactPoint || !cameraRef.current) {
      return null;
    }

    // Use contact point Z as the depth plane for unprojection
    const contactZ = leafPreviewState.contactPoint.z;
    const camera = cameraRef.current;

    // Convert screen coords (0-1) to NDC (-1 to 1)
    const ndcX = mouseScreenPos.x * 2 - 1;
    const ndcY = -(mouseScreenPos.y * 2 - 1); // Y is flipped in NDC

    // Unproject at contact Z depth
    const contactVec = new THREE.Vector3(leafPreviewState.contactPoint.x, leafPreviewState.contactPoint.y, leafPreviewState.contactPoint.z);
    contactVec.project(camera);

    // Use contact's NDC Z for consistent depth
    const worldPos = new THREE.Vector3(ndcX, ndcY, contactVec.z);
    worldPos.unproject(camera);

    return { x: worldPos.x, y: worldPos.y, z: worldPos.z };
  }, [leafPreviewState, mouseScreenPos]);

  // Trigger snap logic when branch base world position updates
  const branchBasePosRef = React.useRef(branchBaseWorldPos);
  React.useEffect(() => {
    branchBasePosRef.current = branchBaseWorldPos;
  }, [branchBaseWorldPos]);

  React.useEffect(() => {
    if (branchBasePosRef.current && onSupportHover) {
      // Call hover handler with computed world position for snap logic
      // Use a fake intersection object with just the point we need
      const fakeHit = {
        point: new THREE.Vector3(branchBasePosRef.current.x, branchBasePosRef.current.y, branchBasePosRef.current.z),
        object: { userData: {} }, // Prevent userData errors
        // Add camera position for depth-aware snapping
        cameraPosition: cameraRef.current ? {
          x: cameraRef.current.position.x,
          y: cameraRef.current.position.y,
          z: cameraRef.current.position.z
        } : undefined
      } as any;
      onSupportHover(fakeHit);
    }
  }, [mouseScreenPos.x, mouseScreenPos.y, branchPreviewState?.stage]); // Only trigger on mouse move or stage change

  // Trigger snap logic when leaf socket world position updates
  const leafSocketPosRef = React.useRef(leafSocketWorldPos);
  React.useEffect(() => {
    leafSocketPosRef.current = leafSocketWorldPos;
  }, [leafSocketWorldPos]);

  React.useEffect(() => {
    if (leafSocketPosRef.current && onSupportHover) {
      // Call hover handler with computed world position for snap logic
      // Use a fake intersection object with just the point we need
      const fakeHit = {
        point: new THREE.Vector3(leafSocketPosRef.current.x, leafSocketPosRef.current.y, leafSocketPosRef.current.z),
        object: { userData: {} }, // Prevent userData errors
        // Add camera position for depth-aware snapping
        cameraPosition: cameraRef.current ? {
          x: cameraRef.current.position.x,
          y: cameraRef.current.position.y,
          z: cameraRef.current.position.z
        } : undefined
      } as any;
      onSupportHover(fakeHit);
    }
  }, [mouseScreenPos.x, mouseScreenPos.y, leafPreviewState?.isActive]); // Only trigger on mouse move or leaf active state change

  // Calculate center offset for mesh positioning
  const centerOffset = React.useMemo(() => {
    if (!geom) return undefined;
    const bbox = geom.geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(geom.geometry.getAttribute('position') as THREE.BufferAttribute);
    return bbox.getCenter(new THREE.Vector3());
  }, [geom]);

  // Build transform matrix from transform state
  // Must account for the mesh offset inside the group
  const transformMatrix = React.useMemo(() => {
    if (!transform || !geom) return undefined;

    // Calculate center offset
    const bbox = geom.geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(geom.geometry.getAttribute('position') as THREE.BufferAttribute);
    const center = bbox.getCenter(new THREE.Vector3());

    // Build transform: translate to group position, rotate, scale, then apply mesh offset
    const matrix = new THREE.Matrix4();

    // Start with group transform
    matrix.compose(transform.position, new THREE.Quaternion().setFromEuler(transform.rotation), transform.scale);

    // Apply the mesh offset (geometry centering)
    const offsetMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
    matrix.multiply(offsetMatrix);

    return matrix;
  }, [
    transform?.position.x,
    transform?.position.y,
    transform?.position.z,
    transform?.rotation.x,
    transform?.rotation.y,
    transform?.rotation.z,
    transform?.scale.x,
    transform?.scale.y,
    transform?.scale.z,
    geom
  ]);

  // Track if we clicked on a support to prevent deselection
  const supportClickedRef = React.useRef(false);

  // Map joint events from SupportRenderer to parent setters and prevent background deselect
  const handleJointSelect = React.useCallback((supportId: string, jointId: string) => {
    // Prevent canvas background handler from deselecting
    supportClickedRef.current = true;
    // Select the parent support if not already
    if (onSupportSelect) onSupportSelect(supportId);
    // Select the joint
    if (onJointSelect) onJointSelect(jointId);
  }, [onSupportSelect, onJointSelect]);

  const handleJointHoverChange = React.useCallback((supportId: string, jointId: string | null) => {
    if (onJointHoverChange) onJointHoverChange(jointId);
  }, [onJointHoverChange]);

  // Handle mouse move to track screen position for joint preview and branch base-follow
  const handleMouseMove = React.useCallback((e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width; // 0 = left, 1 = right
    const y = (e.clientY - rect.top) / rect.height; // 0 = top, 1 = bottom
    setMouseScreenY(y);
    setMouseScreenPos({ x, y });
  }, []);

  // Handle canvas background clicks (deselect support OR create joint OR finalize branch)
  // Note: Model selection/deselection is handled by SelectionManager
  const handleCanvasClick = React.useCallback((e: React.MouseEvent) => {
    console.log('[Canvas] handleCanvasClick fired, mode:', mode, 'branchStage:', branchPreviewState?.stage);
    
    // In prepare mode, selection is handled by SelectionManager
    if (mode === 'prepare') {
      return;
    }
    
    if (mode !== 'support') return;

    // If a gizmo drag just ended, ignore this click (prevents unintended deselect)
    if (suppressNextCanvasClickRef.current) {
      suppressNextCanvasClickRef.current = false;
      // Prevent any parent handlers (like support placement) from seeing this click
      e.stopPropagation();
      // Some environments also need native stop
      // @ts-ignore
      if (e.nativeEvent?.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
      return;
    }

    // If currently dragging the gizmo, do not allow any clicks
    if (isGizmoDragging) {
      e.stopPropagation();
      // @ts-ignore
      if (e.nativeEvent?.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
      return;
    }

    // If a joint is selected and background is clicked, deselect it
    if (selectedJointId && !supportClickedRef.current) {
      console.log('[Canvas] Background clicked with joint selected, deselecting joint');
      if (onJointSelect) onJointSelect(null);
      e.stopPropagation();
      // @ts-ignore
      if (e.nativeEvent?.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
      return;
    }

    // If in joint creation mode, create joint at preview position
    if (jointCreationMode && jointPreview) {
      console.log('[Joint Creation] Creating joint at position:', jointPreview.position);
      addJointToSupport(jointPreview.supportId, jointPreview.position);
      e.stopPropagation();
      // @ts-ignore
      if (e.nativeEvent?.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
      return;
    }

    // If in leaf placement mode (waiting for second click), finalize leaf placement
    const leafHasContact = leafStateRef?.current?.contactPoint;
    if (leafHasContact && onSupportClick) {
      console.log('[Canvas] Leaf contact set - finalizing on click');
      // Call onSupportClick with empty hit to trigger leaf finalization
      onSupportClick({} as any);
      e.stopPropagation();
      // @ts-ignore
      if (e.nativeEvent?.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
      return;
    }

    // If in branch base-follow mode, finalize branch placement
    const branchStage = branchStateRef?.current?.stage || branchPreviewState?.stage;
    console.log('[Canvas] Checking branch stage:', branchStage);
    if (branchStage === 'baseFollow' && onSupportClick) {
      console.log('[Canvas] Branch base-follow click detected - finalizing');
      // Call onSupportClick with empty hit to trigger branch finalization
      onSupportClick({} as any);
      e.stopPropagation();
      // @ts-ignore
      if (e.nativeEvent?.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
      return;
    }

    // If a support was clicked, the flag will be set
    if (supportClickedRef.current) {
      // Reset the flag
      supportClickedRef.current = false;
    } else {
      // Background was clicked, deselect
      console.log('[Canvas] Background clicked, deselecting');
      // Clear any selected joint
      if (onJointSelect) onJointSelect(null);
      // Clear any selected support
      if (onSupportSelect) onSupportSelect(null);
      // Reset the flag
      supportClickedRef.current = false;
    }
  }, [mode, onSupportSelect, onJointSelect, jointCreationMode, jointPreview]);

  return (
    <div
      style={{ width: '100%', height: '100%' }}
      onClick={handleCanvasClick}
      onMouseMove={handleMouseMove}
    >
      <Canvas
        style={{ width: '100%', height: '100%', backgroundColor: '#202020' }}
        camera={{ position: [150, 150, 150], fov: 50, up: [0, 0, 1] }}
        shadows
      >
        <Lights ambientIntensity={ambientIntensity ?? 1.2} directionalIntensity={directionalIntensity ?? 0.3} />
        <Helpers />
        <EnableLocalClipping />
        <CameraProvider cameraRef={cameraRef} />
        {/* GPU Picking Provider - wraps all pickable content when enabled */}
        <PickingProviderWrapper enabled={gpuPickingTest}>
          {/* Selection Provider - manages model selection state */}
          <SelectionProvider initialSelection="default-model">
            {/* Selection Manager - handles click-to-select/deselect logic */}
            <SelectionManager enabled={mode === 'prepare'} mode={mode} />
            
            <React.Suspense fallback={null}>
              {geom && (
              <>
                {/* Raft renders when enabled; no separate preview mode */}
                <RaftRenderer />
                {/* Footprint border shows combined model + raft outline with margin */}
                <FootprintBorderRenderer modelGeometry={geom} modelTransform={transform} />
                {meshVisible !== false && (
                  <StlMesh
                    geometry={geom.geometry}
                    clipLower={clipLower}
                    clipUpper={clipUpper}
                    meshColor={meshColor}
                    meshRef={meshRef}
                    actualMeshRef={actualMeshRef}
                    materialRoughness={materialRoughness}
                    transform={transform}
                    mode={mode}
                    onSupportClick={onSupportClick}
                    onSupportHover={onSupportHover}
                    onSupportSelect={onSupportSelect}
                    disableRaycast={disableRaycast}
                    blockSupportPlacement={isGizmoDragging || !!selectedJointId}
                    suppressNextClickRef={suppressNextCanvasClickRef}
                    modelId="default-model"
                  />
                )}
              {/* Cross-section cap (fill) at the cut plane */}
              {clipLower != null && !hideCrossSectionCap && (
                <CrossSectionCap
                  geometry={geom.geometry}
                  y={clipLower}
                  color={meshColor}
                  transformMatrix={transformMatrix}
                  mode={crossSectionMode}
                  pxMm={pxMm}
                  visible={!hideCrossSectionCap && clipLower != null}
                />
              )}
              {islandMarkers && islandMarkers.length > 0 && meshRef.current && (
                <IslandOverlay
                  markers={islandMarkers}
                  meshRef={meshRef.current}
                  brushRadiusMm={overlayBrushRadius ?? 2.0}
                  color={overlayColor ?? '#ff1744'}
                  opacity={overlayOpacity ?? 0.6}
                  transform={transform}
                  centerOffset={centerOffset}
                  selectedIslandId={overlaySelectedIslandId}
                  clipLower={clipLower}
                  clipUpper={clipUpper}
                />
              )}
              {showIslandIdLabels && scanResults && layerHeightMm && geom && (
                <IslandIdLabels
                  islands={scanResults.islands}
                  scanResults={scanResults}
                  layerHeightMm={layerHeightMm}
                  enabled={true}
                  bboxMinZ={geom.bbox.min.z}
                />
              )}
              {voxelEnabled && scanResults && layerHeightMm && (
                <IslandVoxelVisualization
                  scanResults={scanResults}
                  layerHeightMm={layerHeightMm}
                  enabled={voxelEnabled}
                  opacity={voxelOpacity}
                  colorScheme={voxelColorScheme}
                  selectedIslandId={voxelSelectedIslandId}
                  showMerged={voxelShowMerged}
                  centerOffset={centerOffset}
                  zOffset={scanBBox?.min.z ?? 0}
                  clipLower={clipLower}
                  clipUpper={clipUpper}
                  transform={transform}
                />
              )}
              {/* Branch Preview (Alt-held branch placement) */}
              {branchPreviewState && branchPreviewState.stage !== 'idle' && (
                // Lazy import to avoid direct coupling
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                (() => {
                  const BranchPreview = require('@/supports/BranchSupports/rendering/BranchPreview').default;
                  return (
                    <BranchPreview
                      state={branchPreviewState}
                      basePosition={branchBaseWorldPos || branchBasePosition || null}
                      supports={supports}
                    />
                  );
                })()
              )}
              {/* Leaf Preview (Ctrl+Alt-held leaf placement) */}
              {leafPreviewState && leafPreviewState.isActive && leafPreviewState.contactPoint && (
                // Lazy import to avoid direct coupling
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                (() => {
                  const LeafPreview = require('@/supports/LeafSupports/rendering/LeafPreview').default;
                  return (
                    <LeafPreview
                      state={leafPreviewState}
                      socketPosition={leafSocketWorldPos || leafSocketPosition || null}
                    />
                  );
                })()
              )}
              {transformMode === 'transform' && meshRef.current && isModelSelected && (
                <UnifiedGizmo
                  meshRef={meshRef}
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
                    if (meshRef.current) {
                      meshRef.current.position.add(delta);
                    }
                  }}
                  onMoveEnd={() => {
                    window.__gizmoDragEndedThisFrame = true;
                    if (meshRef.current && onTransformChange) {
                      onTransformChange(
                        meshRef.current.position.clone(),
                        meshRef.current.rotation.clone(),
                        meshRef.current.scale.clone()
                      );
                    }
                  }}
                  onRotate={(axis, angle) => {
                    if (meshRef.current) {
                      const worldAxis = new THREE.Vector3(
                        axis === 'x' ? 1 : 0,
                        axis === 'y' ? 1 : 0,
                        axis === 'z' ? 1 : 0
                      );
                      const quaternion = new THREE.Quaternion().setFromAxisAngle(worldAxis, -angle);
                      meshRef.current.quaternion.premultiply(quaternion);
                    }
                  }}
                  onRotateEnd={() => {
                    window.__gizmoDragEndedThisFrame = true;
                    if (meshRef.current && onTransformChange) {
                      onTransformChange(
                        meshRef.current.position.clone(),
                        meshRef.current.rotation.clone(),
                        meshRef.current.scale.clone()
                      );
                    }
                    onTransformEnd?.('rotate');
                  }}
                  onScaleStart={() => {
                    if (meshRef.current) {
                      initialScaleRef.current.copy(meshRef.current.scale);
                    }
                  }}
                  onScale={(axis, factor) => {
                    if (meshRef.current) {
                      if (axis === 'uniform') {
                        meshRef.current.scale.copy(initialScaleRef.current).multiplyScalar(factor);
                      } else {
                        meshRef.current.scale.copy(initialScaleRef.current);
                        if (axis === 'x') meshRef.current.scale.x *= factor;
                        if (axis === 'y') meshRef.current.scale.y *= factor;
                        if (axis === 'z') meshRef.current.scale.z *= factor;
                      }
                    }
                  }}
                  onScaleEnd={() => {
                    window.__gizmoDragEndedThisFrame = true;
                    if (meshRef.current && onTransformChange) {
                      onTransformChange(
                        meshRef.current.position.clone(),
                        meshRef.current.rotation.clone(),
                        meshRef.current.scale.clone()
                      );
                    }
                  }}
                />
              )}
            </>
          )}
          {/* Render supports */}
          {supports && supports.length > 0 && (() => {
            const branchStage = branchStateRef?.current?.stage || branchPreviewState?.stage || 'idle';
            const isInBranchFollow = branchStage === 'baseFollow';
            const leafHasContact = leafStateRef?.current?.contactPoint;
            const isInLeafPlacement = !!leafHasContact;
            return (
              <SupportRenderer
                supports={supports}
                selectedId={selectedSupportId}
                onSelect={
                  // Disable support selection during branch base-follow mode OR leaf placement mode
                  (isInBranchFollow || isInLeafPlacement) ? undefined : onSupportSelect
                }
                hoveredId={
                  (isGizmoDragging || jointCreationMode || branchStateRef?.current?.stage === 'baseFollow' || branchPreviewState?.stage === 'baseFollow')
                    ? null
                    : (selectedJointInfo && hoveredSupportId === selectedJointInfo.supportId)
                      ? null
                      : hoveredSupportId
                }
                onHoverChange={onSupportHoverChange}
                supportClickedRef={supportClickedRef}
                selectedJointId={selectedJointId}
                onJointSelect={handleJointSelect}
                hoveredJointId={isGizmoDragging ? null : hoveredJointId}
                onJointHoverChange={handleJointHoverChange}
                jointCreationMode={jointCreationMode}
              />
            );
          })()}
          {/* Render support preview (disabled during joint creation, gizmo drag, or when a joint is selected) */}
          {supportPreview && (
            // Lazy import to avoid direct coupling
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            (() => {
              const BranchPreview = require('@/supports/BranchSupports/rendering/BranchPreview').default;
              return supportPreview.parentBaseId ? (
                <BranchPreview
                  state={{
                    contact: supportPreview.tip,
                    contactNormal: supportPreview.tipNormal || { x: 0, y: 1, z: 0 },
                    snap: {
                      position: supportPreview.base,
                      trunkId: supportPreview.parentBaseId,
                      distance: 0
                    }
                  }}
                  supports={supports}
                />
              ) : (
                <SupportPreview
                  tip={supportPreview.tip}
                  base={supportPreview.base}
                  settings={getCurrentSupportSettings()}
                  tipNormal={supportPreview.tipNormal}
                  validationLevel={supportPreview.validationLevel}
                  joints={supportPreview.joints}
                />
              );
            })()
          )}
          {/* Render joint creation preview */}
          {jointCreationMode && jointPreview && (() => {
            const support = supports?.find(s => s.id === jointPreview.supportId);
            if (!support) return null;
            const shaftDiameter = support.settings.mid.diameterMm;
            const jointDiameter = shaftDiameter + 0.1;
            return (
              <JointPreviewSphere
                position={jointPreview.position}
                diameter={jointDiameter}
              />
            );
          })()}
          {/* Joint move gizmo */}
          {selectedJointInfo && jointLivePosRef.current && (
            <UnifiedGizmo
              position={[jointLivePosRef.current.x, jointLivePosRef.current.y, jointLivePosRef.current.z]}
              rotation={[0, 0, 0]}
              enableMove
              enableRotate={false}
              enableScale={false}
              enableLighting
              onDragStateChange={setIsGizmoDragging}
              onMove={(delta) => {
                // Live update joint position for immediate feedback
                jointLivePosRef.current!.add(delta);

                // Check if this is a branch joint that needs to be constrained
                const currentSupport = supports?.find(s => s.id === selectedJointInfo.supportId);
                const joint = currentSupport?.joints?.find(j => j.id === selectedJointId);
                let finalPosition = {
                  x: jointLivePosRef.current!.x,
                  y: jointLivePosRef.current!.y,
                  z: jointLivePosRef.current!.z,
                };

                if (joint?.type === 'branch' && joint.lockedToSupportId && supports) {
                  // Find parent support
                  const parentSupport = supports.find(s => s.id === joint.lockedToSupportId);
                  if (parentSupport) {
                    // Constrain to parent shaft
                    finalPosition = constrainBranchJointToShaft(finalPosition, joint, parentSupport);
                    // Update live position ref to constrained position
                    jointLivePosRef.current!.set(finalPosition.x, finalPosition.y, finalPosition.z);
                  }
                }

                // Use live (history-muted) updates during drag for smoothness
                updateJointPositionLive(selectedJointInfo.supportId, selectedJointId!, finalPosition);

                // Update any branch joints attached to this support (live)
                if (supports) {
                  const branchUpdates = updateBranchJointsForParent(selectedJointInfo.supportId, supports);
                  for (const update of branchUpdates) {
                    updateJointPositionLive(update.supportId, update.jointId, update.newPosition);
                  }
                }
              }}
              onMoveEnd={() => {
                // Suppress the next canvas click so selection is preserved
                suppressNextCanvasClickRef.current = true;
                // Commit a single undoable update at the end of drag
                if (jointLivePosRef.current) {
                  updateJointPosition(selectedJointInfo.supportId, selectedJointId!, {
                    x: jointLivePosRef.current.x,
                    y: jointLivePosRef.current.y,
                    z: jointLivePosRef.current.z,
                  });

                  // Update any branch joints attached to this support
                  if (supports) {
                    const branchUpdates = updateBranchJointsForParent(selectedJointInfo.supportId, supports);
                    for (const update of branchUpdates) {
                      updateJointPosition(update.supportId, update.jointId, update.newPosition);
                    }
                  }
                }
              }}
            />
          )}
            </React.Suspense>
            
          </SelectionProvider>
        </PickingProviderWrapper>
        {/* Selection outline - renders when model is selected */}
        <SelectionOutlineRenderer
          meshRef={actualMeshRef}
          enabled={mode === 'prepare'}
          color="#00ff00"
          thickness={0.3}
        />
          <OrbitControls
            makeDefault
            enableDamping={false}
            enabled={!isGizmoDragging}
            onChange={onCameraChange}
            onEnd={onCameraEnd}
            mouseButtons={
              mode === 'support'
                ? { MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
                : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
            }
          />
        <CameraFocusController
          selectedIslandId={overlaySelectedIslandId ?? null}
          islandMarkers={islandMarkers ?? []}
        />
        {/* Selection outline effect - rendered by SelectionOutlineRenderer inside SelectionProvider */}
      </Canvas>
      {/* GPU Picking Debug Overlay - shows what's under cursor */}
      {gpuPickingTest && <PickingDebugOverlay position="top-right" />}
    </div>
  );
}

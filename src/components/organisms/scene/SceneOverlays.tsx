import React from 'react';
import * as THREE from 'three';
import { HolePunchPreviewCylinder } from '@/features/hole-punching/HolePunchPreviewCylinder';
import { HolePunchGizmo } from '@/features/hole-punching/HolePunchGizmo';
import { HollowVoxelEditOverlay } from '@/components/scene/HollowVoxelEditOverlay';
import { HollowVoxelPreview } from '@/components/scene/HollowVoxelPreview';
import type { HolePunchPlacementState } from '@/features/hole-punching/holePunchGeometry';
import type { HolePunchPanelState } from '@/features/hole-punching/HolePunchPanel';
import type { HollowPreviewState } from '@/features/hollowing/hollowingPreviewTypes';
import type { useHolePunchManager } from '@/features/hole-punching/useHolePunchManager';
import type { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import type { useTransformManager } from '@/features/transform/useTransformManager';

type SceneManager = ReturnType<typeof useSceneCollectionManager>;
type TransformManager = ReturnType<typeof useTransformManager>;
type HolePunchManager = ReturnType<typeof useHolePunchManager>;

/**
 * Transforms Float32Array voxel centers from model-local to world space
 * by applying `(center - geometryCenter) * scale * quaternion + position`.
 * Used to render voxel cubes outside the model's rotated group.
 */
function transformVoxelCentersToWorld(
  voxelCenters: Float32Array,
  geometryCenter: THREE.Vector3,
  scale: THREE.Vector3,
  quaternion: THREE.Quaternion,
  position: THREE.Vector3,
): Float32Array {
  const count = Math.floor(voxelCenters.length / 3);
  const out = new Float32Array(voxelCenters.length);
  const tmp = new THREE.Vector3();
  for (let i = 0; i < count; i += 1) {
    const base = i * 3;
    tmp.set(voxelCenters[base], voxelCenters[base + 1], voxelCenters[base + 2]);
    tmp.sub(geometryCenter);
    tmp.multiply(scale);
    tmp.applyQuaternion(quaternion);
    tmp.add(position);
    out[base] = tmp.x;
    out[base + 1] = tmp.y;
    out[base + 2] = tmp.z;
  }
  return out;
}

/**
 * Renders HollowVoxelPreview in world space by pre-transforming the voxel
 * centers using the model's position/rotation/scale, then passing meshOffset
 * as zero since positions are already in world coordinates.
 */
function WorldSpaceVoxelPreview({
  voxelCenters,
  voxelSizeMm,
  modelTransform: { position, quaternion, scale },
  geometryCenter,
}: {
  voxelCenters: Float32Array;
  voxelSizeMm: number;
  modelTransform: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 };
  geometryCenter: THREE.Vector3;
}) {
  const worldCenters = React.useMemo(
    () => transformVoxelCentersToWorld(voxelCenters, geometryCenter, scale, quaternion, position),
    [voxelCenters, geometryCenter, scale, quaternion, position],
  );
  return (
    <HollowVoxelPreview
      voxelCenters={worldCenters}
      voxelSizeMm={voxelSizeMm}
      meshOffset={new THREE.Vector3(0, 0, 0)}
    />
  );
}

/**
 * Renders HollowVoxelEditOverlay in world space (same transform logic).
 */
function WorldSpaceVoxelEditOverlay({
  voxelCenters,
  blockedVoxelCenters,
  voxelRadiusMm,
  blockedVoxelIndexSet,
  modelTransform: { position, quaternion, scale },
  geometryCenter,
  onToggleVoxel,
}: {
  voxelCenters: Float32Array;
  blockedVoxelCenters?: Float32Array;
  voxelRadiusMm: number;
  blockedVoxelIndexSet: Set<number>;
  modelTransform: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 };
  geometryCenter: THREE.Vector3;
  onToggleVoxel?: (voxelIndex: number) => void;
}) {
  const worldCenters = React.useMemo(
    () => transformVoxelCentersToWorld(voxelCenters, geometryCenter, scale, quaternion, position),
    [voxelCenters, geometryCenter, scale, quaternion, position],
  );
  const worldBlockedCenters = React.useMemo(
    () => blockedVoxelCenters
      ? transformVoxelCentersToWorld(blockedVoxelCenters, geometryCenter, scale, quaternion, position)
      : undefined,
    [blockedVoxelCenters, geometryCenter, scale, quaternion, position],
  );
  return (
    <HollowVoxelEditOverlay
      voxelCenters={worldCenters}
      blockedVoxelCenters={worldBlockedCenters}
      voxelRadiusMm={voxelRadiusMm}
      blockedVoxelIndexSet={blockedVoxelIndexSet}
      meshOffset={new THREE.Vector3(0, 0, 0)}
      onToggleVoxel={onToggleVoxel}
    />
  );
}

export type SceneOverlaysProps = {
  /** Raycast helper supplied by SceneCanvas via the renderSceneOverlays render-prop. */
  raycastActiveModelFromRay: (ray: THREE.Ray) => THREE.Intersection | null;

  scene: SceneManager;
  transformMgr: TransformManager;

  // LYS ghost overlay (plugin-provided, lazy-loaded from the plugin registry)
  ghostData: any;
  LysGhostOverlay: React.ComponentType<{ data: unknown; visible: boolean }> | null;

  // Hollowing state
  hollowPreview: HollowPreviewState | null;
  hollowingEditMode: boolean;
  hollowingDraftEnabled: boolean;
  isHollowingApplied: boolean;
  isHollowingDirty: boolean;
  isShellFaceSelectionPending: boolean;
  hollowingState: { shellThicknessMm: number };
  blockedPreviewVoxelInstanceIdSet: Set<number>;
  toggleBlockedHollowVoxelIndex: (voxelIndex: number) => void;

  // Hole-punch state
  interiorView: boolean;
  holePunchPlacements: HolePunchPlacementState[];
  appliedHolePunchPlacementIds: Set<string>;
  selectedHolePunchPlacementIds: string[];
  selectedHolePunchPlacementIdSet: Set<string>;
  hoveredHolePunchPlacementId: string | null;
  holePunchHoverPlacement: HolePunchPlacementState | null;
  holePunchState: HolePunchPanelState;

  setHoveredHolePunchPlacementId: React.Dispatch<React.SetStateAction<string | null>>;
  setHolePunchHoverPlacement: React.Dispatch<React.SetStateAction<HolePunchPlacementState | null>>;
  handleHolePunchPlacementDragStart: HolePunchManager['handleHolePunchPlacementDragStart'];
  handleHolePunchPlacementDragMove: HolePunchManager['handleHolePunchPlacementDragMove'];
  handleHolePunchPlacementDragEnd: HolePunchManager['handleHolePunchPlacementDragEnd'];
  handleHolePunchGizmoMoveStart: HolePunchManager['handleHolePunchGizmoMoveStart'];
  handleHolePunchGizmoMove: HolePunchManager['handleHolePunchGizmoMove'];
  handleHolePunchGizmoMoveEnd: HolePunchManager['handleHolePunchGizmoMoveEnd'];
  handleHolePunchGizmoRotateStart: HolePunchManager['handleHolePunchGizmoRotateStart'];
  handleHolePunchGizmoRotate: HolePunchManager['handleHolePunchGizmoRotate'];
  handleHolePunchGizmoRotateEnd: HolePunchManager['handleHolePunchGizmoRotateEnd'];
};

/**
 * In-scene overlays rendered inside SceneCanvas via its `renderSceneOverlays`
 * render-prop: hole-punch placement markers + gizmo + hover preview cylinder,
 * the hollow voxel edit overlay + cavity/infill previews, and world-space
 * voxel previews. Extracted verbatim from the page.tsx editor shell.
 */
export function SceneOverlays({
  raycastActiveModelFromRay,
  scene,
  transformMgr,
  ghostData,
  LysGhostOverlay,
  hollowPreview,
  hollowingEditMode,
  hollowingDraftEnabled,
  isHollowingApplied,
  isHollowingDirty,
  isShellFaceSelectionPending,
  hollowingState,
  blockedPreviewVoxelInstanceIdSet,
  toggleBlockedHollowVoxelIndex,
  interiorView,
  holePunchPlacements,
  appliedHolePunchPlacementIds,
  selectedHolePunchPlacementIds,
  selectedHolePunchPlacementIdSet,
  hoveredHolePunchPlacementId,
  holePunchHoverPlacement,
  holePunchState,
  setHoveredHolePunchPlacementId,
  setHolePunchHoverPlacement,
  handleHolePunchPlacementDragStart,
  handleHolePunchPlacementDragMove,
  handleHolePunchPlacementDragEnd,
  handleHolePunchGizmoMoveStart,
  handleHolePunchGizmoMove,
  handleHolePunchGizmoMoveEnd,
  handleHolePunchGizmoRotateStart,
  handleHolePunchGizmoRotate,
  handleHolePunchGizmoRotateEnd,
}: SceneOverlaysProps) {
  const previewModel = hollowPreview
    ? scene.models.find((model) => model.id === hollowPreview.modelId) ?? null
    : null;
  const activeModelId = scene.activeModel?.id ?? null;
  const isInHollowingTool = scene.mode === 'prepare' && transformMgr.transformMode === 'hollowing';
  const showDraftHolePunchMarkers = (
    interiorView
    || (
      isInHollowingTool
      && !isShellFaceSelectionPending
      && !hollowingEditMode
    )
  );
  const holePunchCavityBoundaryDepthMm = (hollowingDraftEnabled || isHollowingApplied)
    ? Math.max(0, hollowingState.shellThicknessMm)
    : null;
  const placedPunches = activeModelId
    ? holePunchPlacements.filter((placement) => placement.modelId === activeModelId)
    : [];
  const hoverPunchPreview = (
    !hoveredHolePunchPlacementId
    && holePunchHoverPlacement
    && holePunchHoverPlacement.modelId === activeModelId
  )
    ? holePunchHoverPlacement
    : null;

  return (
    <>
      {ghostData && LysGhostOverlay ? <LysGhostOverlay data={ghostData} visible /> : null}

      {placedPunches.map((placement) => {
        const isApplied = appliedHolePunchPlacementIds.has(placement.id);
        // Draft markers (blue, unapplied) always show so the user
        // can see what needs applying. Applied markers (orange/grey)
        // only show in prepare/hollowing mode.
        if (isApplied && !showDraftHolePunchMarkers) return null;
        return (
          <HolePunchPreviewCylinder
            key={`hole-punch-placement-${placement.id}`}
            position={placement.worldPoint}
            normal={placement.worldNormal}
            frame={placement.worldFrame}
            radiusMm={placement.radiusMm}
            radiusYMm={placement.radiusYMm}
            lengthMm={placement.depthMm}
            cavityBoundaryDepthMm={holePunchCavityBoundaryDepthMm}
            applied={isApplied}
            variant={isInHollowingTool && selectedHolePunchPlacementIdSet.has(placement.id)
              ? 'selected'
              : isInHollowingTool && placement.id === hoveredHolePunchPlacementId
                ? 'hover'
                : 'placed'}
            /* Only interactive when inside the hollowing tool */
            {...(isInHollowingTool ? {
              onHoverStart: () => {
                setHoveredHolePunchPlacementId(placement.id);
                setHolePunchHoverPlacement(null);
              },
              onHoverEnd: () => {
                setHoveredHolePunchPlacementId((previous) => (previous === placement.id ? null : previous));
              },
              onPointerDown: (event: any) => handleHolePunchPlacementDragStart(placement.id, event),
              onPointerMove: (event: any) => handleHolePunchPlacementDragMove(
                placement.id,
                event,
                raycastActiveModelFromRay,
              ),
              onPointerUp: (event: any) => handleHolePunchPlacementDragEnd(placement.id, event),
              onPointerCancel: (event: any) => handleHolePunchPlacementDragEnd(placement.id, event),
              onClick: () => {},
            } : {})}
          />
        );
      })}

      {showDraftHolePunchMarkers && hoverPunchPreview && (
        <HolePunchPreviewCylinder
          key="hole-punch-hover-preview"
          position={hoverPunchPreview.worldPoint}
          normal={hoverPunchPreview.worldNormal}
          radiusMm={holePunchState.radiusMm}
          radiusYMm={holePunchState.radiusYMm}
          lengthMm={holePunchState.depthMm}
          cavityBoundaryDepthMm={holePunchCavityBoundaryDepthMm}
          variant="hover"
        />
      )}

      {isInHollowingTool && selectedHolePunchPlacementIds.length === 1 && (() => {
        const selectedPlacement = placedPunches.find(
          (p) => selectedHolePunchPlacementIdSet.has(p.id),
        );
        if (!selectedPlacement) return null;
        return (
          <HolePunchGizmo
            key={`hole-punch-gizmo-${selectedPlacement.id}`}
            placement={selectedPlacement}
            onMoveStart={() => handleHolePunchGizmoMoveStart(selectedPlacement.id)}
            onMove={(delta) => handleHolePunchGizmoMove(selectedPlacement.id, delta)}
            onMoveEnd={() => handleHolePunchGizmoMoveEnd(selectedPlacement.id)}
            onRotateStart={() => handleHolePunchGizmoRotateStart(selectedPlacement.id)}
            onRotate={(newNormal, worldFrame) => handleHolePunchGizmoRotate(
              selectedPlacement.id,
              newNormal,
              worldFrame,
            )}
            onRotateEnd={() => handleHolePunchGizmoRotateEnd(selectedPlacement.id)}
          />
        );
      })()}

      {hollowPreview && previewModel && hollowingEditMode && !(isHollowingApplied && !isHollowingDirty) && (
        <WorldSpaceVoxelEditOverlay
          voxelCenters={hollowPreview.removedVoxelCenters}
          blockedVoxelCenters={hollowPreview.blockedVoxelCenters}
          voxelRadiusMm={Math.max(hollowPreview.report.voxelSizeMm, 0.2)}
          blockedVoxelIndexSet={blockedPreviewVoxelInstanceIdSet}
          modelTransform={{
            position: previewModel.transform.position,
            quaternion: new THREE.Quaternion().setFromEuler(previewModel.transform.rotation),
            scale: previewModel.transform.scale,
          }}
          geometryCenter={previewModel.geometry.center}
          onToggleVoxel={toggleBlockedHollowVoxelIndex}
        />
      )}

      {hollowPreview && previewModel && !hollowingEditMode && !(isHollowingApplied && !isHollowingDirty) && (
        <>
          {hollowPreview.previewVoxelSpheres && (
            <WorldSpaceVoxelPreview
              voxelCenters={hollowPreview.removedVoxelCenters}
              voxelSizeMm={hollowPreview.report.voxelSizeMm}
              modelTransform={{
                position: previewModel.transform.position,
                quaternion: new THREE.Quaternion().setFromEuler(previewModel.transform.rotation),
                scale: previewModel.transform.scale,
              }}
              geometryCenter={previewModel.geometry.center}
            />
          )}
          <group
            position={previewModel.transform.position}
            quaternion={new THREE.Quaternion().setFromEuler(previewModel.transform.rotation)}
            scale={previewModel.transform.scale}
          >
            {!hollowPreview.previewVoxelSpheres && (
              <mesh
                geometry={hollowPreview.geometry}
                position={new THREE.Vector3(
                  -previewModel.geometry.center.x,
                  -previewModel.geometry.center.y,
                  -previewModel.geometry.center.z,
                )}
                raycast={() => null}
                renderOrder={6}
              >
                <meshStandardMaterial
                  color={'#66ecff'}
                  emissive={'#3be6f2'}
                  emissiveIntensity={0.18}
                  transparent
                  opacity={0.62}
                  depthTest
                  depthWrite={false}
                  side={THREE.DoubleSide}
                  roughness={0.65}
                  metalness={0.0}
                />
              </mesh>
            )}
            {hollowPreview.infillGeometry && (
              <mesh
                geometry={hollowPreview.infillGeometry}
                position={new THREE.Vector3(
                  -previewModel.geometry.center.x,
                -previewModel.geometry.center.y,
                -previewModel.geometry.center.z,
              )}
              raycast={() => null}
              renderOrder={7}
            >
              <meshStandardMaterial
                color={'#43215f'}
                emissive={'#5a2f82'}
                emissiveIntensity={0.24}
                transparent
                opacity={0.9}
                depthTest
                depthWrite={false}
                side={THREE.DoubleSide}
                roughness={0.55}
                metalness={0.0}
              />
            </mesh>
          )}
        </group>
      </>
    )}
    </>
  );
}

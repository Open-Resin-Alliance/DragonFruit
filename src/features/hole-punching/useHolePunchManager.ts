import React from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import type { useTransformManager } from '@/features/transform/useTransformManager';
import type { HolePunchPanelState } from '@/features/hole-punching/HolePunchPanel';
import type { HollowingPanelState } from '@/features/hollowing';
import type { ModelMeshModifiers } from '@/features/mesh-modifiers/types';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import { snapshotGeometryPositions, geometryFromSnapshot } from '@/utils/geometrySnapshot';
import {
  getDirectionScaleFactor,
  getRadialScaleFactor,
  worldMmToLocalMm,
} from '@/utils/geometryScaling';
import {
  createHolePunchWorldFrame,
  cloneHolePunchWorldFrame,
  inferOpenFaceFromHit,
  type HolePunchWorldFrame,
  type HolePunchPlacementState,
} from '@/features/hole-punching/holePunchGeometry';
import {
  toPersistedHolePunchPlacements,
  serializeHolePunchPlacements,
  serializeSingleHolePunchPlacement,
} from '@/features/hole-punching/holePunchPersistence';
import { buildGeometryVersionKey, disposeHollowPreviewCacheEntry } from '@/features/hollowing/hollowingPreviewCache';
import type { HollowPreviewCacheEntry, HollowingSourceEntry } from '@/features/hollowing/hollowingPreviewTypes';
import { punchFromCapturedSource, stagePunchSource, type PunchOptions } from '@/utils/meshPunching';
import { registerDeleteHandler } from '@/features/delete/deleteRegistry';

const HOLE_PUNCH_OUTSIDE_PROTRUSION_MM = 3;
const HOLE_PUNCH_DEPTH_OFFSET_FROM_SHELL_MM = 1;
const HOLE_PUNCH_AUTO_DEPTH_RAY_START_OFFSET_MM = 0.3;
const HOLE_PUNCH_AUTO_DEPTH_MIN_INSIDE_MM = 1;

function getDefaultHolePunchDepthMm(shellThicknessMm: number): number {
  return Number(
    Math.min(120, Math.max(1, shellThicknessMm + HOLE_PUNCH_DEPTH_OFFSET_FROM_SHELL_MM)).toFixed(1),
  );
}

type SceneManager = ReturnType<typeof useSceneCollectionManager>;
type TransformManager = ReturnType<typeof useTransformManager>;

export type UseHolePunchManagerOptions = {
  scene: SceneManager;
  transformMgr: TransformManager;
  sleep: (ms: number) => Promise<void>;
  // Hollowing-derived inputs (shared state lives in Home).
  hollowingState: HollowingPanelState;
  hollowingDraftEnabled: boolean;
  hollowPreview: import('@/features/hollowing/hollowingPreviewTypes').HollowPreviewState | null;
  isShellOpenFaceSelected: boolean;
  defaultHolePunchState: HolePunchPanelState;
  recommendedHolePunchDepthMm: number;
  setHollowingState: React.Dispatch<React.SetStateAction<HollowingPanelState>>;
  setIsShellOpenFaceSelected: React.Dispatch<React.SetStateAction<boolean>>;
  setHollowingDraftEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  // Shared persistence + modifier machinery (stays in Home).
  persistActiveModelModifiers: (next: ModelMeshModifiers | undefined) => void;
  setPendingModifierResetAction: React.Dispatch<React.SetStateAction<'hollowing' | 'hole_punch' | 'clear_hollowing' | null>>;
  hollowingSourceByModelIdRef: React.MutableRefObject<Map<string, HollowingSourceEntry>>;
  hollowPreviewResultCacheRef: React.MutableRefObject<Map<string, HollowPreviewCacheEntry>>;
  // Shared apply/overlay + selection/hover state kept in Home (TDZ before hook).
  isApplyingHolePunch: boolean;
  setIsApplyingHolePunch: React.Dispatch<React.SetStateAction<boolean>>;
  isApplyingHollowing: boolean;
  pendingHolePunchAutoApplyModelId: string | null;
  setPendingHolePunchAutoApplyModelId: React.Dispatch<React.SetStateAction<string | null>>;
  selectedHolePunchPlacementIds: string[];
  setSelectedHolePunchPlacementIds: React.Dispatch<React.SetStateAction<string[]>>;
  setHoveredHolePunchPlacementId: React.Dispatch<React.SetStateAction<string | null>>;
  setHolePunchHoverPlacement: React.Dispatch<React.SetStateAction<HolePunchPlacementState | null>>;
  // Misc shared sinks.
  showOperationError: (message: string) => void;
  setShowDamagedModelDialog: React.Dispatch<React.SetStateAction<boolean>>;
  // Modifier-apply overlay finalizing controls (useModifierApplyOverlay in Home).
  beginFinalizing: (kind: 'hollowing' | 'holePunch') => void;
  clearFinalizing: () => void;
  nextPaint: () => Promise<void>;
};

export function useHolePunchManager({
  scene,
  transformMgr,
  sleep,
  hollowingState,
  hollowingDraftEnabled,
  hollowPreview,
  isShellOpenFaceSelected,
  defaultHolePunchState,
  recommendedHolePunchDepthMm,
  setHollowingState,
  setIsShellOpenFaceSelected,
  setHollowingDraftEnabled,
  persistActiveModelModifiers,
  setPendingModifierResetAction,
  hollowingSourceByModelIdRef,
  hollowPreviewResultCacheRef,
  isApplyingHolePunch,
  setIsApplyingHolePunch,
  isApplyingHollowing,
  pendingHolePunchAutoApplyModelId,
  setPendingHolePunchAutoApplyModelId,
  selectedHolePunchPlacementIds,
  setSelectedHolePunchPlacementIds,
  setHoveredHolePunchPlacementId,
  setHolePunchHoverPlacement,
  showOperationError,
  setShowDamagedModelDialog,
  beginFinalizing,
  clearFinalizing,
  nextPaint,
}: UseHolePunchManagerOptions) {
  const [holePunchState, setHolePunchState] = React.useState<HolePunchPanelState>({
    radiusMm: 2.0,
    radiusYMm: undefined,
    depthMm: getDefaultHolePunchDepthMm(2.0),
    depthMode: 'manual',
  });

  const [holePunchPlacements, setHolePunchPlacements] = React.useState<HolePunchPlacementState[]>([]);

  const holePunchPlacementsRef = React.useRef<HolePunchPlacementState[]>([]);

  const holePunchDragStateRef = React.useRef<{
    pointerId: number;
    placementId: string;
    moved: boolean;
  } | null>(null);

  const suppressHolePunchClickPlacementIdRef = React.useRef<string | null>(null);

  const suppressHolePunchGizmoReleaseClickUntilRef = React.useRef(0);

  const holePunchAutoDepthRaycasterRef = React.useRef(new THREE.Raycaster());
  const holePunchAutoDepthMeshRef = React.useRef(
    new THREE.Mesh(
      undefined,
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    ),
  );

  React.useEffect(() => {
    holePunchPlacementsRef.current = holePunchPlacements;
  }, [holePunchPlacements]);

  const selectedHolePunchPlacementIdSet = React.useMemo(
    () => new Set(selectedHolePunchPlacementIds),
    [selectedHolePunchPlacementIds],
  );

  const selectedHolePunchPlacements = React.useMemo(
    () => holePunchPlacements.filter((placement) => selectedHolePunchPlacementIdSet.has(placement.id)),
    [holePunchPlacements, selectedHolePunchPlacementIdSet],
  );

  const canUseAutoHolePunchDepth = React.useMemo(() => {
    const modifier = scene.activeModel?.meshModifiers?.hollowing;
    const hollowingAppliedForActiveModel = Boolean(modifier?.enabled && modifier?.bakedIntoGeometry);
    return Boolean(scene.activeModel && (hollowingDraftEnabled || hollowingAppliedForActiveModel));
  }, [hollowingDraftEnabled, scene.activeModel]);

  const syncHolePunchPanelFromSelection = React.useCallback((
    nextSelectedIds: string[],
    placements: HolePunchPlacementState[],
    preferredId?: string | null,
    autoDepthEnabled = canUseAutoHolePunchDepth,
  ) => {
    const preferredPlacement = preferredId
      ? placements.find((placement) => placement.id === preferredId)
      : null;
    const fallbackPlacement = [...placements].reverse().find((placement) => nextSelectedIds.includes(placement.id)) ?? null;
    const nextPlacement = preferredPlacement ?? fallbackPlacement;
    if (nextPlacement) {
      setHolePunchState({
        radiusMm: nextPlacement.radiusMm,
        radiusYMm: nextPlacement.radiusYMm,
        depthMm: nextPlacement.depthMm,
        depthMode: autoDepthEnabled ? nextPlacement.depthMode : 'manual',
      });
    }
  }, [canUseAutoHolePunchDepth]);

  const activeHolePunchPlacements = React.useMemo(() => {
    const activeModelId = scene.activeModel?.id;
    if (!activeModelId) return [] as HolePunchPlacementState[];
    return holePunchPlacements.filter((placement) => placement.modelId === activeModelId);
  }, [holePunchPlacements, scene.activeModel?.id]);

  const previousRecommendedHolePunchDepthRef = React.useRef<number>(recommendedHolePunchDepthMm);

  React.useEffect(() => {
    const previousRecommendedDepth = previousRecommendedHolePunchDepthRef.current;
    const nextRecommendedDepth = recommendedHolePunchDepthMm;

    const shouldAutoUpdateDepth = selectedHolePunchPlacementIds.length === 0
      && activeHolePunchPlacements.length === 0
      && Math.abs(holePunchState.depthMm - previousRecommendedDepth) <= 1e-6;

    if (shouldAutoUpdateDepth && Math.abs(holePunchState.depthMm - nextRecommendedDepth) > 1e-6) {
      setHolePunchState((previous) => ({
        ...previous,
        depthMm: nextRecommendedDepth,
      }));
    }

    previousRecommendedHolePunchDepthRef.current = nextRecommendedDepth;
  }, [
    activeHolePunchPlacements.length,
    holePunchState.depthMm,
    recommendedHolePunchDepthMm,
    selectedHolePunchPlacementIds.length,
  ]);

  const appliedHolePunchPlacementsSignature = React.useMemo(() => {
    const activeModel = scene.activeModel;
    if (!activeModel) return '[]';
    const appliedPlacements = activeModel.meshModifiers?.holePunchAppliedPlacements
      ?? (activeModel.meshModifiers?.holePunchesBakedIntoGeometry
        ? (activeModel.meshModifiers?.holePunches ?? [])
        : []);
    return serializeHolePunchPlacements(appliedPlacements);
  }, [scene.activeModel]);

  const draftHolePunchPlacementsSignature = React.useMemo(() => {
    const activeModel = scene.activeModel;
    if (!activeModel) return '[]';
    const persistedDraft = toPersistedHolePunchPlacements(activeModel, activeHolePunchPlacements);
    return serializeHolePunchPlacements(persistedDraft);
  }, [activeHolePunchPlacements, scene.activeModel]);

  const isHolePunchApplied = React.useMemo(() => {
    const activeModel = scene.activeModel;
    if (!activeModel) return false;
    return Boolean(
      (activeModel.meshModifiers?.holePunches?.length ?? 0) > 0
      && activeModel.meshModifiers?.holePunchesBakedIntoGeometry,
    );
  }, [scene.activeModel]);

  const holePunchNeedsBake = React.useMemo(() => {
    const activeModel = scene.activeModel;
    if (!activeModel) return false;
    const placements = activeModel.meshModifiers?.holePunches ?? [];
    const hasSourceSnapshot = Boolean(
      activeModel.meshModifiers?.holePunchSourcePositionsBase64
      && Number.isFinite(activeModel.meshModifiers?.holePunchSourcePositionCount)
      && (activeModel.meshModifiers?.holePunchSourcePositionCount ?? 0) > 0,
    );

    if (activeModel.meshModifiers?.holePunchesBakedIntoGeometry) return false;
    return placements.length > 0 || hasSourceSnapshot;
  }, [scene.activeModel]);

  const isHolePunchDirty = draftHolePunchPlacementsSignature !== appliedHolePunchPlacementsSignature;

  const appliedHolePunchPlacementIds = React.useMemo(() => {
    const activeModel = scene.activeModel;
    if (!activeModel) {
      return new Set<string>();
    }

    const appliedPlacements = activeModel.meshModifiers?.holePunchAppliedPlacements
      ?? (activeModel.meshModifiers?.holePunchesBakedIntoGeometry
        ? (activeModel.meshModifiers?.holePunches ?? [])
        : []);

    if (appliedPlacements.length === 0) {
      return new Set<string>();
    }

    const currentPersistedPlacements = toPersistedHolePunchPlacements(activeModel, activeHolePunchPlacements)
      .filter((placement) => placement.radiusMm > 0 && placement.depthMm > 0);

    if (currentPersistedPlacements.length === 0) {
      return new Set<string>();
    }

    const currentById = new Map<string, string>();
    for (const placement of currentPersistedPlacements) {
      currentById.set(placement.id, serializeSingleHolePunchPlacement(placement));
    }

    const appliedIds = new Set<string>();
    for (const placement of appliedPlacements) {
      const currentSignature = currentById.get(placement.id);
      if (!currentSignature) continue;
      if (currentSignature === serializeSingleHolePunchPlacement(placement)) {
        appliedIds.add(placement.id);
      }
    }

    return appliedIds;
  }, [activeHolePunchPlacements, scene.activeModel]);

  const canResetHolePunch = React.useMemo(() => {
    const activeModel = scene.activeModel;
    if (!activeModel) return false;
    return activeHolePunchPlacements.length > 0
      || (activeModel.meshModifiers?.holePunchAppliedPlacements?.length ?? 0) > 0
      || Boolean(
        activeModel.meshModifiers?.holePunchesBakedIntoGeometry
        && (activeModel.meshModifiers?.holePunches?.length ?? 0) > 0,
      );
  }, [activeHolePunchPlacements.length, scene.activeModel]);

  const persistHolePunchPlacementsForModel = React.useCallback((
    activeModel: NonNullable<typeof scene.activeModel>,
    placements: HolePunchPlacementState[],
  ) => {
    const nextActivePlacements = placements.filter((placement) => placement.modelId === activeModel.id);
    const nextPersisted = toPersistedHolePunchPlacements(activeModel, nextActivePlacements)
      .filter((placement) => placement.radiusMm > 0 && placement.depthMm > 0);

    persistActiveModelModifiers({
      ...(activeModel.meshModifiers ?? {}),
      holePunches: nextPersisted,
      holePunchAppliedPlacements: activeModel.meshModifiers?.holePunchAppliedPlacements
        ?? (activeModel.meshModifiers?.holePunchesBakedIntoGeometry
          ? (activeModel.meshModifiers?.holePunches ?? [])
          : []),
      holePunchesBakedIntoGeometry: false,
      holePunchSourcePositionsBase64: activeModel.meshModifiers?.holePunchSourcePositionsBase64,
      holePunchSourcePositionCount: activeModel.meshModifiers?.holePunchSourcePositionCount,
    });
  }, [persistActiveModelModifiers]);

  const computeAutoHolePunchDepthMmForGeometry = React.useCallback((
    model: (typeof scene.models)[number],
    targetGeometry: THREE.BufferGeometry,
    worldPoint: THREE.Vector3,
    worldNormal: THREE.Vector3,
  ) => {

    const axis = worldNormal.clone();
    if (axis.lengthSq() <= 1e-10) {
      return getDefaultHolePunchDepthMm(hollowingState.shellThicknessMm);
    }
    axis.normalize();

    const raycaster = holePunchAutoDepthRaycasterRef.current;
    const rayMesh = holePunchAutoDepthMeshRef.current;
    rayMesh.geometry = targetGeometry;
    rayMesh.position.set(
      -model.geometry.center.x,
      -model.geometry.center.y,
      -model.geometry.center.z,
    );
    rayMesh.quaternion.copy(quaternionFromGlobalEuler(model.transform.rotation));
    rayMesh.scale.copy(model.transform.scale);
    rayMesh.updateMatrixWorld(true);

    const origin = worldPoint.clone().addScaledVector(axis, -HOLE_PUNCH_AUTO_DEPTH_RAY_START_OFFSET_MM);
    raycaster.ray.origin.copy(origin);
    raycaster.ray.direction.copy(axis);
    raycaster.near = 0;
    raycaster.far = 240;

    const hits = raycaster.intersectObject(rayMesh, false);
    const distinctDistances: number[] = [];
    for (const hit of hits) {
      if (distinctDistances.length > 0 && Math.abs(hit.distance - distinctDistances[distinctDistances.length - 1]) <= 0.05) {
        continue;
      }
      distinctDistances.push(hit.distance);
      if (distinctDistances.length >= 2) break;
    }

    if (distinctDistances.length < 2) {
      return getDefaultHolePunchDepthMm(hollowingState.shellThicknessMm);
    }

    const shellPathLengthMm = Math.max(
      HOLE_PUNCH_AUTO_DEPTH_MIN_INSIDE_MM,
      distinctDistances[1] - distinctDistances[0],
    );
    return Number(
      Math.min(120, shellPathLengthMm + HOLE_PUNCH_DEPTH_OFFSET_FROM_SHELL_MM).toFixed(1),
    );
  }, [hollowingState.shellThicknessMm]);

  const computeAutoHolePunchDepthMm = React.useCallback((
    modelId: string,
    worldPoint: THREE.Vector3,
    worldNormal: THREE.Vector3,
  ) => {
    const activeModel = scene.models.find((model) => model.id === modelId) ?? null;
    if (!activeModel) {
      return getDefaultHolePunchDepthMm(hollowingState.shellThicknessMm);
    }

    const previewGeometry = (
      hollowPreview
      && hollowPreview.modelId === modelId
      && hollowingDraftEnabled
    ) ? hollowPreview.geometry : null;

    const shouldUseActiveGeometry = Boolean(
      scene.getModelMeshModifiers(modelId)?.hollowing?.enabled
      && scene.getModelMeshModifiers(modelId)?.hollowing?.bakedIntoGeometry,
    );

    const targetGeometry = previewGeometry ?? (shouldUseActiveGeometry ? activeModel.geometry.geometry : null);
    if (!targetGeometry) {
      return getDefaultHolePunchDepthMm(hollowingState.shellThicknessMm);
    }

    return computeAutoHolePunchDepthMmForGeometry(activeModel, targetGeometry, worldPoint, worldNormal);
  }, [computeAutoHolePunchDepthMmForGeometry, hollowPreview, hollowingDraftEnabled, hollowingState.shellThicknessMm, scene.models]);

  const buildHolePunchPlacementForHit = React.useCallback((
    base: Pick<HolePunchPlacementState, 'id' | 'modelId' | 'radiusMm' | 'radiusYMm' | 'depthMm' | 'depthMode'>,
    hit: THREE.Intersection,
  ): HolePunchPlacementState => {
    const localPoint = hit.object.worldToLocal(hit.point.clone());
    const localNormal = hit.face?.normal
      ? hit.face.normal.clone().normalize().negate()
      : new THREE.Vector3(0, 0, -1);
    const worldNormal = hit.face?.normal
      ? hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize().negate()
      : new THREE.Vector3(0, 0, -1);
    const resolvedDepthMm = (base.depthMode === 'auto' && canUseAutoHolePunchDepth)
      ? computeAutoHolePunchDepthMm(base.modelId, hit.point, worldNormal)
      : base.depthMm;

    return {
      ...base,
      worldPoint: hit.point.clone(),
      worldNormal,
      worldFrame: createHolePunchWorldFrame(worldNormal),
      localPoint,
      localNormal,
      depthMm: resolvedDepthMm,
      depthMode: base.depthMode === 'auto' && !canUseAutoHolePunchDepth ? 'manual' : base.depthMode,
    };
  }, [canUseAutoHolePunchDepth, computeAutoHolePunchDepthMm]);

  const buildHolePunchPlacementFromHit = React.useCallback((hit: THREE.Intersection, modelId: string): HolePunchPlacementState => {
    return buildHolePunchPlacementForHit({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      modelId,
      radiusMm: holePunchState.radiusMm,
      radiusYMm: holePunchState.radiusYMm,
      depthMm: holePunchState.depthMm,
      depthMode: canUseAutoHolePunchDepth ? holePunchState.depthMode : 'manual',
    }, hit);
  }, [buildHolePunchPlacementForHit, canUseAutoHolePunchDepth, holePunchState.depthMm, holePunchState.depthMode, holePunchState.radiusMm, holePunchState.radiusYMm]);

  const handleHolePunchClick = React.useCallback((hit: THREE.Intersection) => {
    const activeModel = scene.activeModel;
    if (!activeModel) return;

    const hitModelId = (hit.object.userData?.modelId as string | undefined) ?? activeModel.id;
    if (hitModelId !== activeModel.id) return;

    if (selectedHolePunchPlacementIds.length > 0 && Date.now() < suppressHolePunchGizmoReleaseClickUntilRef.current) {
      setHolePunchHoverPlacement(null);
      return;
    }

    if (hollowingState.mode === 'shell_open_face' && !isShellOpenFaceSelected) {
      const pickedOpenFace = inferOpenFaceFromHit(hit, hollowingState.openFace);
        const nextHollowingState: HollowingPanelState = {
          ...hollowingState,
          openFace: pickedOpenFace,
        };

      setHollowingState(nextHollowingState);
      setIsShellOpenFaceSelected(true);
      setHollowingDraftEnabled(true);
      setSelectedHolePunchPlacementIds([]);
      setHoveredHolePunchPlacementId(null);
      setHolePunchHoverPlacement(null);

      persistActiveModelModifiers({
        ...(activeModel.meshModifiers ?? {}),
        hollowing: {
          enabled: true,
          bakedIntoGeometry: false,
          sourcePositionsBase64: activeModel.meshModifiers?.hollowing?.sourcePositionsBase64,
          sourcePositionCount: activeModel.meshModifiers?.hollowing?.sourcePositionCount,
          mode: nextHollowingState.mode,
          voxelSizeMm: nextHollowingState.voxelSizeMm,
          shellThicknessMm: nextHollowingState.shellThicknessMm,
          infillMode: nextHollowingState.infillMode,
          infillCellMm: nextHollowingState.infillCellMm,
          infillBeamRadiusMm: nextHollowingState.infillBeamRadiusMm,
          openFace: nextHollowingState.openFace,
          openFaceSelected: true,
        },
      });
      return;
    }

    if (selectedHolePunchPlacementIds.length > 0) {
      setSelectedHolePunchPlacementIds([]);
      setHoveredHolePunchPlacementId(null);
      setHolePunchHoverPlacement(null);
      return;
    }

    const placement = buildHolePunchPlacementFromHit(hit, activeModel.id);
    setHolePunchPlacements((previous) => {
      const nextPlacements = [...previous, placement];
      persistHolePunchPlacementsForModel(activeModel, nextPlacements);
      return nextPlacements;
    });
    setSelectedHolePunchPlacementIds([]);
    setHoveredHolePunchPlacementId(null);
    setHolePunchHoverPlacement(null);
  }, [
    buildHolePunchPlacementFromHit,
    hollowingState,
    isShellOpenFaceSelected,
    persistHolePunchPlacementsForModel,
    scene.activeModel,
    selectedHolePunchPlacementIds.length,
  ]);

  const handleHolePunchHover = React.useCallback((hit: THREE.Intersection | null) => {
    const activeModel = scene.activeModel;
    if (
      holePunchDragStateRef.current
      || selectedHolePunchPlacementIds.length > 0
      || !activeModel
      || !hit
      || (hollowingState.mode === 'shell_open_face' && !isShellOpenFaceSelected)
    ) {
      setHolePunchHoverPlacement(null);
      return;
    }

    const hitModelId = (hit.object.userData?.modelId as string | undefined) ?? activeModel.id;
    if (hitModelId !== activeModel.id) {
      setHolePunchHoverPlacement(null);
      return;
    }

    const placement = buildHolePunchPlacementFromHit(hit, activeModel.id);
    setHolePunchHoverPlacement(placement);
  }, [buildHolePunchPlacementFromHit, hollowingState.mode, isShellOpenFaceSelected, scene.activeModel, selectedHolePunchPlacementIds.length]);

  const handleSelectHolePunchPlacement = React.useCallback((
    placementId: string,
    selectionMode: 'single' | 'toggle' | 'add' = 'single',
  ) => {
    if (suppressHolePunchClickPlacementIdRef.current === placementId) {
      suppressHolePunchClickPlacementIdRef.current = null;
      return;
    }
    const exists = holePunchPlacements.some((entry) => entry.id === placementId);
    if (!exists) return;

    setSelectedHolePunchPlacementIds((previous) => {
      let nextIds: string[];
      if (selectionMode === 'toggle') {
        nextIds = previous.includes(placementId)
          ? previous.filter((id) => id !== placementId)
          : [...previous, placementId];
      } else if (selectionMode === 'add') {
        nextIds = previous.includes(placementId) ? previous : [...previous, placementId];
      } else {
        nextIds = [placementId];
      }

      syncHolePunchPanelFromSelection(nextIds, holePunchPlacements, placementId);
      return nextIds;
    });
  }, [holePunchPlacements, syncHolePunchPanelFromSelection]);

  const handleHolePunchPlacementDragStart = React.useCallback((
    placementId: string,
    event: ThreeEvent<PointerEvent>,
  ) => {
    if (event.button !== 0) return;
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      handleSelectHolePunchPlacement(
        placementId,
        event.ctrlKey || event.metaKey ? 'toggle' : 'add',
      );
      return;
    }
    holePunchDragStateRef.current = {
      pointerId: event.pointerId,
      placementId,
      moved: false,
    };
    suppressHolePunchClickPlacementIdRef.current = null;
    setHoveredHolePunchPlacementId(placementId);
    setHolePunchHoverPlacement(null);
    handleSelectHolePunchPlacement(placementId, 'single');
    const pointerTarget = event.target as Element | null;
    pointerTarget?.setPointerCapture?.(event.pointerId);
  }, [handleSelectHolePunchPlacement]);

  const handleHolePunchPlacementDragMove = React.useCallback((
    placementId: string,
    event: ThreeEvent<PointerEvent>,
    raycastActiveModelFromRay: (ray: THREE.Ray) => THREE.Intersection | null,
  ) => {
    const drag = holePunchDragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.placementId !== placementId) return;

    const hit = raycastActiveModelFromRay(event.ray);
    if (!hit) return;

    drag.moved = true;
    setHolePunchPlacements((previous) => previous.map((placement) => (
      placement.id === placementId
        ? buildHolePunchPlacementForHit(placement, hit)
        : placement
    )));
    setSelectedHolePunchPlacementIds((previous) => (
      previous.includes(placementId) ? previous : [placementId]
    ));
    setHoveredHolePunchPlacementId(placementId);
    setHolePunchHoverPlacement(null);
  }, [buildHolePunchPlacementForHit]);

  const handleHolePunchPlacementDragEnd = React.useCallback((
    placementId: string,
    event: ThreeEvent<PointerEvent>,
  ) => {
    const drag = holePunchDragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.placementId !== placementId) return;

    holePunchDragStateRef.current = null;
    const pointerTarget = event.target as Element | null;
    pointerTarget?.releasePointerCapture?.(event.pointerId);

    if (!drag.moved) return;

    suppressHolePunchClickPlacementIdRef.current = placementId;
    const activeModel = scene.activeModel;
    if (activeModel) {
      persistHolePunchPlacementsForModel(activeModel, holePunchPlacementsRef.current);
    }
  }, [persistHolePunchPlacementsForModel, scene.activeModel]);

  /**
   * Gizmo-based placement move — applies the delta directly without snapping
   * to surface normals, giving the user precise axis-constrained control.
   */
  const holePunchGizmoDragRef = React.useRef<{
    placementId: string;
    startWorldPoint: THREE.Vector3;
    startLocalPoint: THREE.Vector3;
    accumulatedDelta: THREE.Vector3;
    /** Inverse model matrix (world→local) captured at drag start, used to
     *  convert the world-space gizmo delta into the model's local coordinate
     *  space so the persisted localPoint stays accurate for Rust. */
    inverseModelMatrix: THREE.Matrix4;
  } | null>(null);

  const handleHolePunchGizmoMoveStart = React.useCallback((placementId: string) => {
    const placement = holePunchPlacementsRef.current.find((candidate) => candidate.id === placementId);
    if (!placement) {
      holePunchGizmoDragRef.current = null;
      return;
    }

    // Compute the inverse model matrix so we can convert the world-space
    // gizmo delta into the model's local coordinate space. This keeps
    // localPoint accurate for Rust serialization even when the model is
    // rotated.
    let inverseModelMatrix: THREE.Matrix4;
    const activeModel = scene.activeModel;
    if (activeModel && placement.modelId === activeModel.id) {
      const meshMatrix = new THREE.Matrix4()
        .compose(
          activeModel.transform.position.clone(),
          quaternionFromGlobalEuler(activeModel.transform.rotation),
          activeModel.transform.scale.clone(),
        )
        .multiply(new THREE.Matrix4().makeTranslation(
          -activeModel.geometry.center.x,
          -activeModel.geometry.center.y,
          -activeModel.geometry.center.z,
        ));
      inverseModelMatrix = meshMatrix.invert();
    } else {
      // Fallback: identity matrix (world = local), preserves old behavior.
      inverseModelMatrix = new THREE.Matrix4();
    }

    holePunchGizmoDragRef.current = {
      placementId,
      startWorldPoint: placement.worldPoint.clone(),
      startLocalPoint: placement.localPoint.clone(),
      accumulatedDelta: new THREE.Vector3(),
      inverseModelMatrix,
    };
  }, [scene.activeModel]);

  const handleHolePunchGizmoMove = React.useCallback((
    placementId: string,
    delta: THREE.Vector3,
  ) => {
    const drag = holePunchGizmoDragRef.current;
    if (!drag || drag.placementId !== placementId) return;

    drag.accumulatedDelta.add(delta);
    const nextWorldPoint = drag.startWorldPoint.clone().add(drag.accumulatedDelta);
    // Convert the new world point back to model local space using the
    // inverse matrix captured at drag start. Directly adding the world-space
    // delta to the local point would be wrong when the model has a rotation.
    const nextLocalPoint = nextWorldPoint.clone().applyMatrix4(drag.inverseModelMatrix);

    setHolePunchPlacements((previous) => {
      const nextPlacements = previous.map((placement) => {
        if (placement.id !== placementId) return placement;
        return {
          ...placement,
          worldPoint: nextWorldPoint.clone(),
          localPoint: nextLocalPoint.clone(),
        };
      });
      holePunchPlacementsRef.current = nextPlacements;
      return nextPlacements;
    });
  }, []);

  const handleHolePunchGizmoMoveEnd = React.useCallback((placementId: string) => {
    if (!holePunchGizmoDragRef.current || holePunchGizmoDragRef.current.placementId !== placementId) return;

    suppressHolePunchGizmoReleaseClickUntilRef.current = Date.now() + 250;
    holePunchGizmoDragRef.current = null;
    const activeModel = scene.activeModel;
    if (activeModel) {
      persistHolePunchPlacementsForModel(activeModel, holePunchPlacementsRef.current);
    }
  }, [persistHolePunchPlacementsForModel, scene.activeModel]);

  /**
   * Gizmo-based placement rotation — updates the cylinder normal without
   * snapping, giving the user precise rotational control via the gizmo rings.
   */
  const holePunchGizmoRotateRef = React.useRef<{ placementId: string } | null>(null);

  const handleHolePunchGizmoRotateStart = React.useCallback((placementId: string) => {
    holePunchGizmoRotateRef.current = { placementId };
  }, []);

  const handleHolePunchGizmoRotate = React.useCallback((
    placementId: string,
    newNormal: THREE.Vector3,
    worldFrame: HolePunchWorldFrame,
  ) => {
    if (!holePunchGizmoRotateRef.current || holePunchGizmoRotateRef.current.placementId !== placementId) return;

    // Convert the world-space normal to local space using the inverse
    // normal matrix, so the persisted direction stays accurate for Rust.
    let localNormal = newNormal.clone();
    const activeModel = scene.activeModel;
    if (activeModel) {
      const meshMatrix = new THREE.Matrix4()
        .compose(
          activeModel.transform.position.clone(),
          quaternionFromGlobalEuler(activeModel.transform.rotation),
          activeModel.transform.scale.clone(),
        )
        .multiply(new THREE.Matrix4().makeTranslation(
          -activeModel.geometry.center.x,
          -activeModel.geometry.center.y,
          -activeModel.geometry.center.z,
        ));
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(meshMatrix);
      const inverseNormalMatrix = normalMatrix.clone().invert();
      localNormal = newNormal.clone().applyMatrix3(inverseNormalMatrix).normalize();
    }

    setHolePunchPlacements((previous) => {
      const nextPlacements = previous.map((placement) => {
        if (placement.id !== placementId) return placement;
        return {
          ...placement,
          worldNormal: newNormal.clone(),
          worldFrame: cloneHolePunchWorldFrame(worldFrame),
          localNormal,
        };
      });
      holePunchPlacementsRef.current = nextPlacements;
      return nextPlacements;
    });
  }, [scene.activeModel]);

  const handleHolePunchGizmoRotateEnd = React.useCallback((placementId: string) => {
    if (!holePunchGizmoRotateRef.current || holePunchGizmoRotateRef.current.placementId !== placementId) return;

    suppressHolePunchGizmoReleaseClickUntilRef.current = Date.now() + 250;
    holePunchGizmoRotateRef.current = null;
    const activeModel = scene.activeModel;
    if (activeModel) {
      persistHolePunchPlacementsForModel(activeModel, holePunchPlacementsRef.current);
    }
  }, [persistHolePunchPlacementsForModel, scene.activeModel]);

  const handleDeleteSelectedHolePunchPlacement = React.useCallback(() => {
    const activeModel = scene.activeModel;
    if (!activeModel || selectedHolePunchPlacementIds.length === 0) return;

    const selectedIds = new Set(selectedHolePunchPlacementIds);
    const nextPlacements = holePunchPlacements.filter((placement) => !selectedIds.has(placement.id));
    const remainingForModel = nextPlacements.filter((p) => p.modelId === activeModel.id);
    const holesWereBaked = activeModel.meshModifiers?.holePunchesBakedIntoGeometry === true;

    setHolePunchPlacements(nextPlacements);
    setSelectedHolePunchPlacementIds([]);
    setHoveredHolePunchPlacementId(null);
    setHolePunchHoverPlacement(null);

    // If holes were baked and we just deleted the last placement for the
    // active model, restore the pre-punch geometry so the boolean cut is
    // actually undone — otherwise the hole remains in the mesh and the
    // hollowing cache keeps pointing at stale geometry.
    if (holesWereBaked && remainingForModel.length === 0) {
      const restored = geometryFromSnapshot({
        sourcePositionsBase64: activeModel.meshModifiers?.holePunchSourcePositionsBase64,
        sourcePositionCount: activeModel.meshModifiers?.holePunchSourcePositionCount,
      });
      if (restored) {
        const restoredGeometry = restored.clone();
        const replaced = scene.replaceModelGeometry(activeModel.id, restoredGeometry, 'Hole Punching (Removed)');
        if (!replaced) {
          restoredGeometry.dispose();
        }
        restored.dispose();
      }
      hollowingSourceByModelIdRef.current.delete(activeModel.id);
      // Clear the preview result cache too — it may hold a stale result from
      // when the hole was still present.
      for (const [key, entry] of hollowPreviewResultCacheRef.current.entries()) {
        if (entry.modelId === activeModel.id) {
          disposeHollowPreviewCacheEntry(entry);
          hollowPreviewResultCacheRef.current.delete(key);
        }
      }
      persistActiveModelModifiers({
        ...(activeModel.meshModifiers ?? {}),
        holePunches: [],
        holePunchAppliedPlacements: [],
        holePunchesBakedIntoGeometry: false,
        // Clear the source snapshot — pre-punch geometry was already restored
        // so there's nothing left to apply.
        holePunchSourcePositionsBase64: undefined,
        holePunchSourcePositionCount: undefined,
      });
    } else {
      persistHolePunchPlacementsForModel(activeModel, nextPlacements);
    }
  }, [holePunchPlacements, persistActiveModelModifiers, persistHolePunchPlacementsForModel, scene.activeModel, selectedHolePunchPlacementIds]);

  React.useEffect(() => {
    const unregister = registerDeleteHandler(
      () => (
        scene.mode === 'prepare'
        && transformMgr.transformMode === 'hollowing'
        && selectedHolePunchPlacementIds.length > 0
        && selectedHolePunchPlacements.some((placement) => placement.modelId === scene.activeModel?.id)
      ),
      handleDeleteSelectedHolePunchPlacement,
      50,
    );

    return () => {
      unregister();
    };
  }, [
    handleDeleteSelectedHolePunchPlacement,
    scene.activeModel?.id,
    scene.mode,
    selectedHolePunchPlacementIds.length,
    selectedHolePunchPlacements,
    transformMgr.transformMode,
  ]);

  const handleHolePunchStateChange = React.useCallback((next: HolePunchPanelState) => {
    const normalizedNext: HolePunchPanelState = canUseAutoHolePunchDepth
      ? next
      : { ...next, depthMode: 'manual' };
    setHolePunchState(normalizedNext);
    setHolePunchPlacements((previous) => {
      if (selectedHolePunchPlacementIds.length === 0) return previous;
      const nextPlacements = previous.map((placement) => (
        selectedHolePunchPlacementIdSet.has(placement.id)
          ? {
              ...placement,
              radiusMm: normalizedNext.radiusMm,
              radiusYMm: normalizedNext.radiusYMm,
              depthMm: normalizedNext.depthMode === 'auto'
                ? computeAutoHolePunchDepthMm(placement.modelId, placement.worldPoint, placement.worldNormal)
                : normalizedNext.depthMm,
              depthMode: normalizedNext.depthMode,
            }
          : placement
      ));

      const activeModel = scene.activeModel;
      if (activeModel) {
        persistHolePunchPlacementsForModel(activeModel, nextPlacements);
      }

      return nextPlacements;
    });
  }, [
    canUseAutoHolePunchDepth,
    computeAutoHolePunchDepthMm,
    persistHolePunchPlacementsForModel,
    scene.activeModel,
    selectedHolePunchPlacementIdSet,
    selectedHolePunchPlacementIds.length,
  ]);

  const handleResetHolePunch = React.useCallback(() => {
    const activeModel = scene.activeModel;
    const activeModelId = activeModel?.id ?? null;
    if (!activeModelId || !activeModel) return;

    const restored = geometryFromSnapshot({
      sourcePositionsBase64: activeModel.meshModifiers?.holePunchSourcePositionsBase64,
      sourcePositionCount: activeModel.meshModifiers?.holePunchSourcePositionCount,
    });
    if (restored) {
      const restoredGeometry = restored.clone();
      const replaced = scene.replaceModelGeometry(activeModel.id, restoredGeometry, 'Reset Hole Punching');
      if (!replaced) {
        restoredGeometry.dispose();
      }
      restored.dispose();
    }

    // Pre-punch geometry was restored — invalidate the hollowing source cache
    // so the next hollowing preview uses the hole-free geometry.
    hollowingSourceByModelIdRef.current.delete(activeModel.id);

    setHolePunchPlacements((previous) => {
      const updated = previous.filter((placement) => placement.modelId !== activeModelId);
      persistActiveModelModifiers({
        ...(activeModel.meshModifiers ?? {}),
        holePunches: [],
        holePunchAppliedPlacements: [],
        // Pre-punch geometry was restored — no holes are baked into it.
        holePunchesBakedIntoGeometry: false,
        holePunchSourcePositionsBase64: activeModel.meshModifiers?.holePunchSourcePositionsBase64,
        holePunchSourcePositionCount: activeModel.meshModifiers?.holePunchSourcePositionCount,
      });
      return updated;
    });
    setHolePunchState(defaultHolePunchState);
    setSelectedHolePunchPlacementIds([]);
    setHoveredHolePunchPlacementId(null);
    setHolePunchHoverPlacement(null);
  }, [defaultHolePunchState, persistActiveModelModifiers, scene.activeModel]);

  const requestResetHolePunch = React.useCallback(() => {
    if (!canResetHolePunch || isApplyingHolePunch) return;
    const activeModel = scene.activeModel;
    const hasAppliedOrBakedPunches = (activeModel?.meshModifiers?.holePunchAppliedPlacements?.length ?? 0) > 0
      || Boolean(
        activeModel?.meshModifiers?.holePunchesBakedIntoGeometry
        && (activeModel?.meshModifiers?.holePunches?.length ?? 0) > 0,
      );
    if (!hasAppliedOrBakedPunches) {
      // Only un-applied draft punches — skip confirmation.
      handleResetHolePunch();
      return;
    }
    setPendingModifierResetAction('hole_punch');
  }, [canResetHolePunch, handleResetHolePunch, isApplyingHolePunch, scene.activeModel]);

  const handleApplyHolePunch = React.useCallback(() => {
    void (async () => {
      const activeModel = scene.activeModel;
      if (!activeModel) return;

      const placements = activeHolePunchPlacements;
      const persisted = toPersistedHolePunchPlacements(activeModel, placements)
        .filter((placement) => placement.radiusMm > 0 && placement.depthMm > 0);

      const bakedPlacements = activeModel.meshModifiers?.holePunches ?? [];
      const bakedPlacementSignaturesById = new Map<string, string>();
      for (const placement of bakedPlacements) {
        bakedPlacementSignaturesById.set(placement.id, serializeSingleHolePunchPlacement(placement));
      }

      const draftPlacementSignaturesById = new Map<string, string>();
      for (const placement of persisted) {
        draftPlacementSignaturesById.set(placement.id, serializeSingleHolePunchPlacement(placement));
      }

      const bakedPlacementsUnchanged = bakedPlacements.every((placement) => (
        draftPlacementSignaturesById.get(placement.id) === serializeSingleHolePunchPlacement(placement)
      ));

      const appendOnlyNewPlacements = (
        activeModel.meshModifiers?.holePunchesBakedIntoGeometry
        && bakedPlacementsUnchanged
        && persisted.length > bakedPlacements.length
      )
        ? persisted.filter((placement) => !bakedPlacementSignaturesById.has(placement.id))
        : [];

      const hasStoredPunchSource = Boolean(
        activeModel.meshModifiers?.holePunchSourcePositionsBase64
        && Number.isFinite(activeModel.meshModifiers?.holePunchSourcePositionCount)
        && (activeModel.meshModifiers?.holePunchSourcePositionCount ?? 0) > 0,
      );

      const useAppendOnlyFastPath = Boolean(
        activeModel.meshModifiers?.holePunchesBakedIntoGeometry
        && hasStoredPunchSource
        && appendOnlyNewPlacements.length > 0,
      );

      const punchesToApply = useAppendOnlyFastPath
        ? appendOnlyNewPlacements
        : persisted;

      if (persisted.length === 0) {
        const restored = geometryFromSnapshot({
          sourcePositionsBase64: activeModel.meshModifiers?.holePunchSourcePositionsBase64,
          sourcePositionCount: activeModel.meshModifiers?.holePunchSourcePositionCount,
        });

        if (restored) {
          const restoredGeometry = restored.clone();
          const replaced = scene.replaceModelGeometry(activeModel.id, restoredGeometry, 'Hole Punching (Removed)');
          if (!replaced) {
            restoredGeometry.dispose();
          }
          restored.dispose();
        }

        // Pre-punch geometry was restored — clear the hollowing cache so the
        // next preview resolves from the hole-free geometry.
        hollowingSourceByModelIdRef.current.delete(activeModel.id);

        persistActiveModelModifiers({
          ...(activeModel.meshModifiers ?? {}),
          holePunches: [],
          holePunchAppliedPlacements: [],
          // No holes remain in the geometry after restoring the pre-punch source.
          holePunchesBakedIntoGeometry: false,
          holePunchSourcePositionsBase64: activeModel.meshModifiers?.holePunchSourcePositionsBase64,
          holePunchSourcePositionCount: activeModel.meshModifiers?.holePunchSourcePositionCount,
        });
        return;
      }

      setIsApplyingHolePunch(true);
      await sleep(0);
      try {
        let sourceGeometry: THREE.BufferGeometry;
        let ownsSourceGeometry = false;
        let sourceSnapshot: {
          sourcePositionsBase64: string;
          sourcePositionCount: number;
        };

        if (useAppendOnlyFastPath) {
          sourceGeometry = activeModel.geometry.geometry.clone();
          ownsSourceGeometry = true;
          sourceSnapshot = {
            sourcePositionsBase64: activeModel.meshModifiers?.holePunchSourcePositionsBase64 ?? '',
            sourcePositionCount: activeModel.meshModifiers?.holePunchSourcePositionCount ?? 0,
          };
        } else if (hasStoredPunchSource) {
          const restoredFromSnapshot = geometryFromSnapshot({
            sourcePositionsBase64: activeModel.meshModifiers?.holePunchSourcePositionsBase64,
            sourcePositionCount: activeModel.meshModifiers?.holePunchSourcePositionCount,
          });

          if (!restoredFromSnapshot) {
            showOperationError('Hole punch source snapshot is missing or invalid. Re-apply cannot continue.');
            return;
          }

          sourceGeometry = restoredFromSnapshot;
          ownsSourceGeometry = true;
          sourceSnapshot = snapshotGeometryPositions(sourceGeometry);
        } else {
          sourceGeometry = activeModel.geometry.geometry.clone();
          ownsSourceGeometry = true;
          sourceSnapshot = snapshotGeometryPositions(sourceGeometry);
        }

        const sourceBbox = sourceGeometry.boundingBox
          ?? new THREE.Box3().setFromBufferAttribute(sourceGeometry.getAttribute('position') as THREE.BufferAttribute);
        const sourceSize = sourceBbox.getSize(new THREE.Vector3());
        const toMm = (norm: number, min: number, span: number) => min + (norm * (span <= 1e-9 ? 0 : span));
        const toNorm = (value: number, min: number, span: number) => (span <= 1e-9 ? 0.5 : (value - min) / span);

        const punchOptions: PunchOptions = {
          punches: punchesToApply.map((placement) => {
            const axis = new THREE.Vector3(
              placement.direction[0],
              placement.direction[1],
              placement.direction[2],
            );
            if (axis.lengthSq() <= 1e-12) {
              axis.set(0, 0, -1);
            } else {
              axis.normalize();
            }

            const axisScaleFactor = getDirectionScaleFactor(axis, activeModel.transform.scale);
            const radialScaleFactor = getRadialScaleFactor(axis, activeModel.transform.scale);
            const localOutsideProtrusionMm = worldMmToLocalMm(
              HOLE_PUNCH_OUTSIDE_PROTRUSION_MM,
              axisScaleFactor,
            );
            const localDepthMm = worldMmToLocalMm(placement.depthMm, axisScaleFactor);
            const localRadiusMm = worldMmToLocalMm(placement.radiusMm, radialScaleFactor);
            const localRadiusYMm = placement.radiusYMm != null
              ? worldMmToLocalMm(placement.radiusYMm, radialScaleFactor)
              : undefined;

            const surfaceCenterMm = new THREE.Vector3(
              toMm(placement.centerNorm[0], sourceBbox.min.x, sourceSize.x),
              toMm(placement.centerNorm[1], sourceBbox.min.y, sourceSize.y),
              toMm(placement.centerNorm[2], sourceBbox.min.z, sourceSize.z),
            );

            // Punch kernel expects cylinder start at centerNorm and extends along
            // direction for lengthMm. Shift start slightly opposite axis so cut
            // spans outside protrusion + requested depth inside.
            const shiftedStartMm = surfaceCenterMm.clone().add(
              axis.clone().multiplyScalar(-localOutsideProtrusionMm),
            );

            const shiftedStartNorm: [number, number, number] = [
              toNorm(shiftedStartMm.x, sourceBbox.min.x, sourceSize.x),
              toNorm(shiftedStartMm.y, sourceBbox.min.y, sourceSize.y),
              toNorm(shiftedStartMm.z, sourceBbox.min.z, sourceSize.z),
            ];

            // No longer clamp centerNorm to [0,1] — the Rust backend now
            // accepts out-of-bounds values so holes pulled outside the model
            // bbox via the gizmo stay exactly where the user positioned them.
            // The outside-protrusion shift may push the start past the bbox
            // boundary; compute the effective extra length from the actual
            // (unclamped) offset between surface center and shifted start.
            const shiftedStartMmActual = new THREE.Vector3(
              toMm(shiftedStartNorm[0], sourceBbox.min.x, sourceSize.x),
              toMm(shiftedStartNorm[1], sourceBbox.min.y, sourceSize.y),
              toMm(shiftedStartNorm[2], sourceBbox.min.z, sourceSize.z),
            );

            const effectiveOutsideMm = Math.max(
              0,
              surfaceCenterMm.clone().sub(shiftedStartMmActual).dot(axis),
            );

            return {
              centerNorm: shiftedStartNorm,
              radiusMm: localRadiusMm,
              radiusYMm: localRadiusYMm,
              direction: [axis.x, axis.y, axis.z] as [number, number, number],
              lengthMm: localDepthMm + effectiveOutsideMm,
            };
          }),
        };

        const punchSourceKey = useAppendOnlyFastPath
          ? `${activeModel.id}::append:${buildGeometryVersionKey(activeModel.geometry.geometry)}::${appendOnlyNewPlacements.length}`
          : hasStoredPunchSource
          ? `${activeModel.id}::hole-source:${activeModel.meshModifiers?.holePunchSourcePositionCount ?? 0}:${activeModel.meshModifiers?.holePunchSourcePositionsBase64?.length ?? 0}`
          : `${activeModel.id}::geom:${buildGeometryVersionKey(activeModel.geometry.geometry)}`;

        const staged = await stagePunchSource(sourceGeometry, punchSourceKey);
        if (!staged) {
          if (ownsSourceGeometry) {
            sourceGeometry.dispose();
          }
          showOperationError('Hole punching is available in DragonFruit Desktop only.');
          return;
        }

        const result = await punchFromCapturedSource(punchOptions);
        if (!result) {
          if (ownsSourceGeometry) {
            sourceGeometry.dispose();
          }
          showOperationError('Hole punching is available in DragonFruit Desktop only.');
          return;
        }

        // Detect manifold boolean failure: if the output triangle count matches
        // the source (mesh unchanged) despite valid punches, the mesh is too
        // damaged for boolean operations. We compare output vs source rather
        // than removedTriangleCount because manifold re-triangulation can
        // increase the triangle count (e.g., 136 → 210), making a saturating
        // subtraction report zero triangles removed even when the boolean
        // succeeded (non-hollowed meshes are especially prone to this).
        if (result.report.outputTriangleCount === result.report.sourceTriangleCount && result.report.punchCount > 0) {
          if (ownsSourceGeometry) {
            sourceGeometry.dispose();
          }
          setShowDamagedModelDialog(true);
          return;
        }

        // Backend work is done — switch the blocking overlay to the
        // "loading mesh" message and let it paint before the heavy
        // synchronous finalization below (see handleApplyHollowing).
        beginFinalizing('holePunch');
        await nextPaint();

        const nextGeometry = new THREE.BufferGeometry();
        nextGeometry.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
        nextGeometry.computeVertexNormals();
        nextGeometry.computeBoundingBox();
        nextGeometry.computeBoundingSphere();

        const replaced = scene.replaceModelGeometry(
          activeModel.id,
          nextGeometry,
          `Hole Punching (${result.report.outputTriangleCount.toLocaleString()} tris)`,
        );
        if (!replaced) {
          if (ownsSourceGeometry) {
            sourceGeometry.dispose();
          }
          nextGeometry.dispose();
          clearFinalizing();
          return;
        }

        if (ownsSourceGeometry) {
          sourceGeometry.dispose();
        }

        // Hole-punched geometry just replaced the model — invalidate the
        // hollowing source cache so future hollowing previews resolve from
        // the current (hole-punched) geometry rather than a stale snapshot.
        hollowingSourceByModelIdRef.current.delete(activeModel.id);

        persistActiveModelModifiers({
          ...(activeModel.meshModifiers ?? {}),
          holePunches: persisted,
          holePunchAppliedPlacements: persisted,
          holePunchesBakedIntoGeometry: true,
          holePunchSourcePositionsBase64: sourceSnapshot.sourcePositionsBase64,
          holePunchSourcePositionCount: sourceSnapshot.sourcePositionCount,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showOperationError(`Hole punching failed: ${message}`);
        clearFinalizing();
      } finally {
        setIsApplyingHolePunch(false);
      }
    })();
  }, [activeHolePunchPlacements, beginFinalizing, clearFinalizing, nextPaint, persistActiveModelModifiers, scene, sleep]);

  React.useEffect(() => {
    if (!pendingHolePunchAutoApplyModelId) return;
    if (isApplyingHollowing || isApplyingHolePunch) return;

    const activeModel = scene.activeModel;
    if (!activeModel || activeModel.id !== pendingHolePunchAutoApplyModelId) {
      return;
    }

    if ((activeModel.meshModifiers?.holePunches?.length ?? 0) === 0) {
      setPendingHolePunchAutoApplyModelId(null);
      return;
    }

    setPendingHolePunchAutoApplyModelId(null);
    handleApplyHolePunch();
  }, [
    handleApplyHolePunch,
    isApplyingHolePunch,
    isApplyingHollowing,
    pendingHolePunchAutoApplyModelId,
    scene.activeModel,
  ]);

  return {
    holePunchState,
    setHolePunchState,
    holePunchPlacements,
    setHolePunchPlacements,
    holePunchPlacementsRef,
    holePunchDragStateRef,
    suppressHolePunchClickPlacementIdRef,
    suppressHolePunchGizmoReleaseClickUntilRef,
    holePunchAutoDepthRaycasterRef,
    holePunchAutoDepthMeshRef,
    selectedHolePunchPlacementIdSet,
    selectedHolePunchPlacements,
    canUseAutoHolePunchDepth,
    syncHolePunchPanelFromSelection,
    activeHolePunchPlacements,
    previousRecommendedHolePunchDepthRef,
    appliedHolePunchPlacementsSignature,
    draftHolePunchPlacementsSignature,
    isHolePunchApplied,
    holePunchNeedsBake,
    isHolePunchDirty,
    appliedHolePunchPlacementIds,
    canResetHolePunch,
    persistHolePunchPlacementsForModel,
    computeAutoHolePunchDepthMmForGeometry,
    computeAutoHolePunchDepthMm,
    buildHolePunchPlacementForHit,
    buildHolePunchPlacementFromHit,
    handleHolePunchClick,
    handleHolePunchHover,
    handleSelectHolePunchPlacement,
    handleHolePunchPlacementDragStart,
    handleHolePunchPlacementDragMove,
    handleHolePunchPlacementDragEnd,
    holePunchGizmoDragRef,
    handleHolePunchGizmoMoveStart,
    handleHolePunchGizmoMove,
    handleHolePunchGizmoMoveEnd,
    holePunchGizmoRotateRef,
    handleHolePunchGizmoRotateStart,
    handleHolePunchGizmoRotate,
    handleHolePunchGizmoRotateEnd,
    handleDeleteSelectedHolePunchPlacement,
    handleHolePunchStateChange,
    handleResetHolePunch,
    requestResetHolePunch,
    handleApplyHolePunch,
  };
}

import React from 'react';
import { hotkeyStore } from '@/hotkeys/hotkeyStore';
import * as THREE from 'three';
import type { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import type { useTransformManager } from '@/features/transform/useTransformManager';
import type { HollowingPanelState } from '@/features/hollowing';
import type { ModelMeshModifiers } from '@/features/mesh-modifiers/types';
import type { MeshShaderType } from '@/features/shaders/mesh';
import type { HolePunchPanelState } from '@/features/hole-punching/HolePunchPanel';
import type { HolePunchPlacementState } from '@/features/hole-punching/holePunchGeometry';
import { snapshotGeometryPositions, geometryFromSnapshot } from '@/utils/geometrySnapshot';
import { bytesToBase64, base64ToBytes } from '@/utils/base64';
import {
  getUniformScaleFactorForThickness,
  worldMmToLocalMm,
  computeVoxelResolution,
} from '@/utils/geometryScaling';
import {
  hollowApplyFromCapturedSource,
  hollowFromGeometry,
  hollowPreviewFromCapturedSource,
  selectRemovedVoxelsInPolygon,
  stageHollowPreviewSource,
  type HollowOptions,
  type HollowReport,
} from '@/utils/meshHollowing';
import { centerCavityPositions } from '@/features/hollowing/cavityCentering';
import { getRotationQuatTuple, resolveBlockedVoxelValidity } from '@/features/mesh-modifiers/hollowingGrid';
import { toPersistedHolePunchPlacements } from '@/features/hole-punching/holePunchPersistence';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { serializeHollowingModifier } from '@/features/hollowing/hollowingSerialize';
import {
  buildGeometryVersionKey,
  createGeometryFromPreviewPositions,
  disposeHollowPreviewCacheEntry,
  disposeHollowPreviewGeometryIfUncached,
} from '@/features/hollowing/hollowingPreviewCache';
import type {
  HollowPreviewState,
  HollowPreviewCacheEntry,
  HollowingSourceEntry,
  CavityGeometryEntry,
} from '@/features/hollowing/hollowingPreviewTypes';

type SceneManager = ReturnType<typeof useSceneCollectionManager>;
type TransformManager = ReturnType<typeof useTransformManager>;

const HOLLOW_PREVIEW_DEBOUNCE_MS = 90;
const HOLLOW_PREVIEW_THICKNESS_QUANTUM_MM = 0.2;

function areSortedNumberArraysEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

function isKeyboardTargetEditable(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest('[contenteditable="true"]'));
}

function quantizePreviewShellThicknessMm(valueMm: number): number {
  const clamped = Math.max(0.1, valueMm);
  return Number((Math.round(clamped / HOLLOW_PREVIEW_THICKNESS_QUANTUM_MM) * HOLLOW_PREVIEW_THICKNESS_QUANTUM_MM).toFixed(3));
}

/** Late/cross-cutting dependencies the hollowing manager reads at event/effect
 *  time via deps.current.*. Home populates this ref AFTER the hole-punch manager
 *  and shared callbacks exist, breaking the TDZ/dependency cycle. */
export type HollowingManagerDeps = {
  showOperationError: (message: string) => void;
  setShowDamagedModelDialog: React.Dispatch<React.SetStateAction<boolean>>;
  /** Modifier-apply overlay finalizing controls (useModifierApplyOverlay in Home). */
  beginFinalizing: (kind: 'hollowing' | 'holePunch') => void;
  clearFinalizing: () => void;
  nextPaint: () => Promise<void>;
  persistActiveModelModifiers: (next: ModelMeshModifiers | undefined) => void;
  setPendingModifierResetAction: React.Dispatch<React.SetStateAction<'hollowing' | 'hole_punch' | 'clear_hollowing' | null>>;
  setInteriorView: React.Dispatch<React.SetStateAction<boolean>>;
  setSessionShaderOverride: React.Dispatch<React.SetStateAction<MeshShaderType | null>>;
  computeAutoHolePunchDepthMmForGeometry: (
    model: SceneManager['models'][number],
    targetGeometry: THREE.BufferGeometry,
    worldPoint: THREE.Vector3,
    worldNormal: THREE.Vector3,
  ) => number;
  setHolePunchState: React.Dispatch<React.SetStateAction<HolePunchPanelState>>;
  setHolePunchPlacements: React.Dispatch<React.SetStateAction<HolePunchPlacementState[]>>;
  holePunchPlacementsRef: React.MutableRefObject<HolePunchPlacementState[]>;
  setPendingHolePunchAutoApplyModelId: React.Dispatch<React.SetStateAction<string | null>>;
  setPendingBlockerResetState: React.Dispatch<React.SetStateAction<HollowingPanelState | null>>;
  setSelectedHolePunchPlacementIds: React.Dispatch<React.SetStateAction<string[]>>;
  setHoveredHolePunchPlacementId: React.Dispatch<React.SetStateAction<string | null>>;
  setHolePunchHoverPlacement: React.Dispatch<React.SetStateAction<HolePunchPlacementState | null>>;
  /** Read at effect time; see deps-ref note above (not reactive). */
  interiorView: boolean;
};

export type UseHollowingManagerOptions = {
  scene: SceneManager;
  transformMgr: TransformManager;
  deps: React.MutableRefObject<HollowingManagerDeps>;
};

export function useHollowingManager({
  scene,
  transformMgr,
  deps,
}: UseHollowingManagerOptions) {
  const [isPreviewingHollowing, setIsPreviewingHollowing] = React.useState(false);
  const [hollowPreview, setHollowPreview] = React.useState<HollowPreviewState | null>(null);
  const [hollowingState, setHollowingState] = React.useState<HollowingPanelState>({
    mode: 'cavity',
    voxelSizeMm: 0.65,
    shellThicknessMm: 2.0,
    infillMode: 'lattice',
    infillCellMm: 4.2426,
    infillBeamRadiusMm: 0.35,
    openFace: 'z_max',
  });
  const [isShellOpenFaceSelected, setIsShellOpenFaceSelected] = React.useState(true);
  const [hollowingDraftEnabled, setHollowingDraftEnabled] = React.useState(false);
  const [hollowingEditMode, setHollowingEditMode] = React.useState(false);
  const [blockedHollowVoxelIndices, setBlockedHollowVoxelIndices] = React.useState<number[]>([]);
  const [editingBlockedHollowVoxelIndices, setEditingBlockedHollowVoxelIndices] = React.useState<number[]>([]);
  const [isApplyingBlockersHollowing, setIsApplyingBlockersHollowing] = React.useState(false);
  const [isApplyingHollowing, setIsApplyingHollowing] = React.useState(false);

  const editingBlockedHollowVoxelIndicesRef = React.useRef<number[]>([]);
  const hollowVoxelEditUndoStackRef = React.useRef<number[][]>([]);
  const hollowVoxelEditRedoStackRef = React.useRef<number[][]>([]);
  const hollowingEditModeRef = React.useRef(false);
  const hollowPreviewDebounceTimerRef = React.useRef<number | ReturnType<typeof setTimeout> | null>(null);
  const hollowPreviewRequestSeqRef = React.useRef(0);
  const hollowPreviewResultCacheRef = React.useRef<Map<string, HollowPreviewCacheEntry>>(new Map());
  const hollowPreviewWarmupKeyRef = React.useRef<string | null>(null);
  const hollowingSourceByModelIdRef = React.useRef<Map<string, HollowingSourceEntry>>(new Map());
  const cavityGeometryByModelIdRef = React.useRef<Map<string, CavityGeometryEntry>>(new Map());

  const defaultHollowingState = React.useMemo<HollowingPanelState>(() => ({
    mode: 'cavity',
    voxelSizeMm: 0.65,
    shellThicknessMm: 2.0,
    infillMode: 'lattice',
    infillCellMm: 4.2426,
    infillBeamRadiusMm: 0.35,
    openFace: 'z_max',
  }), []);

  const handleApplyHollowing = React.useCallback(() => {
    void (async () => {
      const activeModel = scene.activeModel;
      if (!activeModel) return;

      const persistedHollowing = activeModel.meshModifiers?.hollowing;
      const shouldApply = hollowingDraftEnabled || !persistedHollowing?.enabled;
      if (!shouldApply) return;

      if (hollowingState.mode === 'shell_open_face' && !isShellOpenFaceSelected) {
        deps.current.showOperationError('Pick the face to open before applying Shell mode.');
        return;
      }

      const holesWereAlreadyBaked = activeModel.meshModifiers?.holePunchesBakedIntoGeometry === true;

      const existingSource = hollowingSourceByModelIdRef.current.get(activeModel.id);
      const needsNewSource = !existingSource || !persistedHollowing?.enabled;

      let sourceGeometry: THREE.BufferGeometry;
      if (needsNewSource) {
        if (existingSource) {
          existingSource.geometry.dispose();
        }

        if (persistedHollowing?.enabled) {
          const restoredFromSnapshot = geometryFromSnapshot(persistedHollowing);
          sourceGeometry = restoredFromSnapshot ?? activeModel.geometry.geometry.clone();
        } else {
          // Use the current geometry which may already have baked holes.
          sourceGeometry = activeModel.geometry.geometry.clone();
        }

        hollowingSourceByModelIdRef.current.set(activeModel.id, {
          geometry: sourceGeometry,
        });
      } else {
        sourceGeometry = existingSource.geometry;
      }

      setIsApplyingHollowing(true);
      try {
        const effectiveHollowMode = hollowingState.mode === 'shell_open_face'
          ? 'cavity'
          : hollowingState.mode;
        const shellScaleFactor = getUniformScaleFactorForThickness(activeModel.transform.scale);
        const bbox = sourceGeometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
          sourceGeometry.getAttribute('position') as THREE.BufferAttribute,
        );
        const bboxSize = bbox.getSize(new THREE.Vector3());
        const maxExtent = Math.max(bboxSize.x, bboxSize.y, bboxSize.z);
        const applyQuat = new THREE.Quaternion().setFromEuler(activeModel.transform.rotation);
        const options: HollowOptions = {
          mode: effectiveHollowMode,
          voxelResolution: computeVoxelResolution(worldMmToLocalMm(hollowingState.voxelSizeMm, shellScaleFactor), maxExtent),
          shellThicknessMm: worldMmToLocalMm(hollowingState.shellThicknessMm, shellScaleFactor),
          blockedVoxelIndices: blockedHollowVoxelIndices,
          infillMode: hollowingState.infillMode,
          infillCellMm: worldMmToLocalMm(hollowingState.infillCellMm, shellScaleFactor),
          infillBeamRadiusMm: worldMmToLocalMm(hollowingState.infillBeamRadiusMm, shellScaleFactor),
          openFace: hollowingState.openFace,
          drainHoles: [],
          previewCavityOnly: false,
          smoothInternalSurfaces: true,
          internalChamferPasses: 2,
          rotationQuat: [applyQuat.x, applyQuat.y, applyQuat.z, applyQuat.w],
        };
        const sourceGeometryKey = buildGeometryVersionKey(sourceGeometry);
        const staged = await stageHollowPreviewSource(
          sourceGeometry,
          `${activeModel.id}::${sourceGeometryKey}`,
        );

        const result = staged
          ? await hollowApplyFromCapturedSource(options)
          : await hollowFromGeometry(sourceGeometry, options);
        if (!result) {
          deps.current.showOperationError('Hollowing is available in DragonFruit Desktop only.');
          return;
        }

        // Detect hollowing failure: if no voxels were removed, the manifold
        // stabilization could not resolve the cavity surface, likely because
        // the mesh is too damaged for boolean operations.
        if (result.report && 'removedVoxels' in result.report && result.report.removedVoxels === 0) {
          deps.current.setShowDamagedModelDialog(true);
          return;
        }

        // Backend work is done — everything below is main-thread mesh
        // finalization. Switch the blocking overlay to the "loading mesh"
        // message and give it one frame to paint before the heavy
        // synchronous block starts; the drain-watcher effect clears the
        // flag once the swap and its deferred work have settled.
        deps.current.beginFinalizing('hollowing');
        await deps.current.nextPaint();

        const nextGeometry = new THREE.BufferGeometry();
        nextGeometry.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
        nextGeometry.computeVertexNormals();
        nextGeometry.computeBoundingBox();
        nextGeometry.computeBoundingSphere();

        // Store cavity geometry for Interior View Mode
        if (result.cavityPositions) {
          const existingCavity = cavityGeometryByModelIdRef.current.get(activeModel.id);
          if (existingCavity) {
            existingCavity.geometry.dispose();
          }
          const cavityGeometry = new THREE.BufferGeometry();
          cavityGeometry.setAttribute('position', new THREE.BufferAttribute(result.cavityPositions, 3));
          cavityGeometry.computeVertexNormals();
          cavityGeometry.computeBoundingBox();
          cavityGeometry.computeBoundingSphere();
          cavityGeometryByModelIdRef.current.set(activeModel.id, { geometry: cavityGeometry });
        } else {
          const existingCavity = cavityGeometryByModelIdRef.current.get(activeModel.id);
          if (existingCavity) {
            existingCavity.geometry.dispose();
            cavityGeometryByModelIdRef.current.delete(activeModel.id);
          }
        }

        const modeLabel = hollowingState.mode === 'shell_open_face'
          ? 'Shell Hollowing'
          : hollowingState.mode === 'infill'
            ? 'Infill Hollowing'
            : 'Cavity Hollowing';
        const replaced = scene.replaceModelGeometry(
          activeModel.id,
          nextGeometry,
          `${modeLabel} (${result.report.outputTriangleCount.toLocaleString()} tris)`,
        );
        if (!replaced) {
          nextGeometry.dispose();
          deps.current.clearFinalizing();
          return;
        }

        // Hollowing is now baked — clear the preview overlay and exit X-Ray
        // forced shader so the user can see surface detail for hole placement.
        clearHollowPreview();
        deps.current.setSessionShaderOverride(null);

        const sourceSnapshot = snapshotGeometryPositions(sourceGeometry);
        let cavityPositionsBase64: string | undefined;
        let cavityPositionCount: number | undefined;
        if (result.cavityPositions) {
          // Recenter the PERSISTED cavity by the same −center ExportManager
          // bakes into the model STL on save (model.geometry.center, which
          // replaceModelGeometry derives from nextGeometry's bounding box).
          // On reload the cavity is rebuilt verbatim, so the on-disk cavity
          // must share the model's centered frame or it renders displaced by
          // ~half the model height. The in-session cavity geometry (built above
          // from the raw result.cavityPositions) is intentionally left untouched.
          if (!nextGeometry.boundingBox) nextGeometry.computeBoundingBox();
          const modelCenter = new THREE.Vector3();
          nextGeometry.boundingBox?.getCenter(modelCenter);
          const centeredCavity = centerCavityPositions(result.cavityPositions, modelCenter);
          const cavityBytes = new Uint8Array(
            centeredCavity.buffer,
            centeredCavity.byteOffset,
            centeredCavity.byteLength,
          );
          cavityPositionsBase64 = bytesToBase64(cavityBytes);
          cavityPositionCount = result.cavityPositions.length / 3;
        }

        deps.current.setHolePunchState((previous) => (
          previous.depthMode === 'auto'
            ? previous
            : { ...previous, depthMode: 'auto' }
        ));

        const nextHolePunchPlacements = deps.current.holePunchPlacementsRef.current.map((placement) => {
          if (placement.modelId !== activeModel.id || placement.depthMode !== 'auto') {
            return placement;
          }

          return {
            ...placement,
            depthMm: deps.current.computeAutoHolePunchDepthMmForGeometry(
              activeModel,
              nextGeometry,
              placement.worldPoint,
              placement.worldNormal,
            ),
          };
        });
        deps.current.setHolePunchPlacements(nextHolePunchPlacements);

        const persistedHolePunches = toPersistedHolePunchPlacements(
          { geometry: { geometry: nextGeometry } as GeometryWithBounds },
          nextHolePunchPlacements.filter((placement) => placement.modelId === activeModel.id),
        ).filter((placement) => placement.radiusMm > 0 && placement.depthMm > 0);

        // When holes were already baked before hollowing, they were passed as
        // drainHoles to the hollower which already cut them — no re-apply needed.
        // Only auto-reapply holes that were in draft state (not yet baked).
        const shouldAutoReapplyHolePunches = !holesWereAlreadyBaked && persistedHolePunches.length > 0;

        deps.current.persistActiveModelModifiers({
          ...(activeModel.meshModifiers ?? {}),
          hollowing: {
            enabled: true,
            bakedIntoGeometry: true,
            sourcePositionsBase64: sourceSnapshot.sourcePositionsBase64,
            sourcePositionCount: sourceSnapshot.sourcePositionCount,
            cavityPositionsBase64,
            cavityPositionCount,
            blockedVoxelIndices: blockedHollowVoxelIndices,
            blockedVoxelRotationQuat: blockedHollowVoxelIndices.length > 0
              ? getRotationQuatTuple(activeModel.transform.rotation)
              : undefined,
            mode: effectiveHollowMode,
            voxelSizeMm: hollowingState.voxelSizeMm,
            shellThicknessMm: hollowingState.shellThicknessMm,
            infillMode: hollowingState.infillMode,
            infillCellMm: hollowingState.infillCellMm,
            infillBeamRadiusMm: hollowingState.infillBeamRadiusMm,
            openFace: hollowingState.openFace,
            openFaceSelected: hollowingState.mode === 'shell_open_face'
              ? isShellOpenFaceSelected
              : true,
          },
          holePunches: persistedHolePunches,
          holePunchAppliedPlacements: holesWereAlreadyBaked ? persistedHolePunches : [],
          holePunchesBakedIntoGeometry: holesWereAlreadyBaked,
          holePunchSourcePositionsBase64: holesWereAlreadyBaked
            ? (activeModel.meshModifiers?.holePunchSourcePositionsBase64 ?? undefined)
            : undefined,
          holePunchSourcePositionCount: holesWereAlreadyBaked
            ? (activeModel.meshModifiers?.holePunchSourcePositionCount ?? undefined)
            : undefined,
        });

        if (shouldAutoReapplyHolePunches) {
          deps.current.setPendingHolePunchAutoApplyModelId(activeModel.id);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.current.showOperationError(`Hollowing failed: ${message}`);
        deps.current.clearFinalizing();
      } finally {
        setIsApplyingHollowing(false);
        setIsApplyingBlockersHollowing(false);
      }
    })();
  }, [blockedHollowVoxelIndices, hollowingDraftEnabled, hollowingState, isShellOpenFaceSelected, deps.current.persistActiveModelModifiers, scene]);

  const handleResetHollowing = React.useCallback(() => {
    const activeModel = scene.activeModel;
    if (!activeModel) return;

    const sourceEntry = hollowingSourceByModelIdRef.current.get(activeModel.id)
      ?? (() => {
        const restored = geometryFromSnapshot(activeModel.meshModifiers?.hollowing ?? {});
        if (!restored) return null;
        const entry = { geometry: restored };
        hollowingSourceByModelIdRef.current.set(activeModel.id, entry);
        return entry;
      })();

    if (sourceEntry) {
      const restoredGeometry = sourceEntry.geometry.clone();
      const restored = scene.replaceModelGeometry(activeModel.id, restoredGeometry, 'Reset Hollowing');
      if (!restored) {
        restoredGeometry.dispose();
      }
    }

    // Clear cavity geometry and auto-disable interior view on hollowing reset
    const existingCavity = cavityGeometryByModelIdRef.current.get(activeModel.id);
    if (existingCavity) {
      existingCavity.geometry.dispose();
      cavityGeometryByModelIdRef.current.delete(activeModel.id);
    }
    deps.current.setInteriorView(false);

    setHollowingState(defaultHollowingState);
    setIsShellOpenFaceSelected(true);
    setHollowingDraftEnabled(false);
    setHollowingEditMode(false);
    setBlockedHollowVoxelIndices([]);
    setEditingBlockedHollowVoxelIndices([]);
    deps.current.persistActiveModelModifiers({
      ...(activeModel.meshModifiers ?? {}),
      hollowing: {
        enabled: false,
        bakedIntoGeometry: false,
        // Clear the source snapshot — hollowing was reset so the snapshot is
        // stale (it may contain holes that have since been removed).
        sourcePositionsBase64: undefined,
        sourcePositionCount: undefined,
        blockedVoxelIndices: [],
        blockedVoxelRotationQuat: undefined,
        mode: defaultHollowingState.mode,
        voxelSizeMm: defaultHollowingState.voxelSizeMm,
        shellThicknessMm: defaultHollowingState.shellThicknessMm,
        infillMode: defaultHollowingState.infillMode,
        infillCellMm: defaultHollowingState.infillCellMm,
        infillBeamRadiusMm: defaultHollowingState.infillBeamRadiusMm,
        openFace: defaultHollowingState.openFace,
        openFaceSelected: true,
      },
      // Preserve hole punch baked state — the geometry restored from the
      // hollowing source still contains any pre-baked holes, so the system
      // must not lose track of them.
      holePunchAppliedPlacements: activeModel.meshModifiers?.holePunches ?? [],
      holePunchesBakedIntoGeometry: activeModel.meshModifiers?.holePunchesBakedIntoGeometry === true,
      holePunchSourcePositionsBase64: activeModel.meshModifiers?.holePunchSourcePositionsBase64,
      holePunchSourcePositionCount: activeModel.meshModifiers?.holePunchSourcePositionCount,
    });
  }, [defaultHollowingState, deps.current.persistActiveModelModifiers, scene.activeModel]);

  const handleClearAppliedHollowing = React.useCallback(() => {
    const activeModel = scene.activeModel;
    if (!activeModel) return;

    const sourceEntry = hollowingSourceByModelIdRef.current.get(activeModel.id)
      ?? (() => {
        const restored = geometryFromSnapshot(activeModel.meshModifiers?.hollowing ?? {});
        if (!restored) return null;
        const entry = { geometry: restored };
        hollowingSourceByModelIdRef.current.set(activeModel.id, entry);
        return entry;
      })();

    if (sourceEntry) {
      const restoredGeometry = sourceEntry.geometry.clone();
      const restored = scene.replaceModelGeometry(activeModel.id, restoredGeometry, 'Clear Hollowing');
      if (!restored) {
        restoredGeometry.dispose();
      }
    }

    // Clear cavity geometry and disable interior view
    const existingCavity = cavityGeometryByModelIdRef.current.get(activeModel.id);
    if (existingCavity) {
      existingCavity.geometry.dispose();
      cavityGeometryByModelIdRef.current.delete(activeModel.id);
    }
    deps.current.setInteriorView(false);

    setHollowingDraftEnabled(false);
    setHollowingEditMode(false);
    setBlockedHollowVoxelIndices([]);
    setEditingBlockedHollowVoxelIndices([]);
    deps.current.persistActiveModelModifiers({
      ...(activeModel.meshModifiers ?? {}),
      hollowing: {
        enabled: false,
        bakedIntoGeometry: false,
        sourcePositionsBase64: undefined,
        sourcePositionCount: undefined,
        blockedVoxelIndices: [],
        blockedVoxelRotationQuat: undefined,
        // Keep current settings — don't reset to defaults.
        mode: hollowingState.mode,
        voxelSizeMm: hollowingState.voxelSizeMm,
        shellThicknessMm: hollowingState.shellThicknessMm,
        infillMode: hollowingState.infillMode,
        infillCellMm: hollowingState.infillCellMm,
        infillBeamRadiusMm: hollowingState.infillBeamRadiusMm,
        openFace: hollowingState.openFace,
        openFaceSelected: hollowingState.mode === 'shell_open_face'
          ? isShellOpenFaceSelected
          : true,
      },
      holePunchAppliedPlacements: activeModel.meshModifiers?.holePunches ?? [],
      holePunchesBakedIntoGeometry: activeModel.meshModifiers?.holePunchesBakedIntoGeometry === true,
      holePunchSourcePositionsBase64: activeModel.meshModifiers?.holePunchSourcePositionsBase64,
      holePunchSourcePositionCount: activeModel.meshModifiers?.holePunchSourcePositionCount,
    });
  }, [hollowingState, isShellOpenFaceSelected, deps.current.persistActiveModelModifiers, scene.activeModel]);

  const handleResetHollowingSettings = React.useCallback(() => {
    setHollowingState(defaultHollowingState);
    setIsShellOpenFaceSelected(true);
  }, [defaultHollowingState]);

  const handleHollowingStateChange = React.useCallback((next: HollowingPanelState) => {
    const openFaceChanged = next.openFace !== hollowingState.openFace;
    const resolutionChanged = Math.abs(next.voxelSizeMm - hollowingState.voxelSizeMm) > 1e-6;
    const thicknessChanged = Math.abs(next.shellThicknessMm - hollowingState.shellThicknessMm) > 1e-6;
    const blockedVoxelIndices = resolutionChanged
      ? []
      : blockedHollowVoxelIndices;
    const nextShellOpenFaceSelected = next.mode === 'shell_open_face'
      ? (
        hollowingState.mode !== 'shell_open_face'
          ? false
          : (openFaceChanged ? true : isShellOpenFaceSelected)
      )
      : true;

    // Warn before clearing blockers when adjusting resolution or thickness.
    if ((resolutionChanged || thicknessChanged) && blockedHollowVoxelIndices.length > 0) {
      deps.current.setPendingBlockerResetState(next);
      return;
    }

    setHollowingState(next);
    setIsShellOpenFaceSelected(nextShellOpenFaceSelected);
    setHollowingDraftEnabled(true);
    setBlockedHollowVoxelIndices(blockedVoxelIndices);
    // Clear editing indices when voxel resolution changes (new grid), but
    // preserve them when only shell thickness or mode changes so the user
    // stays in sphere edit mode with their current selection intact.
    if (!hollowingEditMode || resolutionChanged) {
      setEditingBlockedHollowVoxelIndices(blockedVoxelIndices);
    }

    if (!nextShellOpenFaceSelected) {
      deps.current.setSelectedHolePunchPlacementIds([]);
      deps.current.setHoveredHolePunchPlacementId(null);
      deps.current.setHolePunchHoverPlacement(null);
    }

    const activeModel = scene.activeModel;
    if (!activeModel) return;

    deps.current.persistActiveModelModifiers({
      ...(activeModel.meshModifiers ?? {}),
      hollowing: {
        enabled: true,
        bakedIntoGeometry: false,
        sourcePositionsBase64: activeModel.meshModifiers?.hollowing?.sourcePositionsBase64,
        sourcePositionCount: activeModel.meshModifiers?.hollowing?.sourcePositionCount,
        blockedVoxelIndices,
        mode: next.mode,
        voxelSizeMm: next.voxelSizeMm,
        shellThicknessMm: next.shellThicknessMm,
        infillMode: next.infillMode,
        infillCellMm: next.infillCellMm,
        infillBeamRadiusMm: next.infillBeamRadiusMm,
        openFace: next.openFace,
        openFaceSelected: nextShellOpenFaceSelected,
      },
    });
  }, [blockedHollowVoxelIndices, hollowingState.mode, hollowingState.openFace, hollowingState.voxelSizeMm, isShellOpenFaceSelected, deps.current.persistActiveModelModifiers, scene.activeModel]);

  const isHollowingApplied = React.useMemo(() => {
    const modifier = scene.activeModel?.meshModifiers?.hollowing;
    return Boolean(modifier?.enabled && modifier?.bakedIntoGeometry);
  }, [scene.activeModel]);

  const persistedHollowingSignature = React.useMemo(
    () => serializeHollowingModifier(scene.activeModel?.meshModifiers?.hollowing),
    [scene.activeModel],
  );

  const draftHollowingSignature = React.useMemo(
    () => serializeHollowingModifier({
      enabled: hollowingDraftEnabled,
      blockedVoxelIndices: blockedHollowVoxelIndices,
      mode: hollowingState.mode,
      voxelSizeMm: hollowingState.voxelSizeMm,
      shellThicknessMm: hollowingState.shellThicknessMm,
      infillMode: hollowingState.infillMode,
      infillCellMm: hollowingState.infillCellMm,
      infillBeamRadiusMm: hollowingState.infillBeamRadiusMm,
      openFace: hollowingState.openFace,
      openFaceSelected: hollowingState.mode === 'shell_open_face'
        ? isShellOpenFaceSelected
        : true,
    }),
    [
      hollowingDraftEnabled,
      blockedHollowVoxelIndices,
      hollowingState.mode,
      hollowingState.openFace,
      hollowingState.infillMode,
      hollowingState.shellThicknessMm,
      hollowingState.infillBeamRadiusMm,
      hollowingState.infillCellMm,
      hollowingState.voxelSizeMm,
      isShellOpenFaceSelected,
    ],
  );

  const isShellFaceSelectionPending = hollowingState.mode === 'shell_open_face' && !isShellOpenFaceSelected;

  const isHollowingDirty = draftHollowingSignature !== persistedHollowingSignature;

  const canResetHollowing = React.useMemo(() => {
    const activeModel = scene.activeModel;
    if (!activeModel) return false;
    const modifier = activeModel.meshModifiers?.hollowing;
    if (!modifier) return false;
    return Boolean(modifier.enabled || isHollowingDirty || isHollowingApplied);
  }, [isHollowingApplied, isHollowingDirty, scene.activeModel]);

  const blockedHollowVoxelIndexSet = React.useMemo(
    () => new Set(blockedHollowVoxelIndices),
    [blockedHollowVoxelIndices],
  );

  const editingBlockedHollowVoxelIndexSet = React.useMemo(
    () => new Set(editingBlockedHollowVoxelIndices),
    [editingBlockedHollowVoxelIndices],
  );

  React.useEffect(() => {
    editingBlockedHollowVoxelIndicesRef.current = editingBlockedHollowVoxelIndices;
  }, [editingBlockedHollowVoxelIndices]);

  React.useEffect(() => {
    hollowingEditModeRef.current = hollowingEditMode;
  }, [hollowingEditMode]);

  React.useEffect(() => {
    if (hollowingEditMode) return;
    hollowVoxelEditUndoStackRef.current = [];
    hollowVoxelEditRedoStackRef.current = [];
  }, [hollowingEditMode]);

  const applyEditingBlockedHollowVoxelIndices = React.useCallback((
    nextIndicesInput: Iterable<number>,
    options?: { recordHistory?: boolean },
  ) => {
    const nextIndices = [...new Set(nextIndicesInput)]
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    const previousIndices = editingBlockedHollowVoxelIndicesRef.current;
    if (areSortedNumberArraysEqual(previousIndices, nextIndices)) {
      return false;
    }

    if (options?.recordHistory ?? true) {
      hollowVoxelEditUndoStackRef.current.push([...previousIndices]);
      if (hollowVoxelEditUndoStackRef.current.length > 100) {
        hollowVoxelEditUndoStackRef.current.shift();
      }
      hollowVoxelEditRedoStackRef.current = [];
    }

    editingBlockedHollowVoxelIndicesRef.current = nextIndices;
    setEditingBlockedHollowVoxelIndices(nextIndices);
    return true;
  }, []);

  const undoHollowVoxelEdit = React.useCallback(() => {
    const previousIndices = hollowVoxelEditUndoStackRef.current.pop();
    if (!previousIndices) return false;

    hollowVoxelEditRedoStackRef.current.push([...editingBlockedHollowVoxelIndicesRef.current]);
    editingBlockedHollowVoxelIndicesRef.current = previousIndices;
    setEditingBlockedHollowVoxelIndices(previousIndices);
    return true;
  }, []);

  const redoHollowVoxelEdit = React.useCallback(() => {
    const nextIndices = hollowVoxelEditRedoStackRef.current.pop();
    if (!nextIndices) return false;

    hollowVoxelEditUndoStackRef.current.push([...editingBlockedHollowVoxelIndicesRef.current]);
    editingBlockedHollowVoxelIndicesRef.current = nextIndices;
    setEditingBlockedHollowVoxelIndices(nextIndices);
    return true;
  }, []);

  React.useEffect(() => {
    if (scene.mode !== 'prepare' || transformMgr.transformMode !== 'hollowing' || !hollowingEditMode) {
      return;
    }

    let wasZPressed = false;
    let wasYPressed = false;

    const unsubscribe = hotkeyStore.subscribe((state) => {
      const active = state.activeKeys;
      const isCtrlOrMeta = active.has('ctrl') || active.has('meta') || active.has('control');
      const isZPressed = active.has('z') && isCtrlOrMeta;
      const isYPressed = active.has('y') && isCtrlOrMeta;

      const isZJustPressed = isZPressed && !wasZPressed;
      const isYJustPressed = isYPressed && !wasYPressed;

      if (isZJustPressed) {
        if (active.has('shift')) {
          redoHollowVoxelEdit();
        } else {
          undoHollowVoxelEdit();
        }
      } else if (isYJustPressed) {
        redoHollowVoxelEdit();
      }

      wasZPressed = isZPressed;
      wasYPressed = isYPressed;
    });

    return unsubscribe;
  }, [hollowingEditMode, redoHollowVoxelEdit, scene.mode, transformMgr.transformMode, undoHollowVoxelEdit]);

  const blockedPreviewVoxelInstanceIdSet = React.useMemo(() => {
    const preview = hollowPreview;
    if (!preview) return new Set<number>();
    const activeBlockedIndexSet = hollowingEditMode
      ? editingBlockedHollowVoxelIndexSet
      : blockedHollowVoxelIndexSet;

    const next = new Set<number>();
    for (let instanceIndex = 0; instanceIndex < preview.removedVoxelIndices.length; instanceIndex += 1) {
      if (activeBlockedIndexSet.has(preview.removedVoxelIndices[instanceIndex] ?? -1)) {
        next.add(instanceIndex);
      }
    }
    // Also map committed blocked voxel centers: their instance index is
    // offset past the removed voxels. If the user cleared a blocked voxel
    // from the editing set, it won't be in activeBlockedIndexSet and will
    // render as yellow.
    if (preview.blockedVoxelCenters) {
      const blockedCount = Math.floor(preview.blockedVoxelCenters.length / 3);
      for (let blockedIndex = 0; blockedIndex < blockedCount; blockedIndex += 1) {
        const gridIndex = preview.blockedVoxelIndices
          ? preview.blockedVoxelIndices[blockedIndex]
          : blockedHollowVoxelIndices[blockedIndex];
        if (activeBlockedIndexSet.has(gridIndex)) {
          next.add(preview.removedVoxelIndices.length + blockedIndex);
        }
      }
    }
    return next;
  }, [blockedHollowVoxelIndexSet, blockedHollowVoxelIndices, editingBlockedHollowVoxelIndexSet, hollowPreview, hollowingEditMode]);

  const commitBlockedHollowVoxelIndices = React.useCallback((nextIndices: number[]) => {
    const activeModel = scene.activeModel;
    if (!activeModel) return;

    setBlockedHollowVoxelIndices(nextIndices);
    setHollowingDraftEnabled(true);
    deps.current.persistActiveModelModifiers({
      ...(activeModel.meshModifiers ?? {}),
      hollowing: {
        enabled: true,
        bakedIntoGeometry: false,
        sourcePositionsBase64: activeModel.meshModifiers?.hollowing?.sourcePositionsBase64,
        sourcePositionCount: activeModel.meshModifiers?.hollowing?.sourcePositionCount,
        blockedVoxelIndices: nextIndices,
        blockedVoxelRotationQuat: nextIndices.length > 0
          ? getRotationQuatTuple(activeModel.transform.rotation)
          : undefined,
        mode: hollowingState.mode,
        voxelSizeMm: hollowingState.voxelSizeMm,
        shellThicknessMm: hollowingState.shellThicknessMm,
        infillMode: hollowingState.infillMode,
        infillCellMm: hollowingState.infillCellMm,
        infillBeamRadiusMm: hollowingState.infillBeamRadiusMm,
        openFace: hollowingState.openFace,
        openFaceSelected: hollowingState.mode === 'shell_open_face'
          ? isShellOpenFaceSelected
          : true,
      },
    });
  }, [hollowingState, isShellOpenFaceSelected, deps.current.persistActiveModelModifiers, scene.activeModel]);

  const toggleBlockedHollowVoxelIndex = React.useCallback((voxelIndex: number) => {
    const currentPreview = hollowPreview;
    if (!currentPreview || voxelIndex < 0) return;

    let gridVoxelIndex: number;

    const removedCount = currentPreview.removedVoxelIndices.length;
    if (voxelIndex < removedCount) {
      // Instance in the removed voxel array — look up grid index directly.
      gridVoxelIndex = currentPreview.removedVoxelIndices[voxelIndex];
    } else {
      // Instance in the appended blocked-only array — look up via the echoed
      // accepted indices (in lockstep with the blocked centers), falling back
      // to the committed set when the echo is unavailable.
      const blockedOffset = voxelIndex - removedCount;
      gridVoxelIndex = currentPreview.blockedVoxelIndices
        ? currentPreview.blockedVoxelIndices[blockedOffset]
        : blockedHollowVoxelIndices[blockedOffset];
    }

    if (!Number.isFinite(gridVoxelIndex)) return;

    const next = new Set(editingBlockedHollowVoxelIndexSet);
    if (next.has(gridVoxelIndex)) {
      next.delete(gridVoxelIndex);
    } else {
      next.add(gridVoxelIndex);
    }
    applyEditingBlockedHollowVoxelIndices(next);
  }, [applyEditingBlockedHollowVoxelIndices, blockedHollowVoxelIndices, editingBlockedHollowVoxelIndexSet, hollowPreview]);

  const requestResetHollowing = React.useCallback(() => {
    if (!canResetHollowing || isApplyingHollowing || isPreviewingHollowing) return;
    deps.current.setPendingModifierResetAction('hollowing');
  }, [canResetHollowing, isApplyingHollowing, isPreviewingHollowing]);

  const requestClearAppliedHollowing = React.useCallback(() => {
    deps.current.setPendingModifierResetAction('clear_hollowing');
  }, []);

  const clearPendingHollowPreviewDebounce = React.useCallback(() => {
    if (hollowPreviewDebounceTimerRef.current !== null) {
      clearTimeout(hollowPreviewDebounceTimerRef.current);
      hollowPreviewDebounceTimerRef.current = null;
    }
  }, []);

  const resolveHollowPreviewSourceGeometry = React.useCallback((activeModel: (typeof scene.models)[number]) => {
    const sourceEntry = hollowingSourceByModelIdRef.current.get(activeModel.id);
    if (sourceEntry) {
      return sourceEntry.geometry;
    }

    // Only restore from the hollowing snapshot if hollowing is actually baked
    // (or at least enabled). If hollowing was reset/cleared, the snapshot is a
    // stale copy of the pre-hollowing geometry which may have holes that have
    // since been removed — using it would make the preview ignore hole changes.
    const h = activeModel.meshModifiers?.hollowing;
    const snapshotIsValid = h?.sourcePositionsBase64 && (h.bakedIntoGeometry || h.enabled);
    const restoredFromSnapshot = snapshotIsValid
      ? geometryFromSnapshot(h)
      : null;
    if (restoredFromSnapshot) {
      hollowingSourceByModelIdRef.current.set(activeModel.id, { geometry: restoredFromSnapshot });
      return restoredFromSnapshot;
    }

    return activeModel.geometry.geometry;
  }, []);

  const buildHollowingOptions = React.useCallback((
    modelScale: THREE.Vector3,
    maxExtent: number,
    tuning?: { preview?: boolean; previewShellThicknessMm?: number },
    stateOverride?: HollowingPanelState,
  ): HollowOptions => {
    const preview = Boolean(tuning?.preview);
    const state = stateOverride ?? hollowingState;
    const effectiveHollowMode = state.mode === 'shell_open_face'
      ? 'cavity'
      : state.mode;
    const voxelResolution = computeVoxelResolution(
      worldMmToLocalMm(state.voxelSizeMm, getUniformScaleFactorForThickness(modelScale)),
      maxExtent,
    );
    const shellThicknessMmWorld = preview
      ? (tuning?.previewShellThicknessMm ?? state.shellThicknessMm)
      : state.shellThicknessMm;
    const hasCommittedBlockedVoxels = blockedHollowVoxelIndices.length > 0;

    return {
      mode: effectiveHollowMode,
      voxelResolution,
      shellThicknessMm: worldMmToLocalMm(
        shellThicknessMmWorld,
        getUniformScaleFactorForThickness(modelScale),
      ),
      blockedVoxelIndices: blockedHollowVoxelIndices,
      infillMode: state.infillMode,
      infillCellMm: worldMmToLocalMm(
        state.infillCellMm,
        getUniformScaleFactorForThickness(modelScale),
      ),
      infillBeamRadiusMm: worldMmToLocalMm(
        state.infillBeamRadiusMm,
        getUniformScaleFactorForThickness(modelScale),
      ),
      openFace: state.openFace,
      drainHoles: [],
      previewCavityOnly: false,
      smoothInternalSurfaces: !preview || hasCommittedBlockedVoxels,
      internalChamferPasses: !preview || hasCommittedBlockedVoxels ? 2 : 0,
    };
  }, [
    hollowingState.mode,
    hollowingState.openFace,
    hollowingState.infillMode,
    hollowingState.infillBeamRadiusMm,
    hollowingState.infillCellMm,
    hollowingState.shellThicknessMm,
    hollowingState.voxelSizeMm,
    blockedHollowVoxelIndices,
  ]);

  const buildHollowPreviewRequest = React.useCallback((
    activeModel: (typeof scene.models)[number],
    overrideState?: HollowingPanelState,
  ) => {
    const previewState = overrideState ?? hollowingState;
    const previewShellThicknessMm = quantizePreviewShellThicknessMm(previewState.shellThicknessMm);
    const sourceGeometry = resolveHollowPreviewSourceGeometry(activeModel);
    const sourceGeometryKey = buildGeometryVersionKey(sourceGeometry);
    const bbox = sourceGeometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
      sourceGeometry.getAttribute('position') as THREE.BufferAttribute,
    );
    const bboxSize = bbox.getSize(new THREE.Vector3());
    const maxExtent = Math.max(bboxSize.x, bboxSize.y, bboxSize.z);
    const previewQuat = new THREE.Quaternion().setFromEuler(activeModel.transform.rotation);
    const options: HollowOptions = {
      ...buildHollowingOptions(activeModel.transform.scale, maxExtent, {
        preview: true,
        previewShellThicknessMm,
      }, previewState),
      drainHoles: [],
      previewCavityOnly: true,
      previewVoxelSpheres: true,
      rotationQuat: [previewQuat.x, previewQuat.y, previewQuat.z, previewQuat.w],
    };
    const optionsKey = JSON.stringify(options);
    const previewKey = `${activeModel.id}::${sourceGeometryKey}::${optionsKey}`;

    return {
      sourceGeometry,
      sourceGeometryKey,
      options,
      previewKey,
    };
  }, [
    buildHollowingOptions,
    hollowingState.shellThicknessMm,
    hollowingState.voxelSizeMm,
    resolveHollowPreviewSourceGeometry,
  ]);

  const cacheHollowPreviewResult = React.useCallback((
    activeModelId: string,
    report: HollowReport,
    positions: Float32Array,
    infillPositions: Float32Array | undefined,
    removedVoxelCenters: Float32Array | undefined,
    removedVoxelIndices: Uint32Array | undefined,
    blockedVoxelCenters: Float32Array | undefined,
    blockedVoxelIndices: Uint32Array | undefined,
    requestedBlockedVoxelIndices: number[],
    previewKey: string,
  ) => {
    const cachedPositions = new Float32Array(positions.length);
    cachedPositions.set(positions);
    const cachedRemovedVoxelCenters = removedVoxelCenters
      ? new Float32Array(removedVoxelCenters)
      : undefined;
    const cachedRemovedVoxelIndices = removedVoxelIndices
      ? new Uint32Array(removedVoxelIndices)
      : undefined;
    const cachedBlockedVoxelCenters = blockedVoxelCenters
      ? new Float32Array(blockedVoxelCenters)
      : undefined;
    const cachedBlockedVoxelIndices = blockedVoxelIndices
      ? new Uint32Array(blockedVoxelIndices)
      : undefined;

    hollowPreviewResultCacheRef.current.set(previewKey, {
      modelId: activeModelId,
      report,
      positions: cachedPositions,
      infillPositions,
      removedVoxelCenters: cachedRemovedVoxelCenters,
      removedVoxelIndices: cachedRemovedVoxelIndices,
      blockedVoxelCenters: cachedBlockedVoxelCenters,
      blockedVoxelIndices: cachedBlockedVoxelIndices,
      requestedBlockedVoxelIndices: [...requestedBlockedVoxelIndices],
      previewGeometry: null,
      infillGeometry: null,
    });

    if (hollowPreviewResultCacheRef.current.size > 6) {
      const oldest = hollowPreviewResultCacheRef.current.keys().next().value;
      if (oldest != null) {
        const evicted = hollowPreviewResultCacheRef.current.get(oldest);
        if (evicted) {
          disposeHollowPreviewCacheEntry(evicted);
        }
        hollowPreviewResultCacheRef.current.delete(oldest);
      }
    }

    return cachedPositions;
  }, []);

  const materializeHollowPreviewCacheEntry = React.useCallback((previewKey: string) => {
    const cached = hollowPreviewResultCacheRef.current.get(previewKey);
    if (!cached) return null;

    if (!cached.previewGeometry) {
      cached.previewGeometry = createGeometryFromPreviewPositions(cached.positions);
    }

    if (cached.infillPositions && !cached.infillGeometry) {
      cached.infillGeometry = createGeometryFromPreviewPositions(cached.infillPositions);
    }

    return cached;
  }, []);

  const primeHollowPreviewCache = React.useCallback(async (
    activeModel: (typeof scene.models)[number],
    overrideState?: HollowingPanelState,
  ) => {
    const { sourceGeometry, sourceGeometryKey, options, previewKey } = buildHollowPreviewRequest(activeModel, overrideState);

    if (hollowPreviewResultCacheRef.current.has(previewKey) || hollowPreviewWarmupKeyRef.current === previewKey) {
      return;
    }

    hollowPreviewWarmupKeyRef.current = previewKey;
    try {
      const staged = await stageHollowPreviewSource(
        sourceGeometry,
        `${activeModel.id}::${sourceGeometryKey}`,
      );
      if (!staged) {
        return;
      }

      const result = await hollowPreviewFromCapturedSource(options);
      if (!result) {
        return;
      }

      cacheHollowPreviewResult(
        activeModel.id,
        result.report,
        result.positions,
        result.infillPositions,
        result.removedVoxelCenters,
        result.removedVoxelIndices,
        result.blockedVoxelCenters,
        result.blockedVoxelIndices,
        options.blockedVoxelIndices ?? [],
        previewKey,
      );

      const scheduleMaterialize = typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function'
        ? (cb: () => void) => window.requestIdleCallback(() => cb())
        : (cb: () => void) => window.setTimeout(cb, 0);
      scheduleMaterialize(() => {
        try {
          materializeHollowPreviewCacheEntry(previewKey);
        } catch (error) {
          console.warn('[Hollowing] Failed to materialize cached preview geometry:', error);
        }
      });
    } catch (error) {
      console.warn('[Hollowing] Warm preview prime failed:', error);
    } finally {
      if (hollowPreviewWarmupKeyRef.current === previewKey) {
        hollowPreviewWarmupKeyRef.current = null;
      }
    }
  }, [buildHollowPreviewRequest, cacheHollowPreviewResult, materializeHollowPreviewCacheEntry]);

  const runHollowPreview = React.useCallback(async ({
    activeModel,
    sourceGeometry,
    sourceGeometryKey,
    options,
    previewKey,
    notifyUnavailable,
  }: {
    activeModel: (typeof scene.models)[number];
    sourceGeometry: THREE.BufferGeometry;
    sourceGeometryKey: string;
    options: HollowOptions;
    previewKey: string;
    notifyUnavailable: boolean;
  }) => {
    const requestSeq = ++hollowPreviewRequestSeqRef.current;
    setIsPreviewingHollowing(true);

    try {
      const cached = hollowPreviewResultCacheRef.current.get(previewKey);
      if (cached) {
        hollowPreviewResultCacheRef.current.delete(previewKey);
        hollowPreviewResultCacheRef.current.set(previewKey, cached);
        const materialized = materializeHollowPreviewCacheEntry(previewKey) ?? cached;
        const previewGeometry = materialized.previewGeometry ?? createGeometryFromPreviewPositions(materialized.positions);
        const infillGeometry = materialized.infillGeometry
          ?? (materialized.infillPositions ? createGeometryFromPreviewPositions(materialized.infillPositions) : null);
        if (hollowPreviewRequestSeqRef.current !== requestSeq) {
          disposeHollowPreviewGeometryIfUncached(previewGeometry, hollowPreviewResultCacheRef.current.values());
          disposeHollowPreviewGeometryIfUncached(infillGeometry, hollowPreviewResultCacheRef.current.values());
          return;
        }

        setHollowPreview((previous) => {
          if (previous) {
            disposeHollowPreviewGeometryIfUncached(previous.geometry, hollowPreviewResultCacheRef.current.values());
            disposeHollowPreviewGeometryIfUncached(previous.infillGeometry ?? null, hollowPreviewResultCacheRef.current.values());
          }
          return {
            modelId: cached.modelId,
            geometry: previewGeometry,
            infillGeometry,
            removedVoxelCenters: cached.removedVoxelCenters ?? new Float32Array(0),
            removedVoxelIndices: cached.removedVoxelIndices ?? new Uint32Array(0),
            blockedVoxelCenters: cached.blockedVoxelCenters,
            blockedVoxelIndices: cached.blockedVoxelIndices,
            requestedBlockedVoxelIndices: cached.requestedBlockedVoxelIndices,
            report: cached.report,
            previewKey,
            previewVoxelSpheres: true,
          };
        });
        return;
      }

      const staged = await stageHollowPreviewSource(
        sourceGeometry,
        `${activeModel.id}::${sourceGeometryKey}`,
      );
      if (!staged) {
        if (notifyUnavailable) {
          deps.current.showOperationError('Hollowing preview is available in DragonFruit Desktop only.');
        }
        return;
      }

      const result = await hollowPreviewFromCapturedSource(options);
      if (!result) {
        if (notifyUnavailable) {
          deps.current.showOperationError('Hollowing preview is available in DragonFruit Desktop only.');
        }
        return;
      }

      const cachedPositions = cacheHollowPreviewResult(
        activeModel.id,
        result.report,
        result.positions,
        result.infillPositions,
        result.removedVoxelCenters,
        result.removedVoxelIndices,
        result.blockedVoxelCenters,
        result.blockedVoxelIndices,
        options.blockedVoxelIndices ?? [],
        previewKey,
      );
      const materialized = materializeHollowPreviewCacheEntry(previewKey);

      const previewGeometry = materialized?.previewGeometry
        ?? createGeometryFromPreviewPositions(cachedPositions);
      const infillGeometry = materialized?.infillGeometry
        ?? (result.infillPositions
          ? createGeometryFromPreviewPositions(result.infillPositions)
          : null);

      if (hollowPreviewRequestSeqRef.current !== requestSeq) {
        disposeHollowPreviewGeometryIfUncached(previewGeometry, hollowPreviewResultCacheRef.current.values());
        disposeHollowPreviewGeometryIfUncached(infillGeometry, hollowPreviewResultCacheRef.current.values());
        return;
      }

      setHollowPreview((previous) => {
        if (previous) {
          disposeHollowPreviewGeometryIfUncached(previous.geometry, hollowPreviewResultCacheRef.current.values());
          disposeHollowPreviewGeometryIfUncached(previous.infillGeometry ?? null, hollowPreviewResultCacheRef.current.values());
        }
        return {
          modelId: activeModel.id,
          geometry: previewGeometry,
          infillGeometry,
          removedVoxelCenters: result.removedVoxelCenters ?? new Float32Array(0),
          removedVoxelIndices: result.removedVoxelIndices ?? new Uint32Array(0),
          blockedVoxelCenters: result.blockedVoxelCenters,
          blockedVoxelIndices: result.blockedVoxelIndices,
          requestedBlockedVoxelIndices: options.blockedVoxelIndices ?? [],
          report: result.report,
          previewKey,
          previewVoxelSpheres: true,
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (notifyUnavailable) {
        deps.current.showOperationError(`Hollowing preview failed: ${message}`);
      } else {
        console.warn('[Hollowing] Debounced preview failed:', message);
      }
    } finally {
      if (hollowPreviewRequestSeqRef.current === requestSeq) {
        setIsPreviewingHollowing(false);
        setIsApplyingBlockersHollowing(false);
      }
    }
  }, [cacheHollowPreviewResult, scene.models]);

  const clearHollowPreview = React.useCallback(() => {
    hollowPreviewRequestSeqRef.current += 1;
    setIsPreviewingHollowing(false);
    clearPendingHollowPreviewDebounce();
    setHollowPreview((previous) => {
      if (previous) {
        disposeHollowPreviewGeometryIfUncached(previous.geometry, hollowPreviewResultCacheRef.current.values());
        disposeHollowPreviewGeometryIfUncached(previous.infillGeometry ?? null, hollowPreviewResultCacheRef.current.values());
      }
      return null;
    });
  }, [clearPendingHollowPreviewDebounce]);

  React.useEffect(() => {
    return () => {
      if (hollowPreview) {
        disposeHollowPreviewGeometryIfUncached(
          hollowPreview.geometry,
          hollowPreviewResultCacheRef.current.values(),
        );
        disposeHollowPreviewGeometryIfUncached(
          hollowPreview.infillGeometry ?? null,
          hollowPreviewResultCacheRef.current.values(),
        );
      }
    };
  }, [hollowPreview]);

  React.useEffect(() => {
    return () => {
      clearPendingHollowPreviewDebounce();
    };
  }, [clearPendingHollowPreviewDebounce]);

  React.useEffect(() => {
    const liveIds = new Set(scene.models.map((model) => model.id));
    for (const [modelId, entry] of hollowingSourceByModelIdRef.current.entries()) {
      if (liveIds.has(modelId)) continue;
      entry.geometry.dispose();
      hollowingSourceByModelIdRef.current.delete(modelId);
    }

    for (const [modelId, entry] of cavityGeometryByModelIdRef.current.entries()) {
      if (liveIds.has(modelId)) continue;
      entry.geometry.dispose();
      cavityGeometryByModelIdRef.current.delete(modelId);
    }

    // If the active model's cavity geometry was just removed, exit interior view
    // so the user doesn't get stuck with no way to toggle it off.
    if (
      deps.current.interiorView &&
      (!scene.activeModel || !cavityGeometryByModelIdRef.current.has(scene.activeModel.id))
    ) {
      deps.current.setInteriorView(false);
    }

    for (const [cacheKey, entry] of hollowPreviewResultCacheRef.current.entries()) {
      if (liveIds.has(entry.modelId)) continue;
      disposeHollowPreviewCacheEntry(entry);
      hollowPreviewResultCacheRef.current.delete(cacheKey);
    }
  }, [scene.models, deps.current.interiorView, deps.current.setInteriorView]);

  // Restore cavity geometry from persisted data for models with baked hollowing.
  React.useEffect(() => {
    for (const model of scene.models) {
      const hollowing = scene.getModelMeshModifiers(model.id)?.hollowing;
      if (!hollowing?.enabled || !hollowing.cavityPositionsBase64 || !hollowing.cavityPositionCount) {
        continue;
      }
      if (cavityGeometryByModelIdRef.current.has(model.id)) {
        continue; // already restored
      }

      const bytes = base64ToBytes(hollowing.cavityPositionsBase64);
      if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) continue;
      const view = new Float32Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );
      if (view.length !== hollowing.cavityPositionCount * 3) continue;

      const positions = new Float32Array(view.length);
      positions.set(view);
      const cavityGeometry = new THREE.BufferGeometry();
      cavityGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      cavityGeometry.computeVertexNormals();
      cavityGeometry.computeBoundingBox();
      cavityGeometry.computeBoundingSphere();
      cavityGeometryByModelIdRef.current.set(model.id, { geometry: cavityGeometry });
    }
  }, [scene.models]);

  // Rust echoes back which committed blockers it actually accepted (stale
  // indices that fell off the grid or landed on non-solid voxels are
  // dropped, preserving order). If the echo differs from the committed set,
  // adopt it so the persisted modifier stays in lockstep with the preview.
  React.useEffect(() => {
    const preview = hollowPreview;
    const echoed = preview?.blockedVoxelIndices;
    const requested = preview?.requestedBlockedVoxelIndices;
    if (!preview || !echoed || !requested) return;
    // Only resync when this preview was computed FROM the current committed
    // set — otherwise a newer request is already in flight and comparing
    // against it would clobber fresh state.
    if (requested.length !== blockedHollowVoxelIndices.length
      || requested.some((value, i) => value !== blockedHollowVoxelIndices[i])) {
      return;
    }
    // The accepted list is an order-preserving subsequence of the request:
    // equal length means identical content.
    if (echoed.length === blockedHollowVoxelIndices.length) return;
    commitBlockedHollowVoxelIndices(Array.from(echoed));
  }, [blockedHollowVoxelIndices, commitBlockedHollowVoxelIndices, hollowPreview]);

  // Committed blockers index the rotation-aligned voxel grid. If the model is
  // rotated after they were painted, the same linear indices land on entirely
  // different voxels (or off the grid), so Rust would either silently ignore
  // them or pin the wrong voxels (hollowing.rs keep-application). Clear them
  // instead, mirroring the resolution-change invalidation in
  // handleHollowingStateChange and the legacy-format clear above.
  // NOTE: models in React state carry meshModifiers: undefined by design —
  // modifiers must be read through the externalized store (getModelMeshModifiers),
  // matching the cavity-restore effect above.
  React.useEffect(() => {
    for (const model of scene.models) {
      const modifiers = scene.getModelMeshModifiers(model.id);
      const hollowing = modifiers?.hollowing;
      if (!hollowing?.enabled || hollowing.bakedIntoGeometry) continue;
      if (!hollowing.blockedVoxelIndices?.length) continue;
      const currentQuat = getRotationQuatTuple(model.transform.rotation);
      const validity = resolveBlockedVoxelValidity(hollowing, currentQuat);
      if (validity === 'valid') continue;

      if (validity === 'stamp-legacy') {
        // Blockers persisted before the rotation stamp existed: adopt the
        // current rotation instead of destroying the user's selection on
        // first launch after this change.
        scene.setModelMeshModifiers(model.id, {
          ...(modifiers ?? {}),
          hollowing: { ...hollowing, blockedVoxelRotationQuat: currentQuat },
        });
        continue;
      }

      console.warn(
        '[Hollowing] Cleared blocked voxels: model rotation changed since they were painted.',
      );
      scene.setModelMeshModifiers(model.id, {
        ...(modifiers ?? {}),
        hollowing: {
          ...hollowing,
          blockedVoxelIndices: [],
          blockedVoxelRotationQuat: undefined,
        },
      });
      if (model.id === scene.activeModelId) {
        setBlockedHollowVoxelIndices([]);
        setEditingBlockedHollowVoxelIndices([]);
      }
    }
  }, [scene.models, scene.getModelMeshModifiers, scene.setModelMeshModifiers, scene.activeModelId, setBlockedHollowVoxelIndices, setEditingBlockedHollowVoxelIndices]);

  React.useEffect(() => {
    return () => {
      for (const entry of hollowingSourceByModelIdRef.current.values()) {
        entry.geometry.dispose();
      }
      hollowingSourceByModelIdRef.current.clear();
      for (const entry of cavityGeometryByModelIdRef.current.values()) {
        entry.geometry.dispose();
      }
      cavityGeometryByModelIdRef.current.clear();
      for (const entry of hollowPreviewResultCacheRef.current.values()) {
        disposeHollowPreviewCacheEntry(entry);
      }
      hollowPreviewResultCacheRef.current.clear();
    };
  }, []);

  React.useEffect(() => {
    if (!hollowPreview) return;
    if (scene.mode !== 'prepare' || transformMgr.transformMode !== 'hollowing') {
      clearHollowPreview();
      return;
    }
    const stillExists = scene.models.some((model) => model.id === hollowPreview.modelId);
    if (!stillExists) {
      clearHollowPreview();
    }
  }, [clearHollowPreview, hollowPreview, scene.mode, scene.models, transformMgr.transformMode]);

  React.useEffect(() => {
    if (scene.mode === 'prepare' && transformMgr.transformMode === 'hollowing') {
      return;
    }
    setHollowingEditMode(false);
    setEditingBlockedHollowVoxelIndices(blockedHollowVoxelIndices);
  }, [blockedHollowVoxelIndices, scene.mode, transformMgr.transformMode]);

  const resolveBlockedHollowVoxelMarqueeSelection = React.useCallback(async (
    polygon: Array<{ x: number; y: number }>,
    helpers: {
      projectWorldPoint: (point: THREE.Vector3) => { x: number; y: number; z: number } | null;
      getCameraProjection?: () => { viewProj: number[]; rectWidth: number; rectHeight: number } | null;
    },
  ): Promise<string[]> => {
    const preview = hollowPreview;
    const activeModel = scene.activeModel;
    if (!preview || !activeModel || polygon.length < 3) return [] as string[];

    const pointInPolygon = (x: number, y: number) => {
      let inside = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
        const xi = polygon[i].x;
        const yi = polygon[i].y;
        const xj = polygon[j].x;
        const yj = polygon[j].y;
        const intersects = ((yi > y) !== (yj > y))
          && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-6) + xi);
        if (intersects) inside = !inside;
      }
      return inside;
    };

    const modelQuaternion = new THREE.Quaternion().setFromEuler(activeModel.transform.rotation);
    const selected: string[] = [];

    // Removed/cavity voxels are resolved in Rust against the full grid, so the
    // whole through-depth column under the lasso is selected — not just the
    // boundary-filtered / cap-limited shell that `preview.removedVoxelCenters`
    // now holds after the 90a15d3d rendering filter. Rust reproduces this
    // exact projection (unrotated center -> model transform -> viewProj ->
    // container pixels -> point-in-polygon); see meshHollowing.ts / hollowing.rs.
    const cameraProjection = helpers.getCameraProjection?.();
    if (cameraProjection) {
      const { options } = buildHollowPreviewRequest(activeModel);
      try {
        const removedIndices = await selectRemovedVoxelsInPolygon({
          polygon: polygon.map((point) => [point.x, point.y] as [number, number]),
          viewProj: cameraProjection.viewProj,
          rectWidth: cameraProjection.rectWidth,
          rectHeight: cameraProjection.rectHeight,
          geometryCenter: [
            activeModel.geometry.center.x,
            activeModel.geometry.center.y,
            activeModel.geometry.center.z,
          ],
          scale: [
            activeModel.transform.scale.x,
            activeModel.transform.scale.y,
            activeModel.transform.scale.z,
          ],
          rotationQuat: [
            modelQuaternion.x,
            modelQuaternion.y,
            modelQuaternion.z,
            modelQuaternion.w,
          ],
          position: [
            activeModel.transform.position.x,
            activeModel.transform.position.y,
            activeModel.transform.position.z,
          ],
          options,
        });
        if (removedIndices) {
          for (let i = 0; i < removedIndices.length; i += 1) {
            selected.push(String(removedIndices[i]));
          }
        }
      } catch {
        // Backend selection unavailable/failed: fall through with the blocked
        // set only rather than throwing out of the lasso release handler.
      }
    }

    // Already-blocked voxels stay client-side: that center set is
    // user-selection-bounded (never boundary-filtered), and Alt+lasso needs it
    // to un-block. This loop is unchanged from the pre-regression resolver.
    if (preview.blockedVoxelCenters) {
      const blockedCount = Math.floor(preview.blockedVoxelCenters.length / 3);
      for (let blockedIndex = 0; blockedIndex < blockedCount; blockedIndex += 1) {
        const offset = blockedIndex * 3;
        const localPoint = new THREE.Vector3(
          preview.blockedVoxelCenters[offset] - activeModel.geometry.center.x,
          preview.blockedVoxelCenters[offset + 1] - activeModel.geometry.center.y,
          preview.blockedVoxelCenters[offset + 2] - activeModel.geometry.center.z,
        );
        localPoint.multiply(activeModel.transform.scale);
        localPoint.applyQuaternion(modelQuaternion);
        localPoint.add(activeModel.transform.position);
        const projected = helpers.projectWorldPoint(localPoint);
        if (!projected) continue;
        if (!pointInPolygon(projected.x, projected.y)) continue;
        selected.push(String(preview.blockedVoxelIndices
          ? preview.blockedVoxelIndices[blockedIndex]
          : blockedHollowVoxelIndices[blockedIndex]));
      }
    }

    return selected;
  }, [hollowPreview, scene.activeModel, blockedHollowVoxelIndices, buildHollowPreviewRequest]);

  const handleBlockedHollowVoxelMarqueeSelection = React.useCallback((ids: string[], altKey?: boolean) => {
    if (ids.length === 0) return;
    const next = new Set(editingBlockedHollowVoxelIndicesRef.current);
    if (altKey) {
      // Alt + lasso: un-block (remove from the blocked set).
      for (const id of ids) {
        const voxelIndex = Number(id);
        if (!Number.isFinite(voxelIndex)) continue;
        next.delete(voxelIndex);
      }
    } else {
      // Plain lasso: block (add to the blocked set).
      for (const id of ids) {
        const voxelIndex = Number(id);
        if (!Number.isFinite(voxelIndex)) continue;
        next.add(voxelIndex);
      }
    }
    applyEditingBlockedHollowVoxelIndices(next);
  }, [applyEditingBlockedHollowVoxelIndices]);

  const handleStartHollowVoxelEditing = React.useCallback(() => {
    editingBlockedHollowVoxelIndicesRef.current = blockedHollowVoxelIndices;
    hollowVoxelEditUndoStackRef.current = [];
    hollowVoxelEditRedoStackRef.current = [];
    setEditingBlockedHollowVoxelIndices(blockedHollowVoxelIndices);
    setHollowingEditMode(true);
  }, [blockedHollowVoxelIndices]);

  const handleClearHollowVoxelEditing = React.useCallback(() => {
    applyEditingBlockedHollowVoxelIndices([]);
  }, [applyEditingBlockedHollowVoxelIndices]);

  const handleDoneHollowVoxelEditing = React.useCallback(() => {
    const nextIndices = [...editingBlockedHollowVoxelIndices].sort((a, b) => a - b);
    const prevIndices = [...blockedHollowVoxelIndices].sort((a, b) => a - b);
    const hasChanges = nextIndices.length !== prevIndices.length
      || nextIndices.some((v, i) => v !== prevIndices[i]);

    if (!hasChanges) {
      setHollowingEditMode(false);
      return;
    }

    commitBlockedHollowVoxelIndices(nextIndices);
    clearHollowPreview();
    setHollowingEditMode(false);
    setIsApplyingBlockersHollowing(true);
  }, [blockedHollowVoxelIndices, clearHollowPreview, commitBlockedHollowVoxelIndices, editingBlockedHollowVoxelIndices]);

  React.useEffect(() => {
    if (scene.mode !== 'prepare' || transformMgr.transformMode === 'hollowing') {
      return;
    }

    const activeModel = scene.activeModel;
    if (!activeModel) {
      return;
    }

    const persistedHollowing = activeModel.meshModifiers?.hollowing;
    const warmupState: HollowingPanelState = persistedHollowing?.enabled
      ? {
          mode: persistedHollowing.mode === 'shell_open_face' ? 'cavity' : persistedHollowing.mode,
          voxelSizeMm: persistedHollowing.voxelSizeMm,
          shellThicknessMm: persistedHollowing.shellThicknessMm,
          infillMode: persistedHollowing.infillMode ?? defaultHollowingState.infillMode,
          infillCellMm: persistedHollowing.infillCellMm ?? defaultHollowingState.infillCellMm,
          infillBeamRadiusMm: persistedHollowing.infillBeamRadiusMm ?? defaultHollowingState.infillBeamRadiusMm,
          openFace: persistedHollowing.openFace,
        }
      : defaultHollowingState;

    const previewRequest = buildHollowPreviewRequest(activeModel, warmupState);
    if (hollowPreviewResultCacheRef.current.has(previewRequest.previewKey)
      || hollowPreviewWarmupKeyRef.current === previewRequest.previewKey) {
      return;
    }

    void primeHollowPreviewCache(activeModel, warmupState);
  }, [
    buildHollowPreviewRequest,
    defaultHollowingState,
    primeHollowPreviewCache,
    scene.activeModel,
    scene.mode,
    transformMgr.transformMode,
  ]);

  return {
    isPreviewingHollowing,
    setIsPreviewingHollowing,
    hollowPreview,
    setHollowPreview,
    hollowingState,
    setHollowingState,
    isShellOpenFaceSelected,
    setIsShellOpenFaceSelected,
    hollowingDraftEnabled,
    setHollowingDraftEnabled,
    hollowingEditMode,
    setHollowingEditMode,
    blockedHollowVoxelIndices,
    setBlockedHollowVoxelIndices,
    editingBlockedHollowVoxelIndices,
    setEditingBlockedHollowVoxelIndices,
    isApplyingBlockersHollowing,
    setIsApplyingBlockersHollowing,
    isApplyingHollowing,
    setIsApplyingHollowing,
    editingBlockedHollowVoxelIndicesRef,
    hollowVoxelEditUndoStackRef,
    hollowVoxelEditRedoStackRef,
    hollowingEditModeRef,
    hollowPreviewDebounceTimerRef,
    hollowPreviewRequestSeqRef,
    hollowPreviewResultCacheRef,
    hollowPreviewWarmupKeyRef,
    hollowingSourceByModelIdRef,
    cavityGeometryByModelIdRef,
    defaultHollowingState,
    isHollowingApplied,
    persistedHollowingSignature,
    draftHollowingSignature,
    isShellFaceSelectionPending,
    isHollowingDirty,
    canResetHollowing,
    blockedHollowVoxelIndexSet,
    editingBlockedHollowVoxelIndexSet,
    blockedPreviewVoxelInstanceIdSet,
    handleApplyHollowing,
    handleResetHollowing,
    handleClearAppliedHollowing,
    handleResetHollowingSettings,
    handleHollowingStateChange,
    applyEditingBlockedHollowVoxelIndices,
    undoHollowVoxelEdit,
    redoHollowVoxelEdit,
    commitBlockedHollowVoxelIndices,
    toggleBlockedHollowVoxelIndex,
    requestResetHollowing,
    requestClearAppliedHollowing,
    clearPendingHollowPreviewDebounce,
    resolveHollowPreviewSourceGeometry,
    buildHollowingOptions,
    buildHollowPreviewRequest,
    cacheHollowPreviewResult,
    materializeHollowPreviewCacheEntry,
    primeHollowPreviewCache,
    runHollowPreview,
    clearHollowPreview,
    resolveBlockedHollowVoxelMarqueeSelection,
    handleBlockedHollowVoxelMarqueeSelection,
    handleStartHollowVoxelEditing,
    handleClearHollowVoxelEditing,
    handleDoneHollowVoxelEditing,
  };
}

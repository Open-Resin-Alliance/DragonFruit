import React from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { SupportMode } from '@/supports/types';
import { SupportRenderer } from '@/supports/SupportRenderer';
import { SupportProxyMeshLayer, collectProxyPrimitives, createProxySupportTint } from '@/supports/SupportProxyMeshLayer';
import { RaftProxyMeshLayer } from '@/supports/RaftProxyMeshLayer';
import RaftRenderer from '@/supports/Rafts/Crenelated/rendering/RaftRenderer';
import LineRaftRenderer from '@/supports/Rafts/Crenelated/rendering/LineRaftRenderer';
import { getSettings, subscribeToSettings } from '@/supports/Settings/state';
import { getSnapshot as getSupportSnapshot, subscribe as subscribeSupportState } from '@/supports/state';
import { SUPPORT_COLLECTION_KEYS } from '@/supports/supportTypeRegistry';
import { emitSupportModelPointerHover } from '@/supports/interaction/clickHandlers';
import {
  createCavityTester,
  interiorSupportIds,
  isAnySegmentPointInterior,
  isInteriorContact,
} from '@/supports/interiorSupportGeometry';
import { buildMergedSupportGeometry } from '@/supports/prepare/mergedSupportGeometry';
import { PrepareSupportMesh } from '@/supports/prepare/PrepareSupportMesh';
import { usePicking } from '@/components/picking';
import { supportAnswersPointer } from '@/features/scene/plates/plateInteractivity';
import type { SupportPlacementPreviews } from '@/supports/rendering';
import type { PlateFootprintSource } from '@/supports/Rafts/Crenelated/geometry/modelPlateFootprint';
import { noteActivity } from '@/utils/debug/heartbeatContext';
import { disposeGeometryBVH } from '@/utils/bvh';
export type ModelAttachedSupportLayerProps = {
  mode?: SupportMode;
  modelFilterId?: string | null;
  excludeModelId?: string | null;
  excludeModelIds?: string[];
  hideRaftPrimitives?: boolean;
  hideRaftPrimitivesForInactiveModels?: boolean;
  hidePlateContactPrimitives?: boolean;
  /**
   * Drop the support primitives, keeping the rafts. The Prepare path that
   * parents a merged support mesh inside the model group sets this on the
   * attached layer: the group still carries the model's raft, and the merged
   * mesh draws the supports where this layer's proxy would have.
   */
  hideSupports?: boolean;
  clipLower?: number | null;
  clipUpper?: number | null;
  supportColorsByModelId?: Record<string, string>;
  hoverTintColor?: string;
  hoverTintStrength?: number;
  selectedTintStrength?: number;
  activeModelId?: string | null;
  selectedModelIds?: string[];
  marqueeCandidateModelIds?: readonly string[];
  hoverModelId?: string | null;
  modelDropOffsetsById?: Record<string, number>;
  navigationLodActive?: boolean;
  disableSelectionAndHover?: boolean;
  /**
   * Models standing on another bed. Their supports and raft are drawn dimmed and answer no
   * pointer — the same rule the model itself follows — while the model's own layer is
   * otherwise untouched (it is still drawn, and an active model is never scenery).
   */
  pointerSceneryModelIds?: ReadonlySet<string>;
  passive?: boolean;
  raftColorized?: boolean;
  raftHoverized?: boolean;
  onModelPointerSelect?: (modelId: string) => void;
  /** In Select mode, a pointer-down on a support/raft reports a potential model
   *  XY-drag start (model + screen coords). The scene owns the drag. */
  onModelPointerDragStart?: (modelId: string, clientX: number, clientY: number) => void;
  ghostOpacity?: number;
  ghostRenderOrder?: number;
  supportRendererRef?: React.Ref<THREE.Group>;
  supportRenderRefreshNonce?: number;
  supportProxyIncludeDetailedPrimitives?: boolean;
  showOutOfBoundsOverlay?: boolean;
  outOfBoundsMin?: THREE.Vector3 | null;
  outOfBoundsMax?: THREE.Vector3 | null;
  outOfBoundsStripeColor?: string;
  /** Live placement previews, keyed by type. Forwarded, never read here. */
  placementPreviews?: SupportPlacementPreviews;
  /** When true, only show supports whose contact points touch the cavity mesh. */
  interiorView?: boolean;
  /** Cavity mesh geometry keyed by modelId, used for interior support filtering. */
  cavityGeometryByModelId?: Map<string, THREE.BufferGeometry>;
  /**
   * World-to-local inverse matrices per modelId. Needed to transform support
   * contact positions (world space) into the cavity geometry's local space
   * for accurate BVH closest-point queries.
   */
  modelWorldInverseById?: Map<string, THREE.Matrix4>;
  /** Models whose plate footprint every raft has to clear. */
  plateClearanceTargets?: readonly PlateFootprintSource[];
};

export function ModelAttachedSupportLayer({
  mode,
  modelFilterId = null,
  excludeModelId = null,
  excludeModelIds = [],
  hideRaftPrimitives = false,
  hideRaftPrimitivesForInactiveModels = false,
  hidePlateContactPrimitives = false,
  hideSupports = false,
  clipLower,
  clipUpper,
  supportColorsByModelId,
  hoverTintColor,
  hoverTintStrength,
  selectedTintStrength,
  activeModelId = null,
  selectedModelIds = [],
  marqueeCandidateModelIds,
  hoverModelId = null,
  modelDropOffsetsById,
  navigationLodActive = false,
  disableSelectionAndHover = false,
  pointerSceneryModelIds,
  passive = false,
  raftColorized = true,
  raftHoverized = false,
  onModelPointerSelect,
  onModelPointerDragStart,
  ghostOpacity,
  ghostRenderOrder,
  supportRendererRef,
  supportRenderRefreshNonce = 0,
  supportProxyIncludeDetailedPrimitives = true,
  showOutOfBoundsOverlay,
  outOfBoundsMin,
  outOfBoundsMax,
  outOfBoundsStripeColor,
  placementPreviews,
  interiorView = false,
  cavityGeometryByModelId,
  modelWorldInverseById,
  plateClearanceTargets,
}: ModelAttachedSupportLayerProps) {
  noteActivity(mode === 'support' ? 'support-mode:layer' : 'prepare-mode:layer');
  // Performance policy: use proxy support/raft rendering everywhere except
  // support workspace, where full editable primitives are required.
  const useUltraLazySupports = mode !== 'support';
  /**
   * Support mode shows the supports of the model being worked on, and nothing
   * else. The world layer used to mount the detailed renderer for every model on
   * the plate — non-selected models' supports stayed visible and made the first
   * entry into the tab cold (thousands of per-primitive geometries and
   * materials). The world layer now draws the active model only; per-model
   * layers (ghost/preview) keep their own filter.
   */
  const supportWorldLayer = mode === 'support' && !modelFilterId;
  const detailModelId = mode === 'support' ? (supportWorldLayer ? activeModelId : modelFilterId) : null;
  const useProxy = useUltraLazySupports;
  const proxyPointerSelectionEnabled = mode === 'prepare' && !navigationLodActive && !disableSelectionAndHover && !passive;
  const proxyIncludeDetailedPrimitives = supportProxyIncludeDetailedPrimitives;
  // Both flags answer one question, and a preset switch rewrites the whole
  // settings object. The snapshot is the answer itself, so only a change to it
  // re-renders this layer and the raft and support meshes under it.
  const simpleRender = React.useSyncExternalStore(
    subscribeToSettings,
    () => {
      const settings = getSettings();
      return settings.debugSimpleSupportRender || settings.navigationDiscsOnly;
    },
    () => {
      const settings = getSettings();
      return settings.debugSimpleSupportRender || settings.navigationDiscsOnly;
    },
  );
  // The navigation view (the Studio's eye button) is a line view too, so the
  // raft goes with the shafts: it is the biggest solid thing on screen.
  const hideRaftPrimitivesEffective = hideRaftPrimitives || simpleRender;

  return (
    <>
      {!hideRaftPrimitivesEffective && !interiorView && useUltraLazySupports && (
        <RaftProxyMeshLayer
          modelFilterId={hideRaftPrimitivesForInactiveModels && activeModelId ? activeModelId : modelFilterId}
          clipLower={clipLower}
          clipUpper={clipUpper}
          activeModelId={activeModelId}
          selectedModelIds={selectedModelIds}
          marqueeCandidateModelIds={marqueeCandidateModelIds}
          hoverModelId={hoverModelId}
          excludeModelId={excludeModelId}
          excludeModelIds={excludeModelIds}
          ghostOpacity={ghostOpacity}
          ghostRenderOrder={ghostRenderOrder}
          onModelPointerSelect={onModelPointerSelect}
          onModelPointerDragStart={onModelPointerDragStart}
          enablePointerSelection={proxyPointerSelectionEnabled}
          colorized={raftColorized}
          hoverized={raftHoverized}
          navigationLodActive={navigationLodActive}
          passive={passive}
          pointerSceneryModelIds={pointerSceneryModelIds}
          plateClearanceTargets={plateClearanceTargets}
        />
      )}

      {!hideRaftPrimitivesEffective && !interiorView && !useUltraLazySupports && (
        <>
          <RaftRenderer
            clipLower={clipLower}
            clipUpper={clipUpper}
            colorized={raftColorized}
            hoverized={raftHoverized}
            ghostOpacity={ghostOpacity}
            ghostRenderOrder={ghostRenderOrder}
            activeModelId={activeModelId}
            selectedModelIds={selectedModelIds}
            hoverModelId={hoverModelId}
            modelFilterId={hideRaftPrimitivesForInactiveModels && activeModelId ? activeModelId : modelFilterId}
            excludeModelId={excludeModelId}
            excludeModelIds={excludeModelIds}
            navigationLodActive={navigationLodActive}
            onModelPointerSelect={onModelPointerSelect}
            pointerSceneryModelIds={pointerSceneryModelIds}
            plateClearanceTargets={plateClearanceTargets}
          />
          <LineRaftRenderer
            clipLower={clipLower}
            clipUpper={clipUpper}
            colorized={raftColorized}
            hoverized={raftHoverized}
            ghostOpacity={ghostOpacity}
            ghostRenderOrder={ghostRenderOrder}
            activeModelId={activeModelId}
            selectedModelIds={selectedModelIds}
            hoverModelId={hoverModelId}
            modelFilterId={hideRaftPrimitivesForInactiveModels && activeModelId ? activeModelId : modelFilterId}
            excludeModelId={excludeModelId}
            excludeModelIds={excludeModelIds}
            navigationLodActive={navigationLodActive}
            onModelPointerSelect={onModelPointerSelect}
            pointerSceneryModelIds={pointerSceneryModelIds}
            plateClearanceTargets={plateClearanceTargets}
          />
        </>
      )}

      <group ref={supportRendererRef ?? undefined}>
        {useProxy && !hideSupports ? (
          <SupportProxyMeshLayer
            mode={mode}
            clipLower={clipLower}
            clipUpper={clipUpper}
            supportColorsByModelId={supportColorsByModelId}
            activeModelId={activeModelId}
            selectedModelIds={selectedModelIds}
            marqueeCandidateModelIds={marqueeCandidateModelIds}
            hoverModelId={hoverModelId}
            hoverTintColor={hoverTintColor}
            hoverTintStrength={hoverTintStrength}
            modelFilterId={modelFilterId}
            excludeModelId={excludeModelId}
            excludeModelIds={excludeModelIds}
            modelDropOffsetsById={modelDropOffsetsById}
            ghostOpacity={ghostOpacity}
            showOutOfBoundsOverlay={showOutOfBoundsOverlay}
            outOfBoundsMin={outOfBoundsMin}
            outOfBoundsMax={outOfBoundsMax}
            outOfBoundsStripeColor={outOfBoundsStripeColor}
            onModelPointerSelect={onModelPointerSelect}
            onModelPointerDragStart={onModelPointerDragStart}
            enablePointerSelection={proxyPointerSelectionEnabled}
            pointerSceneryModelIds={pointerSceneryModelIds}
            includeDetailedPrimitives={proxyIncludeDetailedPrimitives}
            interiorView={interiorView}
            cavityGeometryByModelId={cavityGeometryByModelId}
            modelWorldInverseById={modelWorldInverseById}
          />
        ) : null}
        {detailModelId && (
          <SupportRenderer
            key={`support-detail-${supportRenderRefreshNonce}-${detailModelId}`}
            mode={mode}
            navigationLodActive={navigationLodActive}
            hidePlateContactPrimitives={hidePlateContactPrimitives}
            clipLower={clipLower}
            clipUpper={clipUpper}
            supportColorsByModelId={supportColorsByModelId}
            hoverTintColor={hoverTintColor}
            hoverTintStrength={hoverTintStrength}
            selectedTintStrength={selectedTintStrength}
            activeModelId={activeModelId}
            selectedModelIds={selectedModelIds}
            marqueeCandidateModelIds={marqueeCandidateModelIds}
            hoverModelId={hoverModelId}
            modelDropOffsetsById={modelDropOffsetsById}
            modelFilterId={detailModelId}
            excludeModelId={excludeModelId}
            excludeModelIds={excludeModelIds}
            disableSelectionAndHover={disableSelectionAndHover}
            pointerSceneryModelIds={pointerSceneryModelIds}
            ghostOpacity={ghostOpacity}
            ghostRenderOrder={ghostRenderOrder}
            passive={passive}
            placementPreviews={placementPreviews}
            interiorView={interiorView}
            cavityGeometryByModelId={cavityGeometryByModelId}
            modelWorldInverseById={modelWorldInverseById}
          />
        )}
      </group>
    </>
  );
}

// ── Merged Prepare support mesh ──────────────────────────────────────────
/**
 * The Prepare support tint, as the proxy draws it: untouched supports take the
 * base grey, a selected model the active orange, and hover and marquee blend
 * towards it. The proxy passes no disc colour, so every merged group takes the
 * same tint.
 *
 * These two literals are the proxy layer's private `DEFAULT_SUPPORT_COLOR` and
 * `ACTIVE_SUPPORT_COLOR`; the tint maths itself is shared
 * (`createProxySupportTint`), so only the two hex values are repeated here.
 */
const MERGED_SUPPORT_BASE_COLOR = '#9a9a9a';
const MERGED_SUPPORT_ACTIVE_COLOR = '#c8752a';
/** The order the proxy's support batches draw at. */
const MERGED_SUPPORT_RENDER_ORDER = 100000;
const EMPTY_MARQUEE_CANDIDATE_IDS: readonly string[] = Object.freeze([]);

/**
 * True when both lists name the same collection objects. `SUPPORT_COLLECTION_KEYS`
 * read off a snapshot produce a fresh array per snapshot, so element identity —
 * not array identity — is what says "the support data did not change".
 */
function sameSupportCollectionRefs(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export type ActiveMergedSupportMeshProps = {
  modelId: string;
  clipLower?: number | null;
  clipUpper?: number | null;
  selectedModelIds?: readonly string[];
  marqueeCandidateModelIds?: readonly string[];
  hoverModelId?: string | null;
  hoverTintStrength?: number;
  /** Models standing on another bed: their supports answer no pointer. */
  pointerSceneryModelIds?: ReadonlySet<string>;
  /** The attached layer's `proxyPointerSelectionEnabled`, forwarded. */
  enablePointerSelection?: boolean;
  includeDetailedPrimitives?: boolean;
  interiorView?: boolean;
  cavityGeometryByModelId?: Map<string, THREE.BufferGeometry>;
  modelWorldInverseById?: Map<string, THREE.Matrix4>;
  visible?: boolean;
  onModelPointerSelect?: (modelId: string) => void;
  onModelPointerDragStart?: (modelId: string, clientX: number, clientY: number) => void;
};

/**
 * One model's supports as a single merged mesh, for the Prepare path that
 * parents it inside the model group behind the inverse committed transform.
 *
 * The proxy draws the same primitives as instanced batches and re-uploads every
 * instance matrix when a model moves. Here the primitives are flattened once
 * (world space) and the model group carries them, so a model move is a parent
 * matrix update: the supports do no work while the model is dragged.
 *
 * Geometry is rebuilt only when the support **collections** or the proxy options
 * change, not on every store snapshot: hovering replaces the snapshot
 * (`setHoveredState`) and only changes the tint.
 */
export function ActiveMergedSupportMesh({
  modelId,
  clipLower,
  clipUpper,
  selectedModelIds = [],
  marqueeCandidateModelIds = EMPTY_MARQUEE_CANDIDATE_IDS,
  hoverModelId = null,
  hoverTintStrength = 0.35,
  pointerSceneryModelIds,
  enablePointerSelection = false,
  includeDetailedPrimitives = true,
  interiorView = false,
  cavityGeometryByModelId,
  modelWorldInverseById,
  visible = true,
  onModelPointerSelect,
  onModelPointerDragStart,
}: ActiveMergedSupportMeshProps) {
  const supportState = React.useSyncExternalStore(subscribeSupportState, getSupportSnapshot, getSupportSnapshot);
  // The walk reads the state, so the memo key is the collections (and the walk
  // options), exactly as in `SupportProxyMeshLayer`; this ref hands the memo the
  // snapshot that produced the current key.
  const supportStateRef = React.useRef(supportState);
  supportStateRef.current = supportState;

  // `usePicking` re-renders on pointer moves; the scene owns the hover category
  // and a gizmo under the pointer must not select or start a model drag.
  const { hit } = usePicking();
  const hitCategoryRef = React.useRef(hit.category);
  hitCategoryRef.current = hit.category;

  const supportCollectionRefs = React.useMemo(
    () => SUPPORT_COLLECTION_KEYS.map((key) => supportState[key]),
    [supportState],
  );

  // The snapshot array above is new on every hover; the collections behind it are
  // not. Handing the memos below a key that only changes with the collections is
  // what keeps a hover from re-walking and re-merging the plate.
  const stableCollectionKeyRef = React.useRef<readonly unknown[] | null>(null);
  const stableCollectionKey = React.useMemo(() => {
    const previous = stableCollectionKeyRef.current;
    if (previous && sameSupportCollectionRefs(previous, supportCollectionRefs)) return previous;
    stableCollectionKeyRef.current = supportCollectionRefs;
    return supportCollectionRefs;
  }, [supportCollectionRefs]);

  const clippingPlanes = React.useMemo(() => {
    const planes: THREE.Plane[] = [];
    if (clipLower != null) planes.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), -clipLower));
    if (clipUpper != null) planes.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), clipUpper));
    return planes.length > 0 ? planes : null;
  }, [clipLower, clipUpper]);

  // Interior view filters the walk to the supports whose contacts touch the
  // cavity; the set is the one the proxy would build for the same snapshot.
  const interiorSupportIdSet = React.useMemo<Set<string> | null>(() => {
    if (!interiorView || !cavityGeometryByModelId || cavityGeometryByModelId.size === 0) return null;
    const cavityTester = createCavityTester(cavityGeometryByModelId, modelWorldInverseById);
    return interiorSupportIds(
      supportStateRef.current,
      (contact, id) => isInteriorContact(contact, id, cavityTester.isOnInteriorSide),
      (segments, id) => isAnySegmentPointInterior(segments, cavityTester.isOnInteriorSide, id),
    );
  }, [cavityGeometryByModelId, interiorView, modelWorldInverseById, stableCollectionKey]);

  const merged = React.useMemo(() => {
    const modelGeometry = collectProxyPrimitives(supportStateRef.current, {
      includeDetailedPrimitives,
      interiorSupportIdSet,
    }).get(modelId);
    if (!modelGeometry) return null;
    const built = buildMergedSupportGeometry(modelGeometry);
    if (built.triangles === 0) {
      disposeGeometryBVH(built.geometry);
      built.geometry.dispose();
      return null;
    }
    // This mesh is a raycast target on every pointer move (hover, click, drag
    // start), exactly like the raft proxies: without a bounds tree the
    // accelerated raycast falls back to a per-triangle test —
    // `RaftProxyMeshLayer.withBoundsTree` measures ~50 ms a move at 20k
    // triangles, against ~0.12 ms with a tree.
    if (typeof built.geometry.computeBoundsTree === 'function') {
      built.geometry.computeBoundsTree();
    }
    return built;
  }, [includeDetailedPrimitives, interiorSupportIdSet, modelId, stableCollectionKey]);

  const mergedGeometry = merged?.geometry ?? null;

  // The replaced geometry is ours; the model's other renderables own theirs.
  React.useEffect(() => {
    if (!mergedGeometry) return;
    return () => {
      disposeGeometryBVH(mergedGeometry);
      mergedGeometry.dispose();
    };
  }, [mergedGeometry]);

  const selectedModelIdSet = React.useMemo(() => new Set(selectedModelIds), [selectedModelIds]);
  const tintColors = React.useMemo(() => ({
    base: new THREE.Color(MERGED_SUPPORT_BASE_COLOR),
    active: new THREE.Color(MERGED_SUPPORT_ACTIVE_COLOR),
  }), []);
  const hoverStrength = Math.max(0.05, Math.min(1, hoverTintStrength));
  const supportColorFor = React.useMemo(
    () => createProxySupportTint({
      selectedModelIds: selectedModelIdSet,
      sceneryModelIds: pointerSceneryModelIds,
      hoverModelId,
      marqueeCandidateModelIds,
      baseColor: tintColors.base,
      activeColor: tintColors.active,
      hoverStrength,
    }),
    [
      hoverModelId,
      hoverStrength,
      marqueeCandidateModelIds,
      pointerSceneryModelIds,
      selectedModelIdSet,
      tintColors,
    ],
  );
  const supportColor = React.useMemo(
    () => supportColorFor(modelId).getStyle(),
    [modelId, supportColorFor],
  );

  const pointerHoverEnabled = enablePointerSelection;
  const pointerSelectionEnabled = enablePointerSelection && !!onModelPointerSelect;
  const pointerDragStartEnabled = enablePointerSelection && !!onModelPointerDragStart;

  const lastSupportHoverModelIdRef = React.useRef<string | null>(null);
  const hoverClearRafRef = React.useRef<number | null>(null);

  const setSupportHoverModel = React.useCallback((nextModelId: string | null) => {
    if (hoverClearRafRef.current !== null) {
      cancelAnimationFrame(hoverClearRafRef.current);
      hoverClearRafRef.current = null;
    }
    if (lastSupportHoverModelIdRef.current === nextModelId) return;
    lastSupportHoverModelIdRef.current = nextModelId;
    emitSupportModelPointerHover(nextModelId);
  }, []);

  const scheduleSupportHoverClear = React.useCallback(() => {
    if (hoverClearRafRef.current !== null) return;
    hoverClearRafRef.current = requestAnimationFrame(() => {
      hoverClearRafRef.current = null;
      if (lastSupportHoverModelIdRef.current === null) return;
      lastSupportHoverModelIdRef.current = null;
      emitSupportModelPointerHover(null);
    });
  }, []);

  React.useEffect(() => {
    return () => {
      if (hoverClearRafRef.current !== null) {
        cancelAnimationFrame(hoverClearRafRef.current);
        hoverClearRafRef.current = null;
      }
      if (lastSupportHoverModelIdRef.current !== null) {
        lastSupportHoverModelIdRef.current = null;
        emitSupportModelPointerHover(null);
      }
    };
  }, []);

  React.useEffect(() => {
    if (pointerHoverEnabled) return;
    if (hoverClearRafRef.current !== null) {
      cancelAnimationFrame(hoverClearRafRef.current);
      hoverClearRafRef.current = null;
    }
    if (lastSupportHoverModelIdRef.current !== null) {
      lastSupportHoverModelIdRef.current = null;
      emitSupportModelPointerHover(null);
    }
  }, [pointerHoverEnabled]);

  const handlePointerOver = React.useCallback((event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    if (!supportAnswersPointer(modelId, pointerSceneryModelIds)) return;
    setSupportHoverModel(modelId);
  }, [modelId, pointerSceneryModelIds, setSupportHoverModel]);

  const handlePointerOut = React.useCallback((event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    scheduleSupportHoverClear();
  }, [scheduleSupportHoverClear]);

  const handleClick = React.useCallback((event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    if (hitCategoryRef.current === 'gizmo') return;
    if (!supportAnswersPointer(modelId, pointerSceneryModelIds)) return;
    onModelPointerSelect?.(modelId);
  }, [modelId, onModelPointerSelect, pointerSceneryModelIds]);

  const handlePointerDown = React.useCallback((event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    if (!onModelPointerDragStart) return;
    if (hitCategoryRef.current === 'gizmo') return;
    if (!supportAnswersPointer(modelId, pointerSceneryModelIds)) return;
    const native = event.nativeEvent as PointerEvent | undefined;
    if (native?.ctrlKey || native?.metaKey || native?.shiftKey) return;
    if (event.button !== 0) return;
    onModelPointerDragStart(modelId, event.clientX, event.clientY);
  }, [modelId, onModelPointerDragStart, pointerSceneryModelIds]);

  if (!mergedGeometry) return null;

  return (
    <group userData={{ dfPerfGroup: 'supports' }}>
      <PrepareSupportMesh
        geometry={mergedGeometry}
        bodyColor={supportColor}
        diskColor={supportColor}
        visible={visible}
        clippingPlanes={clippingPlanes}
        renderOrder={MERGED_SUPPORT_RENDER_ORDER}
        onClick={pointerSelectionEnabled ? handleClick : undefined}
        onPointerOver={pointerHoverEnabled ? handlePointerOver : undefined}
        onPointerOut={pointerHoverEnabled ? handlePointerOut : undefined}
        onPointerDown={pointerDragStartEnabled ? handlePointerDown : undefined}
      />
    </group>
  );
}

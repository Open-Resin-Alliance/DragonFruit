import React from 'react';
import * as THREE from 'three';
import type { SupportMode } from '@/supports/types';
import { SupportRenderer } from '@/supports/SupportRenderer';
import { SupportProxyMeshLayer } from '@/supports/SupportProxyMeshLayer';
import { perfLayerEnabled } from '@/utils/perfProbe';
import { RaftProxyMeshLayer } from '@/supports/RaftProxyMeshLayer';
import RaftRenderer from '@/supports/Rafts/Crenelated/rendering/RaftRenderer';
import LineRaftRenderer from '@/supports/Rafts/Crenelated/rendering/LineRaftRenderer';
import { getSettings, subscribeToSettings } from '@/supports/Settings/state';
import type { SupportPlacementPreviews } from '@/supports/rendering';
import type { PlateFootprintSource } from '@/supports/Rafts/Crenelated/geometry/modelPlateFootprint';
import { noteActivity } from '@/utils/debug/heartbeatContext';
export type ModelAttachedSupportLayerProps = {
  mode?: SupportMode;
  modelFilterId?: string | null;
  excludeModelId?: string | null;
  excludeModelIds?: string[];
  /**
   * Models whose *supports* another layer draws (the Prepare merged meshes),
   * while their rafts stay here.
   *
   * `excludeModelIds` hides the model from both the support proxy and the raft
   * layers; this one is the supports-only form, so a model can draw its raft in
   * the world layer and its supports from its own merged mesh at the same time.
   */
  supportExcludeModelIds?: readonly string[];
  hideRaftPrimitives?: boolean;
  hideRaftPrimitivesForInactiveModels?: boolean;
  hidePlateContactPrimitives?: boolean;
  /**
   * Drop the support primitives, keeping the rafts. The Prepare path that
   * parents a merged support mesh inside the model group sets this once that
   * model's merge is ready: the group still carries the model's raft, and the
   * merged mesh draws the supports where this layer's proxy would have.
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
  supportExcludeModelIds,
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

  // Supports-only exclusions on top of the layer-wide ones. Falls back to the
  // given array's identity so a layer without merged consumers keeps its memos.
  const supportExcludeModelIdList = React.useMemo(() => {
    if (!supportExcludeModelIds || supportExcludeModelIds.length === 0) return excludeModelIds;
    return Array.from(new Set([...excludeModelIds, ...supportExcludeModelIds]));
  }, [excludeModelIds, supportExcludeModelIds]);

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

      {!hideRaftPrimitivesEffective && !interiorView && !useUltraLazySupports && perfLayerEnabled('rafts') && (
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
        {useProxy && !hideSupports && perfLayerEnabled('proxy') ? (
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
            excludeModelIds={supportExcludeModelIdList}
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

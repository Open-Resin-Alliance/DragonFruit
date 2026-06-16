import React from 'react';
import * as THREE from 'three';
import type { SupportMode } from '@/supports/types';
import { SupportRenderer } from '@/supports/SupportRenderer';
import { SupportProxyMeshLayer } from '@/supports/SupportProxyMeshLayer';
import { RaftProxyMeshLayer } from '@/supports/RaftProxyMeshLayer';
import RaftRenderer from '@/supports/Rafts/Crenelated/rendering/RaftRenderer';
import LineRaftRenderer from '@/supports/Rafts/Crenelated/rendering/LineRaftRenderer';
import type { SupportData } from '@/supports/rendering';
import type { BracePreviewData } from '@/supports/SupportTypes/Brace/bracePlacementState';

export type ModelAttachedSupportLayerProps = {
  mode?: SupportMode;
  modelFilterId?: string | null;
  excludeModelId?: string | null;
  excludeModelIds?: string[];
  hideRaftPrimitives?: boolean;
  hideRaftPrimitivesForInactiveModels?: boolean;
  hidePlateContactPrimitives?: boolean;
  clipLower?: number | null;
  clipUpper?: number | null;
  supportColorsByModelId?: Record<string, string>;
  hoverTintColor?: string;
  hoverTintStrength?: number;
  selectedTintStrength?: number;
  activeModelId?: string | null;
  selectedModelIds?: string[];
  hoverModelId?: string | null;
  modelDropOffsetsById?: Record<string, number>;
  navigationLodActive?: boolean;
  disableSelectionAndHover?: boolean;
  passive?: boolean;
  raftColorized?: boolean;
  raftHoverized?: boolean;
  onModelPointerSelect?: (modelId: string) => void;
  ghostOpacity?: number;
  ghostRenderOrder?: number;
  supportRendererRef?: React.Ref<THREE.Group>;
  supportRenderRefreshNonce?: number;
  supportProxyIncludeDetailedPrimitives?: boolean;
  showOutOfBoundsOverlay?: boolean;
  outOfBoundsMin?: THREE.Vector3 | null;
  outOfBoundsMax?: THREE.Vector3 | null;
  outOfBoundsStripeColor?: string;
  trunkPlacementPreview?: SupportData | null;
  branchPlacementPreview?: SupportData | null;
  leafPlacementPreview?: SupportData | null;
  bracePlacementPreview?: BracePreviewData | null;
  kickstandPlacementPreview?: SupportData | null;
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
};

export function ModelAttachedSupportLayer({
  mode,
  modelFilterId = null,
  excludeModelId = null,
  excludeModelIds = [],
  hideRaftPrimitives = false,
  hideRaftPrimitivesForInactiveModels = false,
  hidePlateContactPrimitives = false,
  clipLower,
  clipUpper,
  supportColorsByModelId,
  hoverTintColor,
  hoverTintStrength,
  selectedTintStrength,
  activeModelId = null,
  selectedModelIds = [],
  hoverModelId = null,
  modelDropOffsetsById,
  navigationLodActive = false,
  disableSelectionAndHover = false,
  passive = false,
  raftColorized = true,
  raftHoverized = false,
  onModelPointerSelect,
  ghostOpacity,
  ghostRenderOrder,
  supportRendererRef,
  supportRenderRefreshNonce = 0,
  supportProxyIncludeDetailedPrimitives = true,
  showOutOfBoundsOverlay,
  outOfBoundsMin,
  outOfBoundsMax,
  outOfBoundsStripeColor,
  trunkPlacementPreview = null,
  branchPlacementPreview = null,
  leafPlacementPreview = null,
  bracePlacementPreview = null,
  kickstandPlacementPreview = null,
  interiorView = false,
  cavityGeometryByModelId,
  modelWorldInverseById,
}: ModelAttachedSupportLayerProps) {
  // Performance policy: use proxy support/raft rendering everywhere except
  // support workspace, where full editable primitives are required.
  const useUltraLazySupports = mode !== 'support';
  const proxyPointerSelectionEnabled = mode === 'prepare' && !navigationLodActive && !disableSelectionAndHover && !passive;
  const proxyIncludeDetailedPrimitives = supportProxyIncludeDetailedPrimitives;

  return (
    <>
      {!hideRaftPrimitives && !interiorView && useUltraLazySupports && (
        <RaftProxyMeshLayer
          modelFilterId={hideRaftPrimitivesForInactiveModels && activeModelId ? activeModelId : modelFilterId}
          clipLower={clipLower}
          clipUpper={clipUpper}
          activeModelId={activeModelId}
          selectedModelIds={selectedModelIds}
          hoverModelId={hoverModelId}
          excludeModelId={excludeModelId}
          excludeModelIds={excludeModelIds}
          ghostOpacity={ghostOpacity}
          ghostRenderOrder={ghostRenderOrder}
          onModelPointerSelect={onModelPointerSelect}
          enablePointerSelection={proxyPointerSelectionEnabled}
          colorized={raftColorized}
          hoverized={raftHoverized}
          navigationLodActive={navigationLodActive}
          passive={passive}
        />
      )}

      {!hideRaftPrimitives && !interiorView && !useUltraLazySupports && (
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
          />
        </>
      )}

      <group ref={supportRendererRef ?? undefined}>
        {useUltraLazySupports ? (
          <SupportProxyMeshLayer
            mode={mode}
            clipLower={clipLower}
            clipUpper={clipUpper}
            supportColorsByModelId={supportColorsByModelId}
            activeModelId={activeModelId}
            selectedModelIds={selectedModelIds}
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
            enablePointerSelection={proxyPointerSelectionEnabled}
            includeDetailedPrimitives={proxyIncludeDetailedPrimitives}
            interiorView={interiorView}
            cavityGeometryByModelId={cavityGeometryByModelId}
            modelWorldInverseById={modelWorldInverseById}
          />
        ) : (
          <SupportRenderer
            key={`support-renderer-${supportRenderRefreshNonce}`}
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
            hoverModelId={hoverModelId}
            modelDropOffsetsById={modelDropOffsetsById}
            modelFilterId={modelFilterId}
            excludeModelId={excludeModelId}
            excludeModelIds={excludeModelIds}
            disableSelectionAndHover={disableSelectionAndHover}
            ghostOpacity={ghostOpacity}
            ghostRenderOrder={ghostRenderOrder}
            passive={passive}
            trunkPlacementPreview={trunkPlacementPreview}
            branchPlacementPreview={branchPlacementPreview}
            leafPlacementPreview={leafPlacementPreview}
            bracePlacementPreview={bracePlacementPreview}
            kickstandPlacementPreview={kickstandPlacementPreview}
            interiorView={interiorView}
            cavityGeometryByModelId={cavityGeometryByModelId}
            modelWorldInverseById={modelWorldInverseById}
          />
        )}
      </group>
    </>
  );
}

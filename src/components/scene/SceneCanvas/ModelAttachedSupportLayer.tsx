import React from 'react';
import * as THREE from 'three';
import type { SupportMode } from '@/supports/types';
import { SupportRenderer } from '@/supports/SupportRenderer';
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
  trunkPlacementPreview?: SupportData | null;
  branchPlacementPreview?: SupportData | null;
  leafPlacementPreview?: SupportData | null;
  bracePlacementPreview?: BracePreviewData | null;
  kickstandPlacementPreview?: SupportData | null;
};

export function ModelAttachedSupportLayer({
  mode,
  modelFilterId = null,
  excludeModelId = null,
  excludeModelIds = [],
  hideRaftPrimitives = false,
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
  trunkPlacementPreview = null,
  branchPlacementPreview = null,
  leafPlacementPreview = null,
  bracePlacementPreview = null,
  kickstandPlacementPreview = null,
}: ModelAttachedSupportLayerProps) {
  return (
    <>
      {!hideRaftPrimitives && (
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
            modelFilterId={modelFilterId}
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
            modelFilterId={modelFilterId}
            excludeModelId={excludeModelId}
            excludeModelIds={excludeModelIds}
            navigationLodActive={navigationLodActive}
            onModelPointerSelect={onModelPointerSelect}
          />
        </>
      )}

      <SupportRenderer
        key={`support-renderer-${supportRenderRefreshNonce}`}
        ref={supportRendererRef}
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
      />
    </>
  );
}

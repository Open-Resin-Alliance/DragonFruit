import React from 'react';
import * as THREE from 'three';

import { createProxySupportTint } from '@/supports/SupportProxyMeshLayer';
import type { PrepareMergedSupportEntry } from './mergedSupportCache';
import { PrepareSupportMesh } from './PrepareSupportMesh';

/**
 * One model's cached merged supports, mounted inside that model's group.
 *
 * The entry's geometry is baked into the model's local frame, so it is mounted
 * directly under the model group. A live drag moves the group and the supports
 * with it without touching a vertex; no inverse matrix is needed.
 *
 * The mesh answers no pointer: in Prepare the *model* is the interaction unit,
 * so the model mesh owns selection, hover and drag, and this mesh must stay out
 * of every raycast.
 */

/**
 * The proxy's private `DEFAULT_SUPPORT_COLOR` and `ACTIVE_SUPPORT_COLOR`.
 *
 * The tint maths is shared (`createProxySupportTint`); only the two hex values
 * are repeated, because the proxy layer does not export them.
 */
const MERGED_SUPPORT_BASE_COLOR = '#9a9a9a';
const MERGED_SUPPORT_ACTIVE_COLOR = '#c8752a';
/** The order the proxy's support batches draw at, so the sort is unchanged. */
const MERGED_SUPPORT_RENDER_ORDER = 100000;
const EMPTY_MARQUEE_CANDIDATE_IDS: readonly string[] = Object.freeze([]);

/** Picking is the model mesh's job here; the merged geometry never raycasts. */
const NO_RAYCAST = () => null;

export type PrepareMergedSupportMeshProps = {
  entry: PrepareMergedSupportEntry | null;
  clipLower?: number | null;
  clipUpper?: number | null;
  selectedModelIds?: readonly string[];
  marqueeCandidateModelIds?: readonly string[];
  hoverModelId?: string | null;
  hoverTintStrength?: number;
  /** Models standing on another bed: dimmed, and never tinted by hover. */
  pointerSceneryModelIds?: ReadonlySet<string>;
  /** Ghost previews draw the same geometry at a fraction of the opacity. */
  opacity?: number;
  transparent?: boolean;
  visible?: boolean;
  renderOrder?: number;
};

export function PrepareMergedSupportMesh({
  entry,
  clipLower = null,
  clipUpper = null,
  selectedModelIds = [],
  marqueeCandidateModelIds = EMPTY_MARQUEE_CANDIDATE_IDS,
  hoverModelId = null,
  hoverTintStrength = 0.35,
  pointerSceneryModelIds,
  opacity = 1,
  transparent = false,
  visible = true,
  renderOrder = MERGED_SUPPORT_RENDER_ORDER,
}: PrepareMergedSupportMeshProps) {
  const selectedModelIdSet = React.useMemo(() => new Set(selectedModelIds), [selectedModelIds]);
  const hoverStrength = Math.max(0.05, Math.min(1, hoverTintStrength));

  const supportColorFor = React.useMemo(
    () => createProxySupportTint({
      selectedModelIds: selectedModelIdSet,
      sceneryModelIds: pointerSceneryModelIds,
      hoverModelId,
      marqueeCandidateModelIds,
      baseColor: new THREE.Color(MERGED_SUPPORT_BASE_COLOR),
      activeColor: new THREE.Color(MERGED_SUPPORT_ACTIVE_COLOR),
      hoverStrength,
    }),
    [
      hoverModelId,
      hoverStrength,
      marqueeCandidateModelIds,
      pointerSceneryModelIds,
      selectedModelIdSet,
    ],
  );

  // The proxy passes no disc colour, so every group takes the model's tint.
  const modelId = entry?.modelId ?? null;
  const supportColor = React.useMemo(
    () => (modelId ? supportColorFor(modelId).getStyle() : MERGED_SUPPORT_BASE_COLOR),
    [modelId, supportColorFor],
  );

  const clippingPlanes = React.useMemo(() => {
    const planes: THREE.Plane[] = [];
    if (clipLower != null) planes.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), -clipLower));
    if (clipUpper != null) planes.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), clipUpper));
    return planes.length > 0 ? planes : null;
  }, [clipLower, clipUpper]);

  if (!entry) return null;

  return (
    <group
      renderOrder={renderOrder}
      userData={{ dfPerfGroup: 'supports' }}
    >
      <PrepareSupportMesh
        geometry={entry.geometry}
        bodyColor={supportColor}
        diskColor={supportColor}
        opacity={opacity}
        transparent={transparent}
        clippingPlanes={clippingPlanes}
        visible={visible}
        renderOrder={renderOrder}
        raycast={NO_RAYCAST}
      />
    </group>
  );
}

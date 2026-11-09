import React from 'react';

import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import type { ModelTransform } from '@/hooks/useModelTransform';
import FootprintBorderRenderer from '@/supports/Rafts/Crenelated/rendering/FootprintBorderRenderer';

import { FollowModelMove } from './FollowModelMove';
import { useOptimisticSelectedModelId } from './optimisticModelSelection';

export type FootprintOutlineTarget = {
  id: string;
  geometry: GeometryWithBounds;
  transform: ModelTransform;
};

type FootprintOutlineGroupProps = {
  /** The committed selection's targets, in draw order. */
  targets: readonly FootprintOutlineTarget[];
  /** Resolve one model id to its current outline target, or null if it is not drawable. */
  resolveTarget: (id: string) => FootprintOutlineTarget | null;
  /** Live drag transforms, so the outline follows a gizmo move. */
  liveTransformsRef: React.RefObject<Map<string, ModelTransform>>;
  color: string;
};

/**
 * The footprint outlines, including the model a click just selected.
 *
 * `targets` arrives with the committed selection, which is a render behind the
 * click. This subscribes to the optimistic selection itself, so the outline
 * mounts in the same frame as the model tint instead of waiting for the page
 * render; while that id is pending it replaces the committed list, so the
 * previous model's outline clears at the same time.
 */
export function FootprintOutlineGroup({
  targets,
  resolveTarget,
  liveTransformsRef,
  color,
}: FootprintOutlineGroupProps) {
  const optimisticId = useOptimisticSelectedModelId();
  const optimisticTarget = optimisticId ? resolveTarget(optimisticId) : null;
  const entries = optimisticTarget ? [optimisticTarget] : targets;

  return (
    <>
      {entries.map((entry) => (
        <FollowModelMove
          key={`footprint-border-${entry.id}`}
          modelId={entry.id}
          baseTransform={entry.transform}
          liveTransformsRef={liveTransformsRef}
        >
          <FootprintBorderRenderer
            modelGeometry={entry.geometry}
            modelTransform={entry.transform}
            modelId={entry.id}
            color={color}
          />
        </FollowModelMove>
      ))}
    </>
  );
}

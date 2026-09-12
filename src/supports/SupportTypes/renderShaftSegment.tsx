import React from 'react';

import { BezierRenderer } from '../Renderers/BezierRenderer';
import { ShaftRenderer } from '../SupportPrimitives/Shaft/ShaftRenderer';
import type { InstancedShaft } from '../SupportPrimitives/Shaft/InstancedShaftGroup';
import type { ShaftSegment } from './useShaftSegments';

/**
 * Draws one shaft segment, or adds it to the instanced batch.
 *
 * A straight segment on an unselected support is instanced; a bezier, a
 * selected support, or a taper whose ends differ has to be drawn on its own.
 * Every shafted renderer made the same choice with the same three branches.
 */

export interface ShaftSegmentVisuals {
    color: string;
    emissive: string;
    emissiveIntensity: number;
    selectedColor: string;
}

export interface RenderShaftSegmentOptions {
    shaft: ShaftSegment;
    visuals: ShaftSegmentVisuals;
    isSelected: boolean;
    isSegmentSelected: boolean;
    isInteractable: boolean;
    deferStraightShaftsToSceneBatch: boolean;
    onSelect: (segmentId: string) => void;
    /** Collects instanced segments; a drawn segment returns a node instead. */
    batch: InstancedShaft[];
}

/** The colour a bezier takes while its support is selected. */
const BEZIER_SELECTED_COLOR = '#ff00ff';

export function renderShaftSegment({
    shaft,
    visuals,
    isSelected,
    isSegmentSelected,
    isInteractable,
    deferStraightShaftsToSceneBatch,
    onSelect,
    batch,
}: RenderShaftSegmentOptions): React.ReactNode | null {
    const { segment, start, end, diameterStart, diameterEnd, isUniformDiameter } = shaft;
    const isBezier = segment.type === 'bezier';

    if (!isSelected && !deferStraightShaftsToSceneBatch && !isBezier && isUniformDiameter) {
        batch.push({ id: segment.id, start, end, diameter: segment.diameter });
        return null;
    }

    // `key` stays out of this object: React requires it passed directly, not
    // through a spread.
    const key = `shaft-${segment.id}`;
    const shared = {
        id: segment.id,
        start,
        end,
        diameter: segment.diameter,
        emissive: visuals.emissive,
        emissiveIntensity: visuals.emissiveIntensity,
        selectedColor: visuals.selectedColor,
        isParentSelected: isSelected,
        isInteractable,
        isSelected: isSegmentSelected,
        onClick: () => onSelect(segment.id),
    };

    if (isBezier) {
        return (
            <BezierRenderer
                key={key}
                {...shared}
                control1={segment.controlPoint1}
                control2={segment.controlPoint2}
                resolution={segment.resolution}
                color={isSelected ? BEZIER_SELECTED_COLOR : visuals.color}
            />
        );
    }

    if (deferStraightShaftsToSceneBatch && !isSelected) return null;

    return (
        <ShaftRenderer
            key={key}
            {...shared}
            color={visuals.color}
            diameterStart={diameterStart}
            diameterEnd={diameterEnd}
        />
    );
}

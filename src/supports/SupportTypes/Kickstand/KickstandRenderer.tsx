import { renderShaftSegment } from '../renderShaftSegment';
import { useShaftSegments } from '../useShaftSegments';
import React from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Knot, Roots } from '../../types';
import { selectPrimitiveById } from '../../interaction/shared/selection/selectionController';
import { useHighlight } from '../../interaction/useHighlight';
import { handleSupportClick } from '../../interaction/clickHandlers';
import { JointRenderer } from '../../SupportPrimitives/Joint/JointRenderer';
import { KnotRenderer } from '../../SupportPrimitives/Knot/KnotRenderer';
import { RootsRenderer } from '../../SupportPrimitives/Roots/RootsRenderer';
import { InstancedShaftGroup, type InstancedShaft } from '../../SupportPrimitives/Shaft/InstancedShaftGroup';
import { usePartDragUpdate } from '../../interaction/partDragPreview';
import type { Kickstand } from './types';

interface KickstandRendererProps {
    kickstand: Kickstand;
    root: Roots;
    hostKnot: Knot;
    isSelected?: boolean;
    selectedId?: string | null;
    dimNonSelected?: boolean;
    showKnot?: boolean;
    suppressHover?: boolean;
    isHovered?: boolean;
    isInteractable?: boolean;
    deferStraightShaftsToSceneBatch?: boolean;
    deferInteractionToSceneBatch?: boolean;
    hidePlateContactPrimitives?: boolean;
    baseColor?: string;
    hoverColor?: string;
    selectedColor?: string;
}

export const KickstandRenderer = React.memo(function KickstandRenderer({
    kickstand: baseKickstand,
    root,
    hostKnot,
    isSelected,
    selectedId,
    dimNonSelected,
    showKnot = true,
    suppressHover,
    isHovered: propHovered,
    isInteractable = true,
    deferStraightShaftsToSceneBatch = false,
    deferInteractionToSceneBatch = false,
    hidePlateContactPrimitives = false,
    baseColor = '#ff8800',
    hoverColor,
    selectedColor = '#80fffd',
}: KickstandRendererProps) {
    // The entity names its own type; the store stamps it on every write.
    const typeId = baseKickstand.typeId ?? 'kickstand';
    const previewKickstand = usePartDragUpdate<Kickstand>(typeId, baseKickstand.id);
    const kickstand = previewKickstand ?? baseKickstand;

    const highDetailPrimitiveSegments = 24;
    const lowDetailPrimitiveSegments = 8;
    const useLowDetailPrimitives = !isSelected && !propHovered;

    const { pickRef, visuals } = useHighlight({
        id: kickstand.id,
        category: 'support',
        enabled: !!isInteractable && !suppressHover && !deferInteractionToSceneBatch && !isSelected,
        isSelected,
        suppressHover,
        externalHover: propHovered,
        baseColor: dimNonSelected && !isSelected ? '#666666' : baseColor,
        selectedColor,
        hoverColor,
    });

    const handleClick = (e: ThreeEvent<MouseEvent>) => {
        handleSupportClick(e, kickstand.id, !!isInteractable);
    };

    const shafts: React.ReactNode[] = [];
    const batchedStraightShafts: InstancedShaft[] = [];
    const joints: React.ReactNode[] = [];

    const shaftSegments = useShaftSegments(typeId, kickstand, { root, hostKnot });

    shaftSegments.forEach((shaft) => {
        const segment = shaft.segment;
        const index = shaft.index;
        const segmentSelected = selectedId === segment.id;

        const node = renderShaftSegment({
          shaft,
          visuals,
          isSelected: !!isSelected,
          isSegmentSelected: segmentSelected,
          isInteractable,
          deferStraightShaftsToSceneBatch,
          onSelect: selectPrimitiveById,
          batch: batchedStraightShafts,
        });
        if (node) shafts.push(node);

        if (isSelected && segment.topJoint) {
            joints.push(
                <JointRenderer
                    key={`joint-${segment.topJoint.id}`}
                    joint={segment.topJoint}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    selectedColor={visuals.selectedColor}
                    isInteractable={isInteractable}
                    isParentSelected={isSelected}
                />,
            );
        }

        if (isSelected && index === 0 && segment.bottomJoint) {
            joints.push(
                <JointRenderer
                    key={`joint-${segment.bottomJoint.id}`}
                    joint={segment.bottomJoint}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    selectedColor={visuals.selectedColor}
                    isInteractable={isInteractable}
                    isParentSelected={isSelected}
                />,
            );
        }

    });

    const shaftDiameter = kickstand.segments[0]?.diameter ?? kickstand.profile.bodyDiameterMm;

    return (
        <group
            onClick={handleClick}
        >
            {!hidePlateContactPrimitives && (
                <RootsRenderer
                    root={root}
                    shaftDiameter={shaftDiameter}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    radialSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
                    sphereSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
                />
            )}

            <group ref={pickRef as React.RefObject<THREE.Group | null>}>
                <InstancedShaftGroup
                    shafts={batchedStraightShafts}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                />
                {shafts}
            </group>

            {showKnot && isSelected && (
                <KnotRenderer
                    knot={hostKnot}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    selectedColor={visuals.selectedColor}
                    isInteractable={isInteractable}
                    isParentSelected={isSelected}
                />
            )}

            {joints}
        </group>
    );
});

KickstandRenderer.displayName = 'KickstandRenderer';

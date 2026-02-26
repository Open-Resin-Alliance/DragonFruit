import React from 'react';
import { Leaf, Knot } from '../../types';
import { ContactConeRenderer } from '../../SupportPrimitives/ContactCone';
import { handleSupportClick, emitSupportModelPointerHover } from '../../interaction/clickHandlers';
import { useHighlight } from '../../interaction/useHighlight';
import { KnotRenderer } from '../../SupportPrimitives/Knot/KnotRenderer';

interface LeafRendererProps {
    leaf: Leaf;
    parentKnot: Knot;
    isSelected?: boolean;
    dimNonSelected?: boolean;
    showKnots?: boolean;
    isHovered?: boolean;
    suppressHover?: boolean;
    isInteractable?: boolean;
    deferContactConesToSceneBatch?: boolean;
    baseColor?: string;
    hoverColor?: string;
    selectedColor?: string;
}

export const LeafRenderer = React.memo(function LeafRenderer({
    leaf,
    parentKnot,
    isSelected,
    dimNonSelected,
    showKnots,
    isHovered: propHovered,
    suppressHover,
    isInteractable = true,
    deferContactConesToSceneBatch = false,
    baseColor = '#ff8800',
    hoverColor,
    selectedColor = '#80fffd',
}: LeafRendererProps) {
    const highDetailPrimitiveSegments = 24;
    const lowDetailPrimitiveSegments = 8;
    const useLowDetailPrimitives = !isSelected && !propHovered;

    const { pickRef, visuals } = useHighlight({
        id: leaf.id,
        category: 'support',
        enabled: !!isInteractable && !suppressHover,
        isSelected,
        suppressHover,
        externalHover: propHovered,
        baseColor: dimNonSelected && !isSelected ? '#666666' : baseColor,
        selectedColor,
        hoverColor,
    });

    const handleClick = (e: any) => {
        if (e?.nativeEvent?.altKey || e?.altKey) {
            e.stopPropagation();
            if (e.nativeEvent) {
                e.nativeEvent.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
            }

            window.dispatchEvent(new CustomEvent('brace-leaf-click', {
                detail: {
                    leafId: leaf.id,
                    point: e.point ? { x: e.point.x, y: e.point.y, z: e.point.z } : null,
                    intersection: e,
                },
            }));
            return;
        }

        handleSupportClick(e, leaf.id, !!isInteractable);
    };

    const handlePointerMove = React.useCallback(() => {
        emitSupportModelPointerHover(leaf.modelId ?? null);
    }, [leaf.modelId]);

    const handlePointerOut = React.useCallback(() => {
        emitSupportModelPointerHover(null);
    }, []);

    return (
        <group onClick={handleClick} onPointerMove={handlePointerMove} onPointerOut={handlePointerOut}>
            <group ref={pickRef as any}>
                {leaf.contactCone && !deferContactConesToSceneBatch && (
                    <ContactConeRenderer
                        pos={leaf.contactCone.pos}
                        normal={leaf.contactCone.normal}
                        surfaceNormal={leaf.contactCone.surfaceNormal}
                        diskLengthOverride={leaf.contactCone.diskLengthOverride}
                        profile={leaf.contactCone.profile}
                        color={visuals.color}
                        emissive={visuals.emissive}
                        emissiveIntensity={visuals.emissiveIntensity}
                        radialSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
                        sphereSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
                        isInteractable={isInteractable}
                        isParentSelected={!!isSelected}
                    />
                )}
            </group>

            {showKnots !== false && (
                <KnotRenderer
                    knot={parentKnot}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    selectedColor={visuals.selectedColor}
                    isInteractable={isInteractable}
                    isParentSelected={!!isSelected}
                />
            )}
        </group>
    );
});

LeafRenderer.displayName = 'LeafRenderer';

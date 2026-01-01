import React from 'react';
import { Leaf, Knot } from '../../types';
import { ContactConeRenderer } from '../../SupportPrimitives/ContactCone';
import { handleSupportClick } from '../../interaction/clickHandlers';
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
}

export function LeafRenderer({
    leaf,
    parentKnot,
    isSelected,
    dimNonSelected,
    showKnots,
    isHovered: propHovered,
    suppressHover,
    isInteractable = true,
}: LeafRendererProps) {
    const { pickRef, visuals } = useHighlight({
        id: leaf.id,
        category: 'support',
        isSelected,
        suppressHover,
        externalHover: propHovered,
        baseColor: dimNonSelected && !isSelected ? '#666666' : '#ff8800',
        selectedColor: '#80fffd',
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

    return (
        <group onClick={handleClick}>
            <group ref={pickRef as any}>
                {leaf.contactCone && (
                    <ContactConeRenderer
                        pos={leaf.contactCone.pos}
                        normal={leaf.contactCone.normal}
                        surfaceNormal={leaf.contactCone.surfaceNormal}
                        diskLengthOverride={leaf.contactCone.diskLengthOverride}
                        profile={leaf.contactCone.profile}
                        color={visuals.color}
                        emissive={visuals.emissive}
                        emissiveIntensity={visuals.emissiveIntensity}
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
                    isInteractable={isInteractable}
                    isParentSelected={!!isSelected}
                />
            )}
        </group>
    );
}

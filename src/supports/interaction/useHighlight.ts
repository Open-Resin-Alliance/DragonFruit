import { useEffect } from 'react';
import { usePickingSubscription } from '@/components/picking';
import { PickableCategory } from '@/components/picking';
import { setHoveredId } from '../state';

export interface HighlightOptions {
    id: string;
    category: PickableCategory;
    isSelected?: boolean;
    suppressHover?: boolean;
    externalHover?: boolean; // Legacy/External override
    baseColor?: string;
    selectedColor?: string;
    hoverColor?: string; // Emissive color
}

/**
 * Universal hook for handling interaction highlight state.
 * Manages picking registration and visual state (color, emissive).
 */
export function useHighlight({
    id,
    category,
    isSelected = false,
    suppressHover = false,
    externalHover = false,
    baseColor = '#ff8800',
    selectedColor = '#80fffd',
    hoverColor = '#ffffff'
}: HighlightOptions) {
    
    // Register with picking system and track hover
    const { isHovered: isPickingHovered, pickRef } = usePickingSubscription({
        category,
        objectId: id
    });

    // Determine effective hover state
    // If selected, suppress hover highlight (user preference)
    const isHighlighted = (isPickingHovered || externalHover) && !suppressHover && !isSelected;

    // Calculate visual properties
    const color = isSelected ? selectedColor : baseColor;
    const emissive = isHighlighted ? hoverColor : '#000000';
    const emissiveIntensity = isHighlighted ? 0.3 : 0;

    return {
        pickRef,
        isHighlighted,
        visuals: {
            color,
            emissive,
            emissiveIntensity
        }
    };
}

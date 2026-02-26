import { usePickingSubscription } from '@/components/picking';
import { PickableCategory } from '@/components/picking';

export interface HighlightOptions {
    id: string;
    category: PickableCategory;
    enabled?: boolean;
    isSelected?: boolean;
    suppressHover?: boolean;
    externalHover?: boolean; // Legacy/External override
    baseColor?: string;
    selectedColor?: string;
    hoverColor?: string;
}

/**
 * Universal hook for handling interaction highlight state.
 * Manages picking registration and visual state (color, emissive).
 */
export function useHighlight({
    id,
    category,
    enabled = true,
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
        objectId: id,
        enabled,
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
            selectedColor,
            hoverColor,
            emissive,
            emissiveIntensity
        }
    };
}

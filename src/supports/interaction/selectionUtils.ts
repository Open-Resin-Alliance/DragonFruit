import { getSelectedId } from '../state';

/**
 * Checks if any joint within the given segments is currently selected.
 * Used to maintain parent support selection state when a child joint is being edited.
 */
export function isChildJointSelected(segments: any[]): boolean {
    const selectedId = getSelectedId();
    if (!selectedId) return false;
    
    return segments.some(s => 
        (s.topJoint?.id && s.topJoint.id === selectedId) || 
        (s.bottomJoint?.id && s.bottomJoint.id === selectedId)
    );
}

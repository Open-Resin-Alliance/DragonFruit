import * as THREE from 'three';

export interface BezierHandleProps {
    position: THREE.Vector3;      // The Control Point (World)
    jointPosition: THREE.Vector3; // The Joint Pivot (World)
    color?: string;
    isActive?: boolean;           // Is currently being dragged?
    onDrag?: (newPosition: THREE.Vector3) => void;
    onDragStart?: () => void;
    onDragEnd?: () => void;
}

export interface BezierGizmoState {
    selectedId: string | null;
    hoveredHandle: 'start' | 'end' | null;
    isDragging: boolean;
}

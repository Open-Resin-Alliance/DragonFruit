/**
 * Transform Gizmo Types
 * Unified 3D transform widget for move, rotate, and scale operations
 */

import type * as THREE from 'three';

export type GizmoAxis = 'x' | 'y' | 'z';
export type GizmoPlane = 'xy' | 'xz' | 'yz';
export type GizmoOperation = 'move' | 'rotate' | 'scale';

export interface GizmoColors {
  // Axis gradients (start → end)
  xAxis: {
    start: string;
    end: string;
  };
  yAxis: {
    start: string;
    end: string;
  };
  zAxis: {
    start: string;
    end: string;
  };
  
  // Rotation ring colors
  xRing: {
    ring: string;
    diamond: string;
  };
  yRing: {
    ring: string;
    diamond: string;
  };
  zRing: {
    ring: string;
    diamond: string;
  };
  
  // Other elements
  center: string;
  xyPlane: string;
  xzPlane: string;
  yzPlane: string;
  hover: string;
  active: string;
}

export interface GizmoSizes {
  centerRadius: number;
  arrowShaftRadius: number;
  arrowShaftLength: number;
  arrowHeadRadius: number;
  arrowHeadLength: number;
  planeSize: number;
  planeOffset: number;
  ringMajorRadius: number;
  ringMinorRadius: number;
  ringDiamondRadius: number;
  scaleLineLength: number;
  scaleHexagonRadius: number;
  scaleHexagonDepth: number;
}

export interface GizmoConfig {
  // Which operations are enabled
  enableMove?: boolean;
  enableRotate?: boolean;
  enableScale?: boolean;
  
  // Which components to show
  showMovePlanes?: boolean;
  showCenter?: boolean;
  
  // Size and appearance
  size?: number;
  opacity?: number;
  enableLighting?: boolean;  // Enable emissive materials and point lights (disable for performance)
  handleScale?: number; // Scale factor for handles (arrows/rings) relative to gizmo size
  moveHandleBidirectional?: boolean;
  moveHandleLengthScale?: number;
  moveHandleThicknessScale?: number;

  // Constraints
  constrainToSurface?: boolean;
  constrainToPlane?: boolean;
  axisLock?: GizmoAxis | null;
  
  // Callbacks
  onMoveStart?: (axis?: GizmoAxis) => boolean | void;
  onMove?: (delta: THREE.Vector3, axis?: GizmoAxis) => void;
  onMoveEnd?: () => void;
  
  onRotateStart?: (axis: GizmoAxis) => boolean | void;
  onRotate?: (axis: GizmoAxis, angle: number) => void;
  onRotateEnd?: () => void;
  
  onScaleStart?: (axis: GizmoAxis, isUniform: boolean) => boolean | void;
  onScale?: (axis: GizmoAxis | 'uniform', factor: number) => void;
  onScaleEnd?: () => void;
  
  // Drag state callback (for disabling OrbitControls during drag)
  onDragStateChange?: (isDragging: boolean) => void;
}

export interface TransformGizmoProps extends GizmoConfig {
  position: [number, number, number] | THREE.Vector3;
  rotation?: [number, number, number] | THREE.Euler;
  visible?: boolean;
  suppressAxisAnimations?: boolean;
  rootRef?: React.RefObject<THREE.Group | null>;
}

export interface GizmoPartProps {
  axis?: GizmoAxis;
  isHovered?: boolean;
  isActive?: boolean;
  isDimmed?: boolean;
  onPointerDown?: (e: any) => void;
  onPointerMove?: (e: any) => void;
  onPointerUp?: (e: any) => void;
  onPointerEnter?: (e: any) => void;
  onPointerLeave?: (e: any) => void;
}

/**
 * Transform Gizmo Types
 * Unified 3D transform widget for move, rotate, and scale operations
 */

import type * as THREE from 'three';

export type GizmoAxis = 'x' | 'y' | 'z';
export type GizmoPlane = 'xy' | 'xz' | 'yz';
export type GizmoOperation = 'move' | 'rotate' | 'scale';

export interface GizmoDragStateChangeDetails {
  operation: GizmoOperation;
}

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
  /**
   * Which rotation rings to draw. Omitted (the default) draws all three. Give a
   * subset for a gizmo whose object has fewer than three meaningful rotations —
   * the organic cut's tenon, for instance, takes a roll and a lean and nothing
   * else, and the third ring only invited a rotation with no meaning.
   */
  rotateAxes?: GizmoAxis[];

  // Per-axis visual animation flip for rotation rings.
  // Set a component to -1 to invert the ring handle animation direction
  // (e.g. when the gizmo local frame has an inverted axis convention such
  // as displayY = -cutterY in HolePunchGizmo).
  axisVisualFlip?: { x?: number; y?: number; z?: number };

  /**
   * Rings whose rotation the caller applies to the GIZMO's own frame as well as to
   * the object — the tenon's roll ring, whose orientation is built from the roll it
   * sets. Those rings already carry the movement on screen, so their handle must not
   * advance inside them on top of it, or it travels twice as far as the pointer.
   */
  axisFrameCarriesRotation?: { x?: boolean; y?: boolean; z?: boolean };

  // Scale behavior
  uniformScaling?: boolean;

  // Suppress face-camera behaviors
  disableArrowFlip?: boolean;
  disableRingBillboard?: boolean;
  disableViewCull?: boolean;
  
  // Callbacks
  onMoveStart?: (axis?: GizmoAxis) => boolean | void;
  onMove?: (delta: THREE.Vector3, axis?: GizmoAxis) => void;
  onMoveEnd?: () => void;
  
  onRotateStart?: (axis: GizmoAxis) => boolean | void;
  /**
   * Turn the object by `angle` about `axis`. Return how much of it the object
   * actually took when the rotation has a hard end; return nothing and the ring's
   * handle assumes all of it went through.
   */
  onRotate?: (axis: GizmoAxis, angle: number) => number | void;
  onRotateEnd?: () => void;
  
  onScaleStart?: (axis: GizmoAxis, isUniform: boolean) => boolean | void;
  onScale?: (axis: GizmoAxis | 'uniform', factor: number) => void;
  onScaleEnd?: () => void;
  
  // Drag state callback (for disabling OrbitControls during drag)
  onDragStateChange?: (isDragging: boolean, details?: GizmoDragStateChangeDetails) => void;
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

/**
 * Transform Gizmo Constants
 * Colors and sizes matching world axes style
 */

import type { GizmoColors, GizmoSizes } from './types';

export const GIZMO_COLORS: GizmoColors = {
  // Axis gradients (matches world axes)
  xAxis: {
    start: '#ff6600',    // Orange at center
    end: '#ff3120',      // Bright red at tip
  },
  yAxis: {
    start: '#aaff00',    // Yellow-green at center
    end: '#00ff00',      // Pure green at tip
  },
  zAxis: {
    start: '#00aaff',    // Light blue at center
    end: '#1596ff',      // Bright blue at tip
  },
  
  // Rotation ring colors
  xRing: {
    ring: '#ff0000',     // Red ring
    diamond: '#ff6600',  // Orange diamond handle
  },
  yRing: {
    ring: '#00ff00',     // Green ring
    diamond: '#aaff00',  // Yellow-green diamond handle
  },
  zRing: {
    ring: '#0000ff',     // Blue ring
    diamond: '#00aaff',  // Light blue diamond handle
  },
  
  // Other elements
  center: '#ffffff',     // White
  xyPlane: '#ffff44',    // Yellow (semi-transparent)
  xzPlane: '#ff44ff',    // Magenta (semi-transparent)
  yzPlane: '#44ffff',    // Cyan (semi-transparent)
  hover: '#ffaa00',      // Orange (highlight on hover)
  active: '#ffffff',     // White (during drag)
};

export const GIZMO_SIZES: GizmoSizes = {
  centerRadius: 0.6,      // 4x bigger
  arrowShaftRadius: 0.08,  // 4x bigger
  arrowShaftLength: 4.0,   // 4x bigger
  arrowHeadRadius: 0.16,   // 50% smaller (was 0.32)
  arrowHeadLength: 0.4,    // 50% smaller (was 0.8)
  planeSize: 1.2,          // 4x bigger
  planeOffset: 1.2,        // 4x bigger
  ringMajorRadius: 3.2,    // 4x bigger
  ringMinorRadius: 0.12,   // 4x bigger
  ringDiamondRadius: 0.32, // 4x bigger
  scaleLineLength: 1.6,    // Moved closer to center (was 2.4)
  scaleHexagonRadius: 0.33, // Cube size - 25% larger (was 0.3)
  scaleHexagonDepth: 0.2,  // 4x bigger
};

export const GIZMO_LIGHTING = {
  // Emissive intensity for materials
  emissiveIntensity: {
    idle: 2,      // Normal state (increased from 0.3)
    hovered: 10,   // Hovered state (increased from 0.6)
    active: 20,    // Active/dragging state (increased from 1.0)
  },
  
  // Point light intensity for casting light on model
  pointLightIntensity: {
    idle: 2,      // Increased from 0.5
    hovered: 10,   // Increased from 1.0
    active: 20,    // Increased from 1.5
  },
  
  // Point light distance (how far the light reaches)
  pointLightDistance: 8.0,  // Increased from 3.0
  
  // Point light decay (how quickly light fades)
  pointLightDecay: 1,
};

export const DEFAULT_GIZMO_CONFIG = {
  enableMove: true,
  enableRotate: false,
  enableScale: false,
  showMovePlanes: false,
  showCenter: true,
  size: 1.0,
  opacity: 1.0,
  enableLighting: true,  // Enable by default, users can disable for performance
  constrainToSurface: false,
  constrainToPlane: false,
  axisLock: null,
};

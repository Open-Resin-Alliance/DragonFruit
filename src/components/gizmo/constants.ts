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
  arrowShaftLength: 6.0,   // Increased 50% (was 4.0)
  arrowHeadRadius: 0.24,   // Increased 50% (was 0.16)
  arrowHeadLength: 0.6,    // Increased 50% (was 0.4)
  planeSize: 1.8,          // Increased 50% (was 1.2)
  planeOffset: 1.2,        // 4x bigger
  ringMajorRadius: 4.8,    // Increased 50% (was 3.2)
  ringMinorRadius: 0.12,   // 4x bigger
  ringDiamondRadius: 0.48, // Increased 50% (was 0.32)
  scaleLineLength: 2.3,    // Moved further from center for easier targeting
  scaleHexagonRadius: 0.5, // Increased 50% (was 0.33)
  scaleHexagonDepth: 0.3,  // Increased 50% (was 0.2)
};

export const GIZMO_LIGHTING = {
  // Emissive intensity for materials
  emissiveIntensity: {
    idle: 1.2,
    hovered: 3.2,
    active: 5.2,
  },
  
  // Point light intensity for casting light on model
  pointLightIntensity: {
    idle: 0.9,
    hovered: 2.2,
    active: 3.2,
  },
  
  // Point light distance (how far the light reaches)
  pointLightDistance: 6.2,
  
  // Point light decay (how quickly light fades)
  pointLightDecay: 1.15,
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

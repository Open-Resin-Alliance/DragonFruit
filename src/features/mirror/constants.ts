import type { MirrorAxis } from './types';

export const HANDLE_SHAFT_LENGTH_MM = 7;
export const HANDLE_SHAFT_RADIUS_MM = 0.5;
export const HANDLE_HEAD_LENGTH_MM = 3;
export const HANDLE_HEAD_RADIUS_MM = 1.4;

export const HANDLE_SURFACE_GAP_MM = 14;

export const HANDLE_AXIS_COLORS: Record<MirrorAxis, string> = {
  x: '#e53935',
  y: '#43a047',
  z: '#1e88e5',
};

export const HANDLE_HOVER_COLOR = '#ffffff';

export const HANDLE_RENDER_ORDER = 1000;

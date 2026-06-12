import type * as THREE from 'three';

/**
 * Optimization goals for auto-orientation. Each value is a relative weight in
 * 0..1: higher = stronger pull toward orientations that do well on that metric,
 * and a weight of 0 disables the goal entirely (no separate on/off needed).
 */
export interface AutoOrientGoals {
  /** Minimize unsupported island volume (support material needed). */
  minimizeIslands: number;
  /** Minimize total Z height (fewer layers, faster print). */
  minimizeHeight: number;
  /** Minimize XY footprint (plate fit). */
  minimizeFootprint: number;
  /**
   * Keep painted "protected" faces pointing up / off the plate so they stay
   * support-free. Only has an effect when the model has a protected-face mask.
   */
  protectFaces: number;
}

/** Raw metric values for one candidate orientation (before normalization). */
export interface OrientationMetrics {
  /**
   * Area-weighted overhang severity of downward-facing faces in mm² (a fast
   * geometric proxy for support need). Undefined if the supports goal is off.
   */
  overhangAreaMm2?: number;
  /** Model Z height in mm. */
  heightMm: number;
  /** Projected footprint area in mm² (width × depth). */
  footprintMm2: number;
  /**
   * Area-weighted downward exposure of protected faces in mm² — how much of the
   * painted-protected surface faces the plate (and would thus risk supports).
   * Undefined when there is no protect goal/mask.
   */
  protectedExposureMm2?: number;
}

export interface OrientationCandidate {
  /** Rotation to apply, in the project's global-Euler (`'ZYX'`) convention. */
  rotation: THREE.Euler;
}

export interface ScoredOrientation extends OrientationCandidate {
  metrics: OrientationMetrics;
  /** Weighted, normalized total score. Lower is better. */
  score: number;
}

export const DEFAULT_AUTO_ORIENT_GOALS: AutoOrientGoals = {
  minimizeIslands: 1,
  minimizeHeight: 0,
  minimizeFootprint: 0,
  protectFaces: 0,
};

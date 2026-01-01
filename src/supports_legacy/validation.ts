import { SupportInstance, SupportSettings } from './types';

export interface ValidationIssue {
  path: string;
  message: string;
}

function checkPositive(value: number, path: string, issues: ValidationIssue[], allowZero = false) {
  const valid = allowZero ? value >= 0 : value > 0;
  if (!valid || Number.isNaN(value)) {
    issues.push({ path, message: `${path} must be ${allowZero ? '>= 0' : '> 0'}` });
  }
}

export function validateSupportSettings(settings: SupportSettings): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  checkPositive(settings.tip.contactDiameterMm, 'tip.contactDiameterMm', issues);
  checkPositive(settings.tip.bodyDiameterMm, 'tip.bodyDiameterMm', issues);
  checkPositive(settings.tip.lengthMm, 'tip.lengthMm', issues);

  checkPositive(settings.mid.diameterMm, 'mid.diameterMm', issues);
  if (settings.mid.secondaryDiameterMm !== undefined) {
    checkPositive(settings.mid.secondaryDiameterMm, 'mid.secondaryDiameterMm', issues);
  }

  checkPositive(settings.base.diameterMm, 'base.diameterMm', issues);
  checkPositive(settings.base.heightMm, 'base.heightMm', issues, true);
  checkPositive(settings.base.neckDiameterMm, 'base.neckDiameterMm', issues);
  checkPositive(settings.base.neckHeightMm, 'base.neckHeightMm', issues, true);

  if (settings.baseFlare.enabled) {
    checkPositive(settings.baseFlare.diameterMm, 'baseFlare.diameterMm', issues);
    checkPositive(settings.baseFlare.heightMm, 'baseFlare.heightMm', issues);
  }

  checkPositive(settings.baseJoint.contactDiameterMm, 'baseJoint.contactDiameterMm', issues);
  checkPositive(settings.baseJoint.bodyDiameterMm, 'baseJoint.bodyDiameterMm', issues);
  checkPositive(settings.baseJoint.lengthMm, 'baseJoint.lengthMm', issues);

  checkPositive(settings.jointDefaults.ballDiameterMm, 'jointDefaults.ballDiameterMm', issues);
  checkPositive(settings.jointDefaults.maxRotationDeg, 'jointDefaults.maxRotationDeg', issues, true);
  checkPositive(settings.jointDefaults.maxSlideMm, 'jointDefaults.maxSlideMm', issues, true);

  return issues;
}

export function validateSupportInstance(instance: SupportInstance): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!instance.id) {
    issues.push({ path: 'id', message: 'id is required' });
  }

  if (!instance.tip) {
    issues.push({ path: 'tip', message: 'tip position is required' });
  }
  if (!instance.base) {
    issues.push({ path: 'base', message: 'base position is required' });
  }

  issues.push(...validateSupportSettings(instance.settings));

  return issues;
}

export function isSupportSettingsValid(settings: SupportSettings): boolean {
  return validateSupportSettings(settings).length === 0;
}

export function isSupportInstanceValid(instance: SupportInstance): boolean {
  return validateSupportInstance(instance).length === 0;
}

// Placement validation types
export type PlacementValidationLevel = 'valid' | 'invalid';

export interface PlacementValidationResult {
  level: PlacementValidationLevel;
  message?: string;
  nearestDistance?: number;
  nearestSupportId?: string;
}

export interface PlacementValidationConfig {
  minClearanceMm: number; // Minimum clearance between support surfaces (not center-to-center)
}

// Default validation config
export const DEFAULT_PLACEMENT_CONFIG: PlacementValidationConfig = {
  minClearanceMm: 0.1, // 0.1mm minimum clearance between support surfaces
};

/**
 * Check if a new support tip is too close to existing support tips
 * Uses surface-to-surface distance, not center-to-center
 */
export function validateTipPlacement(
  tipPosition: { x: number; y: number; z: number },
  newSupportSettings: SupportSettings,
  existingSupports: SupportInstance[],
  config: PlacementValidationConfig = DEFAULT_PLACEMENT_CONFIG
): PlacementValidationResult {
  let nearestDistance = Infinity;
  let nearestSupportId: string | undefined;
  
  const newTipRadius = newSupportSettings.tip.contactDiameterMm / 2;

  // Check distance to all existing support tips
  for (const support of existingSupports) {
    const dx = tipPosition.x - support.tip.x;
    const dy = tipPosition.y - support.tip.y;
    const dz = tipPosition.z - support.tip.z;
    const centerDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    
    // Calculate surface-to-surface distance
    const existingTipRadius = support.settings.tip.contactDiameterMm / 2;
    const surfaceDistance = centerDistance - newTipRadius - existingTipRadius;

    if (surfaceDistance < nearestDistance) {
      nearestDistance = surfaceDistance;
      nearestSupportId = support.id;
    }
  }

  // Check if surfaces are too close
  if (nearestDistance < config.minClearanceMm) {
    console.log('[Validation] Too close!', {
      surfaceDistance: nearestDistance.toFixed(3),
      minClearance: config.minClearanceMm,
      nearestSupportId,
    });
    return {
      level: 'invalid',
      message: `Too close to existing support (${nearestDistance.toFixed(3)}mm clearance, min: ${config.minClearanceMm}mm)`,
      nearestDistance,
      nearestSupportId,
    };
  }

  console.log('[Validation] Valid placement', {
    surfaceDistance: nearestDistance === Infinity ? 'none' : nearestDistance.toFixed(3),
    minClearance: config.minClearanceMm,
  });

  return {
    level: 'valid',
    nearestDistance: nearestDistance === Infinity ? undefined : nearestDistance,
  };
}

/**
 * Find supports within a given radius of a point
 */
export function findSupportsNearPoint(
  point: { x: number; y: number; z: number },
  supports: SupportInstance[],
  radiusMm: number
): SupportInstance[] {
  const nearby: SupportInstance[] = [];

  for (const support of supports) {
    const dx = point.x - support.tip.x;
    const dy = point.y - support.tip.y;
    const dz = point.z - support.tip.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (distance <= radiusMm) {
      nearby.push(support);
    }
  }

  return nearby;
}

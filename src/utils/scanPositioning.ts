import * as THREE from 'three';
import type { ModelTransform } from '@/hooks/useModelTransform';

/**
 * Returns the world-space Z of a given scan layer.
 * Scan geometry is already transformed into world space before scanning,
 * so we just offset from scanBBox.min.z by layer index * layerHeightMm.
 */
export function getWorldZForLayer(scanBBox: THREE.Box3, layerHeightMm: number, layerIndex: number): number {
  const zOffset = scanBBox.min.z;
  return zOffset + layerIndex * layerHeightMm;
}

/**
 * Returns the position to use for scan-based visualization groups.
 * Policy: visuals are in world space from scan (including rotation + auto-lift),
 * so we only apply X/Y translation from the live transform and keep Z = 0.
 */
export function getScanVisualPosition(transform?: ModelTransform): THREE.Vector3 {
  if (!transform) {
    return new THREE.Vector3(0, 0, 0);
  }
  return new THREE.Vector3(transform.position.x, transform.position.y, 0);
}

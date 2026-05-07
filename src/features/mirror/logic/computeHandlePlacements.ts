import * as THREE from 'three';
import type { MirrorAxis } from '../types';
import { HANDLE_SURFACE_GAP_MM } from '../constants';

export interface HandlePlacement {
  axis: MirrorAxis;
  side: 'positive' | 'negative';
  position: THREE.Vector3;
  direction: THREE.Vector3;
}

const AXES: MirrorAxis[] = ['x', 'y', 'z'];

export function computeHandlePlacements(worldBbox: THREE.Box3): HandlePlacement[] {
  const center = worldBbox.getCenter(new THREE.Vector3());
  const placements: HandlePlacement[] = [];

  for (const axis of AXES) {
    for (const side of ['positive', 'negative'] as const) {
      const sign = side === 'positive' ? 1 : -1;
      const position = center.clone();
      const surface = side === 'positive' ? worldBbox.max : worldBbox.min;
      if (axis === 'x') position.x = surface.x + sign * HANDLE_SURFACE_GAP_MM;
      if (axis === 'y') position.y = surface.y + sign * HANDLE_SURFACE_GAP_MM;
      if (axis === 'z') position.z = surface.z + sign * HANDLE_SURFACE_GAP_MM;

      const direction = new THREE.Vector3(0, 0, 0);
      if (axis === 'x') direction.x = -sign;
      if (axis === 'y') direction.y = -sign;
      if (axis === 'z') direction.z = -sign;

      placements.push({ axis, side, position, direction });
    }
  }

  return placements;
}

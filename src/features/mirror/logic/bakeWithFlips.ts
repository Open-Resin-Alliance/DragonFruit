import * as THREE from 'three';
import { bakeMirrorIntoGeometry } from './bakeMirrorIntoGeometry';
import type { MirrorAxis } from '../types';

export function bakeWithFlips(
  source: THREE.BufferGeometry,
  flips: { x: boolean; y: boolean; z: boolean },
): THREE.BufferGeometry | null {
  const list: MirrorAxis[] = [];
  if (flips.x) list.push('x');
  if (flips.y) list.push('y');
  if (flips.z) list.push('z');
  if (list.length === 0) return null;
  let current = source;
  for (let i = 0; i < list.length; i += 1) {
    const next = bakeMirrorIntoGeometry(current, list[i]);
    if (i > 0) current.dispose();
    current = next;
  }
  return current;
}

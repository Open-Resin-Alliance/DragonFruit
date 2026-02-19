import * as THREE from 'three';

export function clampTintStrength(input: number | undefined, fallback: number): number {
  const n = typeof input === 'number' ? input : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

export function blendTintColor(baseColor: string, tintColor: string | undefined, strength: number): string {
  const base = new THREE.Color('#ffffff');
  const tint = new THREE.Color('#ec2a77');

  try {
    base.setStyle(baseColor);
  } catch {
    base.setStyle('#ffffff');
  }

  if (tintColor) {
    try {
      tint.setStyle(tintColor);
    } catch {
      // keep fallback tint
    }
  }

  return base.lerp(tint, clampTintStrength(strength, 0)).getStyle();
}

import type { ModelHollowingModifier } from '@/features/mesh-modifiers/types';

/** Stable JSON serialization of a hollowing modifier, for history/diffing. */
export function serializeHollowingModifier(modifier: ModelHollowingModifier | null | undefined): string {
  if (!modifier?.enabled) return 'disabled';
  return JSON.stringify({
    enabled: true,
    blockedVoxelIndices: [...(modifier.blockedVoxelIndices ?? [])].sort((a, b) => a - b),
    mode: modifier.mode,
    voxelSizeMm: Number(modifier.voxelSizeMm.toFixed(4)),
    shellThicknessMm: Number(modifier.shellThicknessMm.toFixed(4)),
    infillMode: modifier.infillMode ?? 'lattice',
    infillCellMm: Number((modifier.infillCellMm ?? 4.2426).toFixed(4)),
    infillBeamRadiusMm: Number((modifier.infillBeamRadiusMm ?? 0.25).toFixed(4)),
    openFace: modifier.openFace,
    openFaceSelected: modifier.mode === 'shell_open_face'
      ? (modifier.openFaceSelected ?? true)
      : true,
  });
}

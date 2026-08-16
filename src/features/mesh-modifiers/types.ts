export type MeshModifierHollowMode = 'cavity' | 'infill' | 'shell_open_face';
export type MeshModifierInfillMode = 'lattice' | 'pillar';
export type MeshModifierOpenFace = 'x_min' | 'x_max' | 'y_min' | 'y_max' | 'z_min' | 'z_max';

export type ModelHollowingModifier = {
  enabled: boolean;
  bakedIntoGeometry?: boolean;
  sourcePositionsBase64?: string;
  sourcePositionCount?: number;
  /**
   * VOXL 2.2 dedup pointer: the HSRC chunk index this model's source-position
   * snapshot lives in, present only on models that SHARE another model's chunk
   * (identical-snapshot dedup). Absent ⇒ the owner's own model index. Set by
   * the codec on read/write; not persisted in-memory outside serialization.
   */
  sourceChunkIndex?: number;
  /** Base64-encoded Float32Array of cavity interior mesh positions. */
  cavityPositionsBase64?: string;
  /** Number of vertices in the cavity mesh (count × 3 = float count). */
  cavityPositionCount?: number;
  /** VOXL 2.2 dedup pointer for the CAVT chunk (see `sourceChunkIndex`). */
  cavityChunkIndex?: number;
  blockedVoxelIndices?: number[];
  /** Scene rotation (unit quaternion [x, y, z, w]) captured when
   *  blockedVoxelIndices were committed. Blocker indices address the
   *  rotation-aligned voxel grid, so they are only meaningful while the
   *  model's rotation still matches this stamp. */
  blockedVoxelRotationQuat?: [number, number, number, number];
  mode: MeshModifierHollowMode;
  voxelSizeMm: number;
  shellThicknessMm: number;
  infillMode?: MeshModifierInfillMode;
  infillCellMm?: number;
  infillBeamRadiusMm?: number;
  openFace: MeshModifierOpenFace;
  openFaceSelected?: boolean;
};

export type ModelHolePunchPlacement = {
  id: string;
  centerNorm: [number, number, number];
  radiusMm: number;
  radiusYMm?: number;
  depthMm: number;
  direction: [number, number, number];
  depthMode?: 'manual' | 'auto';
};

export type ModelMeshModifiers = {
  hollowing?: ModelHollowingModifier | null;
  holePunches?: ModelHolePunchPlacement[];
  holePunchAppliedPlacements?: ModelHolePunchPlacement[];
  holePunchesBakedIntoGeometry?: boolean;
  holePunchSourcePositionsBase64?: string;
  holePunchSourcePositionCount?: number;
  /** VOXL 2.2 dedup pointer for the PSRC chunk (see `ModelHollowingModifier.sourceChunkIndex`). */
  holePunchSourceChunkIndex?: number;
};

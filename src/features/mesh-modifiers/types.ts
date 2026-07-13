export type MeshModifierHollowMode = 'cavity' | 'infill' | 'shell_open_face';
export type MeshModifierInfillMode = 'lattice' | 'pillar';
export type MeshModifierOpenFace = 'x_min' | 'x_max' | 'y_min' | 'y_max' | 'z_min' | 'z_max';

export type ModelHollowingModifier = {
  enabled: boolean;
  bakedIntoGeometry?: boolean;
  sourcePositionsBase64?: string;
  sourcePositionCount?: number;
  /** Base64-encoded Float32Array of cavity interior mesh positions. */
  cavityPositionsBase64?: string;
  /** Number of vertices in the cavity mesh (count × 3 = float count). */
  cavityPositionCount?: number;
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
};

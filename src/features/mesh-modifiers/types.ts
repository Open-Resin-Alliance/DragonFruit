export type MeshModifierHollowMode = 'cavity' | 'infill' | 'shell_open_face';
export type MeshModifierInfillMode = 'lattice' | 'pillar';
export type MeshModifierOpenFace = 'x_min' | 'x_max' | 'y_min' | 'y_max' | 'z_min' | 'z_max';

export type ModelHollowingModifier = {
  enabled: boolean;
  bakedIntoGeometry?: boolean;
  sourcePositionsBase64?: string;
  sourcePositionCount?: number;
  blockedVoxelIndices?: number[];
  mode: MeshModifierHollowMode;
  voxelResolution: number;
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

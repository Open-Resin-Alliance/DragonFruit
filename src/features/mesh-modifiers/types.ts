export type MeshModifierHollowMode = 'cavity' | 'shell_open_face';
export type MeshModifierOpenFace = 'x_min' | 'x_max' | 'y_min' | 'y_max' | 'z_min' | 'z_max';

export type ModelHollowingModifier = {
  enabled: boolean;
  bakedIntoGeometry?: boolean;
  sourcePositionsBase64?: string;
  sourcePositionCount?: number;
  mode: MeshModifierHollowMode;
  voxelResolution: number;
  shellThicknessMm: number;
  openFace: MeshModifierOpenFace;
};

export type ModelHolePunchPlacement = {
  id: string;
  centerNorm: [number, number, number];
  radiusMm: number;
  depthMm: number;
  direction: [number, number, number];
};

export type ModelMeshModifiers = {
  hollowing?: ModelHollowingModifier | null;
  holePunches?: ModelHolePunchPlacement[];
};

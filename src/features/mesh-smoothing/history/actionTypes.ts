export const MESH_SMOOTHING_STROKE = 'mesh-smoothing:stroke' as const;

export type MeshSmoothingStrokePayload = {
  geometryKey: number;
  uniqueIds: Uint32Array;
  before: Float32Array;
  after: Float32Array;
};

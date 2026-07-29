export const MESH_SMOOTHING_STROKE = 'mesh-smoothing:stroke' as const;

export type MeshSmoothingStrokePayload = {
  geometryKey: number;
  uniqueIds: Uint32Array;
  before: Float32Array;
  after: Float32Array;
};

/** Action→payload map for the mesh-smoothing history domain. */
export type MeshSmoothingHistoryPayloadMap = {
  [MESH_SMOOTHING_STROKE]: MeshSmoothingStrokePayload;
};

import type { RleLabels } from '@/volumeAnalysis/IslandScan/rle';

export type VolumeNodeId = number;

export type VolumeEdgeType = 'merge' | 'split';

export type VolumeEventType = 'birth' | 'continue' | 'merge' | 'split' | 'death';

export interface VolumeEvent {
  layerIndex: number;
  type: VolumeEventType;
  nodeIds: VolumeNodeId[];
}

export type ValidationIssueCode =
  | 'node_non_contiguous'
  | 'node_multiple_components_same_layer'
  | 'continued_through_event';

export interface ValidationIssue {
  layerIndex: number;
  code: ValidationIssueCode;
  nodeId: VolumeNodeId;
  details: string;
}

export interface VolumeNode {
  id: VolumeNodeId;
  firstLayer: number;
  lastLayer: number;
}

export interface VolumeEdge {
  from: VolumeNodeId;
  to: VolumeNodeId;
  type: VolumeEdgeType;
}

export interface VolumeHierarchy {
  nodes: VolumeNode[];
  edges: VolumeEdge[];
}

export interface BuildVolumeHierarchyResult extends VolumeHierarchy {
  events: VolumeEvent[];
  issues: ValidationIssue[];
  nodeLabelsPerLayer: RleLabels[];
}

export interface BuildVolumeHierarchyOptions {
  connectivity?: 4 | 8;
  minOverlapPx?: number;
  overlapNeighborhoodPx?: number;
}

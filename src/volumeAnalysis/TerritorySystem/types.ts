import { RleLabels } from '../island/rle';

export interface Kingdom {
    id: number;
    color: number; // Hex color for visualization
    centroid: { x: number, y: number, z: number }; // In Grid Pixels (Z is layer index)
    lastLayer: number;
    totalArea: number; // For weighted merging if needed
    parentId?: number; // Parent Island ID for merging relationships
}

export interface TerritoryLayerResult {
    kingdoms: Kingdom[];
    labelMap: RleLabels; // RLE map of pixel -> kingdom ID
}

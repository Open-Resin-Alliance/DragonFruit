import * as THREE from 'three';
import { analyzeScanResults, type ScanResults, type ScanParams } from './voxelization/ScanOrchestrator';
import { computeIslandMarkers, type IslandMarker } from '@/volumeAnalysis/IslandScan/islandOverlayLogic';

export async function runStep2Analysis(
    scanResults: ScanResults,
    options: {
        px_mm: number,
        layerHeightMm: number
    },
    // We might need Z offset if we want accurate marker positions
    zOffset: number,
    onProgress?: (done: number, total: number) => void
): Promise<{ markers: IslandMarker[], scanResults: ScanResults }> {

    // 1. Analyze existing Voxel Data
    const analyzedResults = await analyzeScanResults(
        scanResults,
        {
            px_mm: options.px_mm,
            support_buffer_mm: 0.0,
            min_island_area_mm2: 0.01
        },
        onProgress
    );

    // Filter out "Merged Placeholders" so we only get true Island starts
    // This creates a clean list of islands for markers, ignoring the upper merged volumes.
    const validIslands = analyzedResults.islands.filter(i => !i.isMergedPlaceholder);

    const markerScanResults = {
        ...analyzedResults,
        islands: validIslands
    };

    // 2. Generate Island Markers
    // We use the zOffset (bbox.min.z) to position markers correctly in world space
    const markers = computeIslandMarkers(
        markerScanResults, // Use filtered results
        { min: { z: zOffset } },
        options.layerHeightMm,
        0.5
    );

    return { markers, scanResults: analyzedResults };
}

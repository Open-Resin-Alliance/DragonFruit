
import React from 'react';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { getIslandHierarchy, calculateIslandVolume } from '@/volumeAnalysis/VoxelSystem/IslandVolume';
import type { Island } from '@/volumeAnalysis/IslandScan/types';
import type { ScanResults } from '@/volumeAnalysis/IslandScan/ScanOrchestrator';

interface ModelStatsCardProps {
  model: LoadedModel | null;
  layerIndex: number;
  numLayers: number;
  heightMm: number;
  clipUpper: number | null;
  scanData: ScanResults | null;
}

export function ModelStatsCard({
  model,
  layerIndex,
  numLayers,
  heightMm,
  clipUpper,
  scanData
}: ModelStatsCardProps) {

  const islandCountLayer = scanData && layerIndex > 0 && layerIndex <= scanData.layers.length
    ? scanData.layers[layerIndex - 1].islandCount
    : '-';

  const islandCountTotal = scanData
    ? scanData.layers.reduce((a, l) => a + l.islandCount, 0)
    : '-';

  return (
    <div className="absolute bottom-4 left-72 bg-neutral-800/95 backdrop-blur-sm rounded-lg px-3 py-2 shadow-xl pointer-events-none w-[200px]">
      <div className="space-y-1 pointer-events-auto">
        <div className="font-semibold text-xs text-neutral-200 border-b border-neutral-700 pb-1 mb-1 truncate">
          {model ? model.name : 'No model selected'}
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-[10px] text-neutral-400">
          <span>Loaded:</span>
          <span className="text-neutral-200">{model ? 'Yes' : 'No'}</span>

          <span>Polygons:</span>
          <span className="text-neutral-200">{model ? model.polygonCount.toLocaleString() : '-'}</span>

          <span>Height:</span>
          <span className="text-neutral-200">{model ? `${heightMm.toFixed(2)} mm` : '-'}</span>

          <span>Layers:</span>
          <span className="text-neutral-200">{model ? numLayers : '-'}</span>

          <span>Current Layer:</span>
          <span className="text-neutral-200">
            {model ? layerIndex : '-'} {layerIndex === 0 && <span className="text-neutral-500">(home)</span>}
          </span>

          <span>Visible Height:</span>
          <span className="text-neutral-200">{model && layerIndex > 0 ? `${(clipUpper ?? 0).toFixed(2)} mm` : 'Full'}</span>

          <span>Islands (Layer):</span>
          <span className="text-neutral-200">{islandCountLayer}</span>

          <span>Islands (Total):</span>
          <span className="text-neutral-200">{islandCountTotal}</span>
        </div>
      </div>
    </div>
  );
}

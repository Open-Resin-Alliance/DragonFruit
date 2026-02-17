
import React from 'react';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';

interface ModelStatsCardProps {
  model: LoadedModel | null;
  numLayers: number;
  heightMm: number;
}

export function ModelStatsCard({
  model,
  numLayers,
  heightMm
}: ModelStatsCardProps) {

  const formatBytes = (bytes: number) => {
    const abs = Math.max(0, bytes);
    const KB = 1024;
    const MB = KB * 1024;
    const GB = MB * 1024;

    if (abs >= GB) return `${(abs / GB).toFixed(2)} GB`;
    if (abs >= MB) return `${(abs / MB).toFixed(2)} MB`;
    if (abs >= KB) return `${(abs / KB).toFixed(1)} KB`;
    return `${abs.toFixed(0)} B`;
  };

  return (
    <div className="absolute bottom-4 left-2 pointer-events-none select-none w-fit">
      <div className="space-y-1">
        <div className="font-semibold text-[11px] text-neutral-200/70 truncate">
          {model ? model.name : 'No model selected'}
        </div>

        <div className="grid grid-cols-[auto_auto] gap-x-2 gap-y-0.5 text-[10px] text-neutral-200/50">
          <span>STL Size:</span>
          <span className="text-neutral-200/70">{model?.fileSizeBytes != null ? formatBytes(model.fileSizeBytes) : '-'}</span>

          <span>Polygons:</span>
          <span className="text-neutral-200/70">{model ? model.polygonCount.toLocaleString() : '-'}</span>

          <span>Height:</span>
          <span className="text-neutral-200/70">{model ? `${heightMm.toFixed(2)} mm` : '-'}</span>

          <span>Layers:</span>
          <span className="text-neutral-200/70">{model ? numLayers : '-'}</span>
        </div>
      </div>
    </div>
  );
}

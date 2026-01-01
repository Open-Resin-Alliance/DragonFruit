'use client';

import React from 'react';
import { useIslandManager } from '@/volumeAnalysis/IslandScan/useIslandManager';
import { useIslandScanWorkflow } from './useIslandScanWorkflow';

interface Props {
  islands: ReturnType<typeof useIslandManager>;
  hasGeometry: boolean;
}

export function IslandScanWorkflowCard({ islands, hasGeometry }: Props) {
  const wf = useIslandScanWorkflow(islands);

  return (
    <div className="bg-neutral-800/95 backdrop-blur-sm rounded-lg px-3 pb-2 pt-1 shadow-xl space-y-2">
      <div className="flex items-center justify-between py-1 border-b border-neutral-700">
        <h3 className="text-xs font-semibold text-neutral-200">Island Scan Workflow</h3>
        <button
          type="button"
          onClick={wf.reset}
          className="px-1.5 py-0.5 text-[10px] rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200 transition-colors"
        >
          Reset
        </button>
      </div>

      <div className="space-y-1">
        <div className="text-[10px] text-neutral-400">
          Step 1: Run Scanline Scan
        </div>
        <button
          type="button"
          onClick={wf.runStep1Scanline}
          disabled={!hasGeometry || islands.scanning}
          className="w-full px-2 py-1 text-[10px] rounded bg-purple-600 hover:bg-purple-500 disabled:bg-neutral-700 disabled:opacity-50 text-white transition-colors"
        >
          {islands.scanning ? 'Scanning...' : wf.step1Scan === 'complete' ? 'Re-Run Scanline' : 'Run Scanline'}
        </button>
      </div>

      <div className="space-y-1">
        <div className="text-[10px] text-neutral-400">
          Step 2: Enable Debug Visuals (IDs + Voxels)
        </div>
        <button
          type="button"
          onClick={wf.runStep2EnableVisuals}
          disabled={!islands.scanData}
          className="w-full px-2 py-1 text-[10px] rounded bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:opacity-50 text-white transition-colors"
        >
          {wf.step2Visuals === 'complete' ? 'Visuals Enabled' : 'Enable Visuals'}
        </button>
      </div>

      <div className="text-[9px] text-neutral-500 leading-snug">
        Suggested starting values:
        <div className="text-[9px] text-neutral-500">Min Area: 0</div>
        <div className="text-[9px] text-neutral-500">Min Overlap: 4</div>
        <div className="text-[9px] text-neutral-500">Overlap Radius: 1</div>
      </div>
    </div>
  );
}

'use client';

import React from 'react';
import { useIslandManager } from '@/volumeAnalysis/IslandScan/useIslandManager';
import { useIslandScanWorkflow } from './useIslandScanWorkflow';
import { Button, Card, CardHeader } from '@/components/ui/primitives';

interface Props {
  islands: ReturnType<typeof useIslandManager>;
  hasGeometry: boolean;
}

export function IslandScanWorkflowCard({ islands, hasGeometry }: Props) {
  const wf = useIslandScanWorkflow(islands);

  return (
    <Card>
      <CardHeader
        left={<h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Island Scan Workflow</h3>}
        right={(
          <Button
            type="button"
            onClick={wf.reset}
            variant="secondary"
            size="sm"
            className="!h-8 !px-2.5 !py-0 text-[11px]"
          >
            Reset
          </Button>
        )}
      />

      <div className="px-2.5 pt-1 pb-2.5 space-y-2">
      <div className="space-y-1">
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Step 1: Run Scanline Scan
        </div>
        <Button
          type="button"
          onClick={wf.runStep1Scanline}
          disabled={!hasGeometry || islands.scanning}
          variant="primary"
          size="sm"
          className="w-full !h-8 !px-2.5 !py-0 text-[11px] disabled:opacity-50"
        >
          {islands.scanning ? 'Scanning...' : wf.step1Scan === 'complete' ? 'Re-Run Scanline' : 'Run Scanline'}
        </Button>
      </div>

      <div className="space-y-1">
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Step 2: Enable Debug Visuals (IDs + Voxels)
        </div>
        <Button
          type="button"
          onClick={wf.runStep2EnableVisuals}
          disabled={!islands.scanData}
          variant="accent"
          size="sm"
          className="w-full !h-8 !px-2.5 !py-0 text-[11px] disabled:opacity-50"
        >
          {wf.step2Visuals === 'complete' ? 'Visuals Enabled' : 'Enable Visuals'}
        </Button>
      </div>

      <div
        className="text-[11px] leading-snug rounded-md border p-2"
        style={{
          color: 'var(--text-muted)',
          borderColor: 'var(--border-subtle)',
          background: 'color-mix(in srgb, var(--surface-1), transparent 8%)',
        }}
      >
        Suggested starting values:
        <div className="text-[11px]">Min Area: 0</div>
        <div className="text-[11px]">Min Overlap: 4</div>
        <div className="text-[11px]">Overlap Radius: 1</div>
      </div>
      </div>
    </Card>
  );
}

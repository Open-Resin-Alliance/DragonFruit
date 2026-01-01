'use client';

import React from 'react';
import { useIslandManager } from '@/volumeAnalysis/IslandScan/useIslandManager';

export type IslandScanWorkflowStepStatus = 'pending' | 'running' | 'complete';

export interface IslandScanWorkflowState {
  step1Scan: IslandScanWorkflowStepStatus;
  step2Visuals: IslandScanWorkflowStepStatus;
  runStep1Scanline: () => Promise<void>;
  runStep2EnableVisuals: () => void;
  reset: () => void;
}

export function useIslandScanWorkflow(islands: ReturnType<typeof useIslandManager>): IslandScanWorkflowState {
  const [step1Scan, setStep1Scan] = React.useState<IslandScanWorkflowStepStatus>('pending');
  const [step2Visuals, setStep2Visuals] = React.useState<IslandScanWorkflowStepStatus>('pending');

  React.useEffect(() => {
    if (islands.scanData) {
      setStep1Scan('complete');
    }
  }, [islands.scanData]);

  const runStep1Scanline = React.useCallback(async () => {
    setStep1Scan('running');
    try {
      await islands.onRunScanlineScan();
    } finally {
      // Completion is driven by scanData effect.
    }
  }, [islands]);

  const runStep2EnableVisuals = React.useCallback(() => {
    if (!islands.scanData) return;

    islands.setVoxelEnabled(true);
    islands.setVoxelShowTerritory(false);
    islands.setShowIslandIdLabels(true);
    islands.setOverlayEnabled(false);

    setStep2Visuals('complete');
  }, [islands]);

  const reset = React.useCallback(() => {
    islands.clearScanData();
    setStep1Scan('pending');
    setStep2Visuals('pending');
  }, [islands]);

  return {
    step1Scan,
    step2Visuals,
    runStep1Scanline,
    runStep2EnableVisuals,
    reset,
  };
}

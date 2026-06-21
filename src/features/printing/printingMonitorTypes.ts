export type FleetUploadMaterialOption = {
  id: string;
  name: string;
  layerHeightMm: number | null;
};

export type PrintingMonitorRecentPlate = {
  plateId: number;
  name: string;
  materialProfileName: string | null;
  lastModifiedEpochSec: number | null;
  layerCount: number | null;
  printTimeSec: number | null;
  usedMaterialMl: number | null;
  totalSolidAreaMm2: number | null;
  smallestAreaMm2: number | null;
  largestAreaMm2: number | null;
};

export type PrintingMonitorPendingConfirmation =
  | {
      kind: 'control';
      action: 'cancel' | 'emergency-stop';
    }
  | {
      kind: 'plate';
      action: 'start' | 'delete';
      plateId: number;
      plateName: string;
    };

export type PrintingMonitorDebugChannelState = {
  requestedAtEpochMs: number | null;
  request: Record<string, unknown> | null;
  httpStatus: number | null;
  rawPayload: unknown;
  parsedPayload: unknown;
  error: string | null;
};

export type PrintingMonitorDebugState = {
  status: PrintingMonitorDebugChannelState;
  webcam: PrintingMonitorDebugChannelState;
  plates: PrintingMonitorDebugChannelState;
  taskHistory: PrintingMonitorDebugChannelState;
  taskDetails: PrintingMonitorDebugChannelState;
};

export type PrintingMonitorFeatureToggleResponse = {
  operation: string;
  httpStatus: number | null;
  httpOk: boolean | null;
  commandOk: boolean | null;
  payload: unknown;
  error: string | null;
  requestedAtEpochMs: number;
};

export const PRINTING_MONITOR_DEBUG_CHANNELS = ['status', 'webcam', 'plates', 'taskHistory', 'taskDetails'] as const;
export type PrintingMonitorDebugChannel = (typeof PRINTING_MONITOR_DEBUG_CHANNELS)[number];

export const DIAGNOSTICS_BENCHMARK_REQUEST_EVENT = 'dragonfruit:diagnostics-benchmark-request';
export const DIAGNOSTICS_BENCHMARK_PROGRESS_EVENT = 'dragonfruit:diagnostics-benchmark-progress';

export type DiagnosticsBenchmarkPhaseName = 'slow' | 'medium' | 'fast';
export type DiagnosticsBenchmarkStressProfile = 'quick' | 'standard' | 'torture';

export type DiagnosticsBenchmarkStats = {
  sampleCount: number;
  durationMs: number;
  fpsAvg: number;
  fpsMin: number;
  fpsMax: number;
  frameTimeAvgMs: number;
  frameTimeP95Ms: number;
  frameTimeMaxMs: number;
};

export type DiagnosticsBenchmarkPhaseResult = {
  phase: DiagnosticsBenchmarkPhaseName;
  stats: DiagnosticsBenchmarkStats;
};

export type DiagnosticsBenchmarkResult = {
  requestId: string;
  stressProfile: DiagnosticsBenchmarkStressProfile;
  startedAtIso: string;
  finishedAtIso: string;
  totalDurationMs: number;
  projectionMode: 'orthographic' | 'perspective';
  cameraFeelPreset: 'raw' | 'precise' | 'balanced' | 'fast';
  phases: DiagnosticsBenchmarkPhaseResult[];
  overall: DiagnosticsBenchmarkStats;
};

export type DiagnosticsBenchmarkRequestDetail = {
  requestId: string;
  stressProfile: DiagnosticsBenchmarkStressProfile;
};

export type DiagnosticsBenchmarkProgressDetail = {
  requestId: string;
  status: 'started' | 'phase-complete' | 'completed' | 'error';
  phase?: DiagnosticsBenchmarkPhaseName;
  message?: string;
  result?: DiagnosticsBenchmarkResult;
};

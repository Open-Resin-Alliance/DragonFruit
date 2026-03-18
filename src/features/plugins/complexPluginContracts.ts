export type RemoteMaterialFieldKind = 'number' | 'integer' | 'text' | 'boolean' | 'select';

export type RemoteMaterialFieldOption = {
  value: string;
  label: string;
};

/**
 * Generic field model for plugin-provided remote material settings.
 *
 * This is intentionally vendor-agnostic and maps cleanly to existing Athena
 * NanoDLP fields via compatibility shims.
 */
export type RemoteMaterialPrimaryField = {
  key: string;
  label: string;
  aliases: string[];
  defaultValue: number | string | boolean;
  kind?: RemoteMaterialFieldKind;
  description?: string;
  options?: RemoteMaterialFieldOption[];
};

export type RemoteMaterialBasicSection = {
  id: string;
  title: string;
  keys: string[];
};

export type RemoteMaterialAdvancedSection = {
  id: string;
  title: string;
  keywords: string[];
};

export type RemoteMaterialProcessValues = {
  layerHeightMm?: number;
  normalExposureSec?: number;
  bottomExposureSec?: number;
  bottomLayerCount?: number;
};

/**
 * Generic adapter contract for remote (device-side) material settings.
 *
 * NOTE: method names remain aligned with the current runtime usage so we can
 * migrate incrementally without behavior changes.
 */
export type RemoteMaterialSettingsAdapter = {
  primaryEditFields: RemoteMaterialPrimaryField[];
  basicSections: RemoteMaterialBasicSection[];
  advancedSections: RemoteMaterialAdvancedSection[];
  resolveEditDraftFromMeta: (meta: Record<string, unknown>) => Record<string, string>;
  resolveMaterialProcessValues: (meta: Record<string, unknown>) => RemoteMaterialProcessValues;
  denormalizeEditDraftForBackend: (draft: Record<string, string>) => Record<string, string>;
  resolveAdvancedSectionId: (fieldKey: string) => string;
  getFieldHelpText: (fieldKey: string) => string;
  isDynamicWaitEnabled: (draft: Record<string, string>) => boolean;
};

export type PluginNetworkUiAdapterContract = {
  mode: string;
  pluginId: string;
  displayName: string;
  operationNamespace: string;
  operations: {
    connect: string;
    discover: string;
    materials: string;
    materialsEdit: string;
  };
  defaultLocalHostnames: string[];
} & RemoteMaterialSettingsAdapter;

export type PluginMonitoringSnapshotContract = {
  connected: boolean;
  stateText: string;
  isPrinting: boolean;
  isPaused: boolean;
  cancelLatched: boolean;
  pauseLatched: boolean;
  finished: boolean;
  progressPct: number | null;
  currentLayer: number | null;
  totalLayers: number | null;
  plateId: number | null;
  jobName: string | null;
  etaSec: number | null;
};

export type PluginMonitoringWebcamInfoContract = {
  available: boolean;
  streamUrl: string | null;
  snapshotUrl: string | null;
  message: string;
};

export type PluginMonitoringUiAdapterContract = {
  mode: string;
  pluginId: string | null;
  displayName: string;
  available: boolean;
  operations: {
    status: string;
    webcamInfo: string;
    platesList: string;
    start: string;
    deletePlate: string;
    pause: string;
    resume: string;
    cancel: string;
    emergencyStop: string;
  } | null;
  parseStatusPayload: (payload: unknown, contextKey?: string) => PluginMonitoringSnapshotContract;
  parseWebcamInfoPayload: (payload: unknown, host: string, port: number) => PluginMonitoringWebcamInfoContract;
};

export type PluginNetworkOperationHandlerContract = (
  operationPath: string[],
  payload: unknown,
) => Promise<{ status: number; body: unknown }>;

export type PluginSlicingFormatDefinitionContract = {
  id: string;
  outputFormat: string;
  displayName: string;
  ownership: 'core' | 'plugin';
  pluginId?: string;
  rustModulePath: string;
  wasmExportName: string;
  notes?: string;
};

export type ComplexPluginManifestReference = {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
};

export type ComplexPluginCapabilities = {
  networkOperations?: boolean;
  uploadWithProgress?: boolean;
  slicerEncoder?: boolean;
  tauriRuntimePlugin?: boolean;
};

/**
 * PR-1 foundation contract: single plugin definition shape that will become
 * the source of truth for complex plugin registration in later phases.
 */
export type ComplexPluginDefinition = {
  id: string;
  manifest: ComplexPluginManifestReference;
  capabilities?: ComplexPluginCapabilities;
  networkAdaptersByMode?: Record<string, PluginNetworkUiAdapterContract>;
  monitoringAdaptersByMode?: Record<string, PluginMonitoringUiAdapterContract>;
  networkOperationHandler?: PluginNetworkOperationHandlerContract;
  slicingFormatsByOutput?: Record<string, PluginSlicingFormatDefinitionContract>;
};

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
  /**
   * Whether this backend exposes on-device remote material/profile listing and editing.
   * Defaults to true for existing backends when omitted.
   */
  supportsRemoteMaterialProfiles?: boolean;
  /**
   * When set, the Edit button is greyed out and this message is shown on hover.
   * Omit when editing is fully supported.
   */
  remoteMaterialEditingWipNotice?: string;
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
  thumbnailPath?: string | null;
  taskId?: string | null;
  taskStatus?: number | null;
};

export type PluginMonitoringWebcamInfoContract = {
  available: boolean;
  streamUrl: string | null;
  snapshotUrl: string | null;
  message: string;
};

export type PluginMonitoringUiPolicy = {
  /** How long the monitor can keep showing stale online state after the last successful status poll. */
  busyResponseGraceMs?: number;
  /** How many inconclusive reachability polls are allowed before the UI treats a device as offline. */
  inconclusiveReachabilityMaxPolls?: number;
  /** Whether the UI should surface a manual stale-webcam-stream reset action. */
  supportsWebcamStreamSlotReset?: boolean;
  /** How many consecutive webcam failures should trigger a cooldown. */
  webcamMaxConsecutiveTimeouts?: number;
  /** Cooldown after repeated webcam timeouts. */
  webcamTimeoutCooldownMs?: number;
  /** Cooldown after an immediate webcam request failure. */
  webcamFailureCooldownMs?: number;
};

export type PluginMonitoringUiAdapterContract = {
  mode: string;
  pluginId: string | null;
  displayName: string;
  available: boolean;
  operations: {
    status: string;
    webcamInfo: string;
    webcamEnable?: string;
    webcamDisable?: string;
    timelapseEnable?: string;
    timelapseDisable?: string;
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
  getMonitoringUiPolicy?: () => PluginMonitoringUiPolicy;
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
  formatVersions?: Array<{
    value: string;
    label: string;
    isDefault?: boolean;
  }>;
  settingsModes?: Array<{
    value: string;
    label: string;
    isDefault?: boolean;
  }>;
  rustModulePath: string;
  wasmExportName: string;
  notes?: string;
};

export type LocalMaterialFieldKind = 'number' | 'integer' | 'text' | 'boolean' | 'select';

export type LocalMaterialFieldOption = {
  value: string;
  label: string;
};

export type LocalMaterialTabSchema = {
  id: string;
  title: string;
  order?: number;
  description?: string;
};

export type LocalMaterialSectionSchema = {
  id: string;
  title: string;
  tabId?: string;
  order?: number;
  description?: string;
};

export type LocalMaterialCardSchema = {
  id: string;
  title: string;
  tabId?: string;
  sectionId?: string;
  order?: number;
  description?: string;
};

export type LocalMaterialFieldPlacement = {
  /** Preferred tab target for this field (e.g. basic, advanced, custom). */
  tabId?: string;
  /** Optional section grouping under a tab. */
  sectionId?: string;
  /** Optional card grouping within a section/tab (e.g. metadata, print-settings). */
  cardId?: string;
  /** Render order within the destination group. */
  order?: number;
};

/**
 * Declarative local material field schema for file-format-specific settings.
 *
 * These fields are intended for local export profiles (not remote printer APIs)
 * and can be surfaced by UI based on selected output format/plugin.
 */
export type LocalMaterialFieldSchema = {
  key: string;
  label: string;
  kind: LocalMaterialFieldKind;
  defaultValue: number | string | boolean;
  /** Optional short tag rendered by the UI as an inline chip (e.g. Fast/Slow). */
  tag?: string;
  /** Optional accent color for the field chip / highlight. */
  color?: string;
  /** Optional key to render as a two-stage paired input row with this field. */
  splitWithKey?: string;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: LocalMaterialFieldOption[];
  placement?: LocalMaterialFieldPlacement;
  /** Optional metadata path override for serialization (dot notation). */
  metadataPath?: string;
};

export type PluginLocalMaterialSettingsAdapterContract = {
  outputFormat: string;
  displayName?: string;
  /** When true, plugin-defined material fields replace stock local material fields in the UI. */
  replacesDefaultMaterialSettings?: boolean;
  tabs?: LocalMaterialTabSchema[];
  sections?: LocalMaterialSectionSchema[];
  cards?: LocalMaterialCardSchema[];
  fields: LocalMaterialFieldSchema[];
};

/**
 * Optional mode-indexed local material settings contract.
 *
 * Example:
 * {
 *   '.ctb': {
 *     simple: { ...adapter },
 *     twostage: { ...adapter }
 *   }
 * }
 */
export type PluginLocalMaterialSettingsByModeContract =
  Record<string, Record<string, PluginLocalMaterialSettingsAdapterContract>>;

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
  localMaterialSettingsByOutput?: Record<string, PluginLocalMaterialSettingsAdapterContract>;
  localMaterialSettingsByOutputAndMode?: PluginLocalMaterialSettingsByModeContract;
};

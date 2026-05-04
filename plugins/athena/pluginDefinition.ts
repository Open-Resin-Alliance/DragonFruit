import type {
  ComplexPluginDefinition,
  PluginMonitoringUiAdapterContract,
  PluginNetworkUiAdapterContract,
} from '@/features/plugins/complexPluginContracts';
import { ATHENA_PLUGIN_MANIFEST } from './pluginManifest';
import {
  NANODLP_ADVANCED_SECTIONS,
  NANODLP_BASIC_SECTIONS,
  NANODLP_PRIMARY_EDIT_FIELDS,
  denormalizeNanodlpEditDraftForBackend,
  getNanoDlpFieldHelpText,
  isNanoDlpDynamicWaitEnabled,
  resolveNanodlpEditDraftFromMeta,
  resolveNanoDlpAdvancedSectionId,
  resolveNanodlpMaterialProcessValues,
} from './nanodlp';
import {
  resolveNanodlpMonitoringSnapshot,
  resolveNanodlpWebcamFeedInfo,
} from './network';
import { ATHENA_NANODLP_FORMAT_DEFINITION } from './slicing/nanodlpFormatDefinition';

const ATHENA_NANODLP_NETWORK_ADAPTER: PluginNetworkUiAdapterContract = {
  mode: 'nanodlp',
  pluginId: 'athena',
  displayName: 'NanoDLP',
  operationNamespace: 'nanodlp',
  operations: {
    connect: 'nanodlp/connect',
    discover: 'nanodlp/discover',
    materials: 'nanodlp/materials',
    materialsEdit: 'nanodlp/materials/edit',
  },
  defaultLocalHostnames: ['nanodlp.local', 'athena.local', 'printer.local', 'resin.local'],
  remoteMaterialEditingWipNotice: 'Remote material editing for NanoDLP is not yet available.',
  primaryEditFields: NANODLP_PRIMARY_EDIT_FIELDS,
  basicSections: NANODLP_BASIC_SECTIONS,
  advancedSections: NANODLP_ADVANCED_SECTIONS,
  resolveEditDraftFromMeta: resolveNanodlpEditDraftFromMeta,
  resolveMaterialProcessValues: resolveNanodlpMaterialProcessValues,
  denormalizeEditDraftForBackend: denormalizeNanodlpEditDraftForBackend,
  resolveAdvancedSectionId: resolveNanoDlpAdvancedSectionId,
  getFieldHelpText: getNanoDlpFieldHelpText,
  isDynamicWaitEnabled: isNanoDlpDynamicWaitEnabled,
};

const ATHENA_NANODLP_MONITORING_ADAPTER: PluginMonitoringUiAdapterContract = {
  mode: 'nanodlp',
  pluginId: 'athena',
  displayName: 'Athena Monitoring',
  available: true,
  operations: {
    status: 'nanodlp/printer/status',
    webcamInfo: 'nanodlp/printer/webcam/info',
    platesList: 'nanodlp/plates/list/json',
    start: 'nanodlp/printer/start',
    deletePlate: 'nanodlp/plate/delete',
    pause: 'nanodlp/printer/pause',
    resume: 'nanodlp/printer/unpause',
    cancel: 'nanodlp/printer/stop',
    emergencyStop: 'nanodlp/printer/force-stop',
  },
  parseStatusPayload: (payload: unknown, contextKey?: string) => resolveNanodlpMonitoringSnapshot(payload, contextKey),
  parseWebcamInfoPayload: (payload: unknown, host: string, port: number) => resolveNanodlpWebcamFeedInfo(payload, host, port),
};

export const ATHENA_COMPLEX_PLUGIN_DEFINITION: ComplexPluginDefinition = {
  id: 'athena',
  manifest: ATHENA_PLUGIN_MANIFEST,
  capabilities: {
    networkOperations: true,
    uploadWithProgress: true,
    slicerEncoder: true,
    tauriRuntimePlugin: true,
  },
  networkAdaptersByMode: {
    [ATHENA_NANODLP_NETWORK_ADAPTER.mode]: ATHENA_NANODLP_NETWORK_ADAPTER,
  },
  monitoringAdaptersByMode: {
    [ATHENA_NANODLP_MONITORING_ADAPTER.mode]: ATHENA_NANODLP_MONITORING_ADAPTER,
  },
  slicingFormatsByOutput: {
    [ATHENA_NANODLP_FORMAT_DEFINITION.outputFormat]: ATHENA_NANODLP_FORMAT_DEFINITION,
  },
};

export default ATHENA_COMPLEX_PLUGIN_DEFINITION;

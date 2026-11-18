import type { SlicingFormatDefinition } from '@/features/slicing/formats/types';

export const CXDLPV4_FORMAT_DEFINITION: SlicingFormatDefinition = {
  id: 'cxdlpv4',
  outputFormat: '.cxdlpv4',
  displayName: 'Creality CXDLPV4 (.cxdlpv4)',
  ownership: 'plugin',
  layerDataKind: 'raw-mask',
  pluginId: 'creality',
  settingsModes: [
    { value: 'simple', label: 'Simple', isDefault: true },
    { value: 'twostage', label: 'Two-Stage' },
    { value: 'allfields', label: 'All Fields' },
  ],
  rustModulePath: 'plugins/creality/slicing/rust/encoder_impl.rs',
  wasmExportName: 'encode_cxdlpv4',
};

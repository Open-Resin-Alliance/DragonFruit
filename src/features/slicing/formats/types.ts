import type { MaterialProfile, PrinterOutputFormat, PrinterProfile } from '@/features/profiles/profileStore';

export type SlicingFormatOwnership = 'core' | 'plugin';

export type SlicingFormatVersionOption = {
  value: string;
  label: string;
  isDefault?: boolean;
};

export type SlicingSettingsModeOption = {
  value: string;
  label: string;
  isDefault?: boolean;
};

export type SlicingFormatDefinition = {
  id: string;
  outputFormat: PrinterOutputFormat;
  displayName: string;
  ownership: SlicingFormatOwnership;
  layerDataKind: 'png' | 'raw-mask';
  pluginId?: string;
  formatVersions?: SlicingFormatVersionOption[];
  settingsModes?: SlicingSettingsModeOption[];
  rustModulePath: string;
  wasmExportName: string;
  notes?: string;
};

export type ResolveSlicingFormatContext = {
  printerProfile: PrinterProfile;
  materialProfile: MaterialProfile;
};

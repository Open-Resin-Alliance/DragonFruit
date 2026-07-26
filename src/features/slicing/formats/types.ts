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

export type SlicingXPackingStrategy = 'none' | 'bitdepth-packed-x';

export type SlicingFormatDefinition = {
  id: string;
  outputFormat: PrinterOutputFormat;
  displayName: string;
  ownership: SlicingFormatOwnership;
  layerDataKind: 'png' | 'raw-mask';
  pluginId?: string;
  xPackingStrategy?: SlicingXPackingStrategy;
  formatVersions?: SlicingFormatVersionOption[];
  /** When true, the selected formatVersion value is used as the output file extension
   *  instead of outputFormat. For formats whose outputFormat is a canonical container
   *  (e.g. .aff/.azf) while each printer variant has its own native extension. */
  fileExtensionFromVersion?: boolean;
  settingsModes?: SlicingSettingsModeOption[];
  rustModulePath: string;
  wasmExportName: string;
  notes?: string;
};

export type ResolveSlicingFormatContext = {
  printerProfile: PrinterProfile;
  materialProfile: MaterialProfile;
};

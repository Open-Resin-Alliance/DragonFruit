import type { MaterialProfile, PrinterOutputFormat, PrinterProfile } from '@/features/profiles/profileStore';

export type SlicingFormatOwnership = 'core' | 'plugin';

export type SlicingFormatDefinition = {
  id: string;
  outputFormat: PrinterOutputFormat;
  displayName: string;
  ownership: SlicingFormatOwnership;
  pluginId?: string;
  rustModulePath: string;
  wasmExportName: string;
  notes?: string;
};

export type ResolveSlicingFormatContext = {
  printerProfile: PrinterProfile;
  materialProfile: MaterialProfile;
};

import type { PrinterOutputFormat } from '@/features/profiles/profileStore';
import type { ResolveSlicingFormatContext, SlicingFormatDefinition } from './types';
import { ATHENA_NANODLP_FORMAT_DEFINITION } from '../../../../plugins/athena/slicing/nanodlpFormatDefinition';

const CORE_GOO_FORMAT_DEFINITION: SlicingFormatDefinition = {
  id: 'core.goo.v1',
  outputFormat: '.goo',
  displayName: 'GOO (Core Placeholder)',
  ownership: 'core',
  rustModulePath: 'formats::goo',
  wasmExportName: 'encode_goo_container',
  notes: 'Placeholder format definition. Rust encoder scaffold only.',
};

const CORE_LUMEN_FORMAT_DEFINITION: SlicingFormatDefinition = {
  id: 'core.lumen.v1',
  outputFormat: '.lumen',
  displayName: 'Lumen (Core Placeholder)',
  ownership: 'core',
  rustModulePath: 'formats::lumen',
  wasmExportName: 'encode_lumen_container',
  notes: 'Placeholder format definition. Rust encoder scaffold only.',
};

const FALLBACK_BY_OUTPUT_FORMAT: Record<PrinterOutputFormat, SlicingFormatDefinition> = {
  '.nanodlp': ATHENA_NANODLP_FORMAT_DEFINITION,
  '.goo': CORE_GOO_FORMAT_DEFINITION,
  '.lumen': CORE_LUMEN_FORMAT_DEFINITION,
};

export function resolveSlicingFormatDefinition(context: ResolveSlicingFormatContext): SlicingFormatDefinition {
  const format = context.printerProfile.display.outputFormat;

  if (format === '.nanodlp' && context.printerProfile.networkSupport === 'nanodlp') {
    return ATHENA_NANODLP_FORMAT_DEFINITION;
  }

  return FALLBACK_BY_OUTPUT_FORMAT[format];
}

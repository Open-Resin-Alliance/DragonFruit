import type {
  ComplexPluginDefinition,
  MaterialSettingsSource,
  PluginLocalMaterialSettingsAdapterContract,
} from '@/features/plugins/complexPluginContracts';
import { resolveDifferentialMaterialSettings } from '@/features/plugins/resolveDifferentialSettings';
import { CREALITY_PLUGIN_MANIFEST } from './pluginManifest';
import { CXDLPV4_FORMAT_DEFINITION } from './slicing/cxdlpv4FormatDefinition';
import simpleSettingsSchema from './materialSettings/settings_simple.json';
import twoStageSettingsDiff from './materialSettings/settings_twostage.diff.json';
import allFieldsSettingsDiff from './materialSettings/settings_allfields.diff.json';

const ALL_MODES: Record<string, MaterialSettingsSource> = {
  simple: simpleSettingsSchema as MaterialSettingsSource,
  twostage: twoStageSettingsDiff as MaterialSettingsSource,
  allfields: allFieldsSettingsDiff as MaterialSettingsSource,
};

function resolveMode(mode: string): PluginLocalMaterialSettingsAdapterContract {
  return {
    outputFormat: '.cxdlpv4',
    ...resolveDifferentialMaterialSettings(ALL_MODES[mode], ALL_MODES),
  };
}

const simpleAdapter = resolveMode('simple');
const twoStageAdapter = resolveMode('twostage');
const allFieldsAdapter = resolveMode('allfields');

export const CREALITY_PLUGIN_DEFINITION: ComplexPluginDefinition = {
  id: 'creality',
  manifest: CREALITY_PLUGIN_MANIFEST,
  capabilities: {
    slicerEncoder: true,
  },
  slicingFormatsByOutput: {
    '.cxdlpv4': CXDLPV4_FORMAT_DEFINITION,
  },
  localMaterialSettingsByOutput: {
    '.cxdlpv4': simpleAdapter,
  },
  localMaterialSettingsByOutputAndMode: {
    '.cxdlpv4': {
      simple: simpleAdapter,
      twostage: twoStageAdapter,
      allfields: allFieldsAdapter,
    },
  },
};

export default CREALITY_PLUGIN_DEFINITION;

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { Unit } from '@/utils/unitFormatting';
import type { LayerSettingField } from './layerSettingsRanges';

type Translate = (descriptor: MessageDescriptor, values?: Record<string, unknown>) => string;

export const LAYER_SETTING_LABELS = {
  exposureSec: msg`Exposure`,
  lightOffDelaySec: msg`Light-off delay`,
  waitTimeBeforeCureSec: msg`Wait before cure`,
  waitTimeAfterCureSec: msg`Wait after cure`,
  waitTimeAfterLiftSec: msg`Wait after lift`,
  liftHeightMm: msg`Total lift travel`,
  liftHeight2Mm: msg`Stage 2 lift travel`,
  liftSpeedMmMin: msg`Lift speed`,
  liftSpeed2MmMin: msg`Stage 2 lift speed`,
  retractHeightMm: msg`Total retract travel`,
  retractHeight2Mm: msg`Stage 2 retract travel`,
  retractSpeedMmMin: msg`Retract speed`,
  retractSpeed2MmMin: msg`Stage 2 retract speed`,
  lightPwm: msg`Light PWM`,
} satisfies Record<LayerSettingField, MessageDescriptor>;

export const LAYER_SETTING_UNITS = {
  exposureSec: 's',
  lightOffDelaySec: 's',
  waitTimeBeforeCureSec: 's',
  waitTimeAfterCureSec: 's',
  waitTimeAfterLiftSec: 's',
  liftHeightMm: 'mm',
  liftHeight2Mm: 'mm',
  liftSpeedMmMin: 'mmPerMin',
  liftSpeed2MmMin: 'mmPerMin',
  retractHeightMm: 'mm',
  retractHeight2Mm: 'mm',
  retractSpeedMmMin: 'mmPerMin',
  retractSpeed2MmMin: 'mmPerMin',
  lightPwm: null,
} satisfies Record<LayerSettingField, Unit | null>;

// Keep interpolated messages outside React Compiler's component/hook transforms.
export function formatLayerSettingsRangeBounds(translate: Translate, start: string, end: string): string {
  return translate(msg`Layers ${start}–${end}`);
}

export function formatUnsupportedLayerSetting(
  translate: Translate,
  selectedFormat: string,
  bounds: string,
  field: string,
): string {
  return translate(msg`${selectedFormat}: ${bounds} cannot override ${field}. The selected format cannot encode this layer setting. Remove the override or select a supported printer.`);
}

export function formatLayerSettingsEncodingError(translate: Translate, details: string): string {
  return translate(msg`Layer settings ranges could not be encoded: ${details}`);
}

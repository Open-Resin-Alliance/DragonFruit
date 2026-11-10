import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalMaterialFieldSchema, MaterialSettingsSource } from '@/features/plugins/complexPluginContracts';
import { resolveDifferentialMaterialSettings } from '@/features/plugins/resolveDifferentialSettings';
import { resolveLayerSettingsFields } from '../formats/layerSettingsFields';
import type { SlicingFormatDefinition } from '../formats/types';
import { resolveLayerSettingsMaterialRows, type LayerSettingsMaterialRow } from '../layerSettingsMaterialFields';
import { LAYER_SETTING_FIELDS } from '../layerSettingsRanges';

function field(key: string, overrides: Partial<LocalMaterialFieldSchema> = {}): LocalMaterialFieldSchema {
  return { key, label: key, kind: 'number', defaultValue: 1, perLayerEditable: true, ...overrides };
}

function bindings(rows: readonly LayerSettingsMaterialRow[]): string[][] {
  return rows.map((row) => row.controls.map((control) => control.field));
}

test('Simple, Two-stage and Tilting adapters expose their resolved material-mode controls', () => {
  const modes: Record<string, MaterialSettingsSource> = {
    Simple: {
      fields: [
        field('exposureSec'),
        field('liftDistanceMm', { perLayerField: 'liftHeightMm' }),
        field('liftSpeedMmMin'),
      ],
    },
    'Two-stage': {
      $inherit: 'Simple',
      fields: [
        field('liftDistanceMm', { perLayerField: 'liftHeightMm', splitWithKey: 'liftDistance2Mm' }),
        field('liftDistance2Mm', { perLayerField: 'liftHeight2Mm' }),
        field('liftSpeedMmMin', { splitWithKey: 'liftSpeed2MmMin' }),
        field('liftSpeed2MmMin'),
      ],
    },
    Tilting: {
      $inherit: 'Two-stage',
      $remove: { fields: ['liftDistance2Mm', 'liftSpeed2MmMin'] },
      fields: [
        field('liftDistanceMm', { perLayerField: 'liftHeightMm', disabled: true }),
        field('liftSpeedMmMin', { disabled: true }),
        field('waitTimeBeforeCureSec'),
      ],
    },
  };
  const resolve = (mode: string) => bindings(resolveLayerSettingsMaterialRows(
    resolveDifferentialMaterialSettings(modes[mode], modes), LAYER_SETTING_FIELDS,
  ));
  assert.deepEqual(resolve('Simple'), [['exposureSec'], ['liftHeightMm'], ['liftSpeedMmMin']]);
  assert.deepEqual(resolve('Two-stage'), [
    ['exposureSec'], ['liftHeightMm', 'liftHeight2Mm'], ['liftSpeedMmMin', 'liftSpeed2MmMin'],
  ]);
  assert.deepEqual(resolve('Tilting'), [['exposureSec'], ['waitTimeBeforeCureSec']]);
});

test('only explicitly opted-in, enabled numeric canonical bindings become controls', () => {
  const exposure = field('exposureSec', { min: 0.1, max: 30, step: 0.1 });
  const pwm = field('vendorPwm', { kind: 'integer', perLayerField: 'lightPwm' });
  const rows = resolveLayerSettingsMaterialRows({ fields: [
    field('lightOffDelaySec', { perLayerEditable: undefined }),
    field('waitTimeAfterCureSec', { perLayerEditable: false }),
    field('liftHeightMm', { disabled: true }),
    field('retractHeightMm', { kind: 'text' }),
    field('retractSpeedMmMin', { kind: 'select' }),
    field('waitTimeBeforeCureSec', { kind: 'boolean' }),
    field('waitTimeAfterLiftSec', { kind: 'spacer' }),
    field('unknown'),
    field('liftSpeedMmMin', { perLayerField: 'notCanonical' }),
    exposure,
    pwm,
  ] }, LAYER_SETTING_FIELDS);
  assert.deepEqual(bindings(rows), [['exposureSec'], ['lightPwm']]);
  assert.equal(rows[0].controls[0].schema, exposure);
  assert.equal(rows[1].controls[0].schema, pwm);
  assert.deepEqual(resolveLayerSettingsMaterialRows(null, LAYER_SETTING_FIELDS), []);
  assert.deepEqual(resolveLayerSettingsMaterialRows(undefined, LAYER_SETTING_FIELDS), []);
});

test('format-version capabilities intersect the material schema without adding hidden controls', () => {
  const definition: SlicingFormatDefinition = {
    id: 'test', outputFormat: '.test', displayName: 'Test', ownership: 'plugin',
    layerDataKind: 'png', rustModulePath: '', wasmExportName: '',
    layerSettingsFields: LAYER_SETTING_FIELDS,
    formatVersions: [
      { value: 'v1', label: 'First', layerSettingsFields: ['exposureSec', 'liftHeightMm'] },
      { value: 'v2', label: 'Second', layerSettingsFields: ['exposureSec', 'liftHeightMm', 'liftHeight2Mm', 'lightPwm'] },
    ],
  };
  const adapter = { fields: [
    field('liftHeightMm', { splitWithKey: 'liftHeight2Mm' }),
    field('liftHeight2Mm'),
    field('exposureSec'),
  ] };
  assert.deepEqual(bindings(resolveLayerSettingsMaterialRows(adapter, resolveLayerSettingsFields(definition, 'v1'))), [
    ['liftHeightMm'], ['exposureSec'],
  ]);
  assert.deepEqual(bindings(resolveLayerSettingsMaterialRows(adapter, resolveLayerSettingsFields(definition, 'v2'))), [
    ['liftHeightMm', 'liftHeight2Mm'], ['exposureSec'],
  ]);
  assert.deepEqual(resolveLayerSettingsMaterialRows(adapter, []), []);
});

test('adding an opted-in field through JSON alone adds the corresponding control', () => {
  const adapter: { fields: LocalMaterialFieldSchema[] } = JSON.parse(JSON.stringify({ fields: [
    field('exposureSec'),
    field('customWait', { perLayerField: 'waitTimeAfterLiftSec' }),
  ] }));
  assert.deepEqual(bindings(resolveLayerSettingsMaterialRows(adapter, LAYER_SETTING_FIELDS)), [
    ['exposureSec'], ['waitTimeAfterLiftSec'],
  ]);
});

test('source declarations pair compatible controls, not a fixed motion row list', () => {
  const adapter = { fields: [
    field('waitTimeBeforeCureSec', { splitWithKey: 'waitTimeAfterCureSec' }),
    field('waitTimeAfterCureSec'),
    field('liftHeightMm'),
    field('liftHeight2Mm'),
    field('retractHeightMm', { splitWithKey: 'missing' }),
  ] };
  assert.deepEqual(bindings(resolveLayerSettingsMaterialRows(adapter, LAYER_SETTING_FIELDS)), [
    ['waitTimeBeforeCureSec', 'waitTimeAfterCureSec'],
    ['liftHeightMm'], ['liftHeight2Mm'], ['retractHeightMm'],
  ]);
});

test('unselected or dimensionally incompatible companions never enter a pair', () => {
  const adapter = { fields: [
    field('liftHeightMm', { splitWithKey: 'liftHeight2Mm' }),
    field('liftHeight2Mm', { perLayerEditable: false }),
    field('retractHeightMm', { splitWithKey: 'retractHeight2Mm' }),
    field('retractHeight2Mm', { disabled: true }),
    field('liftSpeedMmMin', { splitWithKey: 'exposureSec' }),
    field('exposureSec', { splitWithKey: 'lightPwm' }),
    field('lightPwm', { kind: 'integer' }),
  ] };
  assert.deepEqual(bindings(resolveLayerSettingsMaterialRows(adapter, LAYER_SETTING_FIELDS)), [
    ['liftHeightMm'], ['retractHeightMm'], ['liftSpeedMmMin'], ['exposureSec'], ['lightPwm'],
  ]);
});

test('reversed array order preserves declaration columns and emits each selected binding once', () => {
  const firstStage2 = field('stage2', { perLayerField: 'liftHeight2Mm' });
  const total = field('total', { perLayerField: 'liftHeightMm', splitWithKey: 'stage2' });
  const rows = resolveLayerSettingsMaterialRows({ fields: [
    firstStage2,
    field('exposureSec'),
    total,
    field('duplicateStage2', { perLayerField: 'liftHeight2Mm' }),
    field('duplicateTotal', { perLayerField: 'liftHeightMm', splitWithKey: 'exposureSec' }),
  ] }, LAYER_SETTING_FIELDS);
  assert.deepEqual(bindings(rows), [['liftHeightMm', 'liftHeight2Mm'], ['exposureSec']]);
  assert.equal(rows[0].controls[0].schema, total);
  assert.equal(rows[0].controls[1].schema, firstStage2);
});

test('deduplication cannot substitute a different source for a declared companion', () => {
  const adapter = { fields: [
    field('chosenStage2', { perLayerField: 'liftHeight2Mm' }),
    field('liftHeightMm', { splitWithKey: 'duplicateStage2' }),
    field('duplicateStage2', { perLayerField: 'liftHeight2Mm' }),
  ] };
  assert.deepEqual(bindings(resolveLayerSettingsMaterialRows(adapter, LAYER_SETTING_FIELDS)), [
    ['liftHeight2Mm'], ['liftHeightMm'],
  ]);
});

test('material placement order is stable within groups and leaves source arrays untouched', () => {
  const fields = [
    field('liftHeightMm', { placement: { cardId: 'motion', order: 20 } }),
    field('exposureSec', { placement: { cardId: 'light', order: 1 } }),
    field('liftSpeedMmMin', { placement: { cardId: 'motion', order: 10 } }),
    field('retractSpeedMmMin', { placement: { cardId: 'motion', order: 10 } }),
  ];
  const original = fields.slice();
  assert.deepEqual(bindings(resolveLayerSettingsMaterialRows({ fields }, LAYER_SETTING_FIELDS)), [
    ['liftSpeedMmMin'], ['retractSpeedMmMin'], ['liftHeightMm'], ['exposureSec'],
  ]);
  assert.deepEqual(fields, original);
});

test('mutual and competing pair declarations cannot render any control twice', () => {
  assert.deepEqual(bindings(resolveLayerSettingsMaterialRows({ fields: [
    field('liftHeightMm', { splitWithKey: 'liftHeight2Mm' }),
    field('liftHeight2Mm', { splitWithKey: 'liftHeightMm' }),
    field('retractHeightMm', { splitWithKey: 'liftHeight2Mm' }),
  ] }, LAYER_SETTING_FIELDS)), [['liftHeightMm', 'liftHeight2Mm'], ['retractHeightMm']]);
});

'use client';

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { SquareStack } from 'lucide-react';
import { SegmentedControl, SettingRow } from '@/components/atoms';
import { NumberInput } from '@/components/ui/NumberInput';
import { MAX_FIXED_PLATE_COLUMNS } from '@/features/scene/plates/plateCascade';
import {
  getMultiPlateSettingsSnapshot,
  saveMultiPlateSettings,
  subscribeToMultiPlateSettings,
  type MultiPlateSettings,
} from '@/components/settings/multiPlatePreferences';

export function MultiPlateSettingsTab() {
  const { _ } = useLingui();
  const [settings, setSettings] = React.useState<MultiPlateSettings>(() => getMultiPlateSettingsSnapshot());

  React.useEffect(
    () => subscribeToMultiPlateSettings(() => setSettings(getMultiPlateSettingsSnapshot())),
    [],
  );

  const followLandedPlateLabel = _(msg`Follow the plate a model lands on`);
  const plateOrderingLabel = _(msg`Plate Ordering`);

  return (
    <section
      className="rounded-lg border p-3"
      style={{
        background: 'var(--surface-1)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      <div className="flex items-start gap-2">
        <span
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
          style={{
            borderColor: 'var(--border-subtle)',
            background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
          }}
        >
          <SquareStack className="h-4 w-4" style={{ color: 'var(--accent)' }} />
        </span>
        <div className="flex-1">
          <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
            {_(msg`Plates`)}
          </h3>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {_(msg`Behaviour across the beds of a scene.`)}
          </p>
        </div>
      </div>

      <SettingRow
        bordered
        className="mt-3"
        label={followLandedPlateLabel}
        description={_(msg`A model dropped on another bed makes that bed the one you work on.`)}
      >
        <SegmentedControl
          label={followLandedPlateLabel}
          options={[
            { value: 'on', label: _(msg`ON`) },
            { value: 'off', label: _(msg`OFF`) },
          ]}
          value={settings.followLandedPlate ? 'on' : 'off'}
          onChange={(next) => setSettings(saveMultiPlateSettings({ followLandedPlate: next === 'on' }))}
        />
      </SettingRow>

      <SettingRow
        bordered
        className="mt-3"
        label={plateOrderingLabel}
        description={_(msg`Growing grid, or a fixed row length.`)}
      >
        <SegmentedControl
          label={plateOrderingLabel}
          options={[
            { value: 'fixed', label: _(msg({ message: 'Fixed', context: 'Plate ordering mode: a fixed number of beds per row.' })) },
            { value: 'dynamic', label: _(msg({ message: 'Dynamic', context: 'Plate ordering mode: a grid that grows to stay square.' })) },
          ]}
          value={settings.plateOrdering}
          onChange={(next) => setSettings(saveMultiPlateSettings({ plateOrdering: next === 'fixed' ? 'fixed' : 'dynamic' }))}
        />
      </SettingRow>

      {settings.plateOrdering === 'fixed' && (
        <SettingRow
          bordered
          className="mt-3"
          label={_(msg`Beds per row`)}
          description={_(msg`1-2-3-4 across, then the next row. Adding a bed never moves the ones already placed.`)}
        >
          <NumberInput
            min={1}
            max={MAX_FIXED_PLATE_COLUMNS}
            step={1}
            value={settings.fixedPlateColumns}
            onChange={(next) => {
              if (!Number.isFinite(next)) return;
              setSettings(saveMultiPlateSettings({ fixedPlateColumns: next }));
            }}
            className="ui-input h-[34px] w-[120px] py-1.5 pl-2.5 pr-5 text-sm"
          />
        </SettingRow>
      )}
    </section>
  );
}

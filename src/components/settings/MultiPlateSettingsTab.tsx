'use client';

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { SquareStack } from 'lucide-react';
import { SegmentedControl, SettingRow } from '@/components/atoms';
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
    </section>
  );
}

"use client";

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { SelectDropdown } from '@/components/ui/SelectDropdown';
import { Tooltip } from '@/components/ui/Tooltip';
import { FieldHelpTooltip } from '@/components/settings/profileFormAtoms';
import type { AutoSupportSettings, NormalSynthesisPreset } from '@/supports/autoSupport';
import { LOCKED_PROFILE_HINT, NORMAL_PRESET_FIELD } from './autoSupportPanelTabs';

type AutoSupportNormalPresetFieldProps = {
  draft: AutoSupportSettings;
  setDraft: React.Dispatch<React.SetStateAction<AutoSupportSettings>>;
  presetLocked?: boolean;
};

export function AutoSupportNormalPresetField({
  draft,
  setDraft,
  presetLocked = false,
}: AutoSupportNormalPresetFieldProps) {
  const { _ } = useLingui();

  const disabled = presetLocked || !draft.smoothContactNormals;
  const label = _(NORMAL_PRESET_FIELD.label);
  const hint = _(NORMAL_PRESET_FIELD.hint);
  const help = presetLocked
    ? _(LOCKED_PROFILE_HINT)
    : !draft.smoothContactNormals
      ? _(msg`Enable Smooth Contact Normals to choose a normal synthesis preset.`)
      : hint;

  const options: Array<{ value: NormalSynthesisPreset; label: string }> = [
    { value: 'bisector', label: _(msg`Bisector (125°)`) },
    { value: 'crease-lock', label: _(msg`Crease-Lock (55°)`) },
    { value: 'macro-smooth', label: _(msg`Macro-Smooth`) },
  ];

  const field = (
    <div className="space-y-1 min-w-0">
      <span className="ui-label font-medium inline-flex items-center gap-1.5">
        {label}
        <FieldHelpTooltip label={label} help={help} />
      </span>
      <SelectDropdown
        value={draft.normalSynthesisPreset}
        options={options}
        onChange={(preset) => setDraft((current) => ({ ...current, normalSynthesisPreset: preset }))}
        ariaLabel={label}
        title={presetLocked ? undefined : help}
        disabled={disabled}
        className="space-y-0"
        selectClassName="w-full h-[36px] pl-2.5 pr-10 leading-tight text-[12px]"
      />
    </div>
  );

  if (!presetLocked) return field;
  return <Tooltip content={help} fullWidth wrapperClassName="w-full [&>*]:w-full">{field}</Tooltip>;
}

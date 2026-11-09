"use client";

/**
 * The Auto Support panel's run-policy selector: every preset the store holds —
 * the `Light` / `Medium` / `Heavy` built-ins *and* the custom profiles a user
 * saved — as one dropdown.
 *
 * The panel used to render one button per built-in, which is why a profile a user
 * had saved could not be picked from there at all: the row was built from
 * `filter(isBuiltIn)`.
 *
 * Deliberately presentational and store-free, like the dialog's body: the
 * collection and the active id arrive as props, which is what lets the option list
 * and the trigger be asserted without a DOM. Selecting one goes through
 * `selectAutoSupportPreset`, the same path the dialog's strip uses, so both
 * surfaces agree on what applying a preset means.
 */
import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { CENTERED_SELECT_PADDING, SelectDropdown } from '@/components/ui/SelectDropdown';
import { translateAutoSupportPresetName, NO_ACTIVE_PRESET_LABEL } from '@/supports/Settings/autoSupportPresetMessages';
import type { AutoSupportPreset } from '@/supports/Settings/autoSupportPresets';

type Translate = (descriptor: MessageDescriptor) => string;

export type AutoSupportPresetOption = {
  value: string;
  label: string;
  disabled?: boolean;
  rightContent: string;
};

/**
 * The rows the selector offers, in the store's order: built-ins first, then the
 * user's own, as `getAutoSupportPresetsSnapshot` keeps them.
 *
 * The right-hand fact is the preset's origin, which is what tells the two kinds
 * apart in a list of same-shaped names — that a built-in cannot be saved over or
 * deleted is the store's rule, and the dropdown is where a user finds out which
 * rows it applies to.
 *
 * With nothing selected the list gains a disabled row naming that state, because
 * the trigger renders the selected option's label: without a row to match, an
 * unselected panel would show an empty box. That is the same row, and the same
 * message, the dialog's strip uses.
 */
export function autoSupportPresetOptions(
  presets: readonly AutoSupportPreset[],
  activeId: string | null,
  translate: Translate,
): AutoSupportPresetOption[] {
  const rows = presets.map((preset) => ({
    value: preset.id,
    label: translateAutoSupportPresetName(preset, translate),
    rightContent: preset.isBuiltIn ? translate(msg`Built-in`) : translate(msg`Custom`),
  }));

  return activeId
    ? rows
    : [{ value: '', label: translate(NO_ACTIVE_PRESET_LABEL), disabled: true, rightContent: '' }, ...rows];
}

type AutoSupportPresetSelectProps = {
  /** The store's collection, as the panel subscribes to it. */
  presets: readonly AutoSupportPreset[];
  /** The store's active preset id — the fact the trigger shows, never a guess
   *  made by matching the live block against each preset. */
  activeId: string | null;
  onSelect: (id: string) => void;
  /** What the active preset *is*, e.g. a built-in tier's hint. Substituted for
   *  the generic tooltip, since a dropdown cannot carry a hint per row. */
  activeHint?: MessageDescriptor;
};

export function AutoSupportPresetSelect({ presets, activeId, onSelect, activeHint }: AutoSupportPresetSelectProps) {
  const { _ } = useLingui();

  return (
    <SelectDropdown
      value={activeId ?? ''}
      options={autoSupportPresetOptions(presets, activeId, _)}
      onChange={onSelect}
      ariaLabel={_(msg`Auto-support preset`)}
      title={activeHint ? _(activeHint) : _(msg`Apply this preset to the auto-support settings`)}
      className="space-y-0"
      selectClassName="w-full !h-8 leading-tight text-[12px]"
      // The Auto Orientation panel's objective dropdown is the theme this follows:
      // the lighter surface-1 fill rather than the input's own. Centring comes from
      // `CENTERED_SELECT_PADDING`, which also keeps the chevron clear.
      selectStyle={{ background: 'var(--surface-1)', ...CENTERED_SELECT_PADDING }}
      menuClassName="max-w-[26rem]"
    />
  );
}

"use client";

/**
 * The Sizing Tier control: the Support Studio preset whose tip, shaft and roots
 * numbers size an auto-support run.
 *
 * This file is the seam where the two preset systems meet, and it is the only
 * place the auto-support dialog reads Support Studio's collection. The user's
 * decision (see `docs/dev/backlog.md`): the tier is *derived* from a manual
 * preset rather than kept as auto-support's own data, so editing a manual preset
 * changes what auto-support prints. Auto-support borrows the band and nothing
 * else — the preset is never written here, and the id it stores is an open id
 * that may name a preset the user has since deleted.
 */
import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { SelectDropdown } from '@/components/ui/SelectDropdown';
import { Tooltip } from '@/components/ui/Tooltip';
import { FieldHelpTooltip } from '@/components/settings/profileFormAtoms';
import {
  ANCHOR_PRESET,
  DETAIL_PRESET,
  STRUCTURE_PRESET,
  getPresetList,
  subscribeToPresets,
} from '@/supports/Settings/presets';
import type { SupportPreset } from '@/supports/Settings/types';
import { LOCKED_PROFILE_HINT, SIZING_TIER_FIELD } from './autoSupportPanelTabs';
import type { AutoSupportSettings } from '@/supports/autoSupport';

/**
 * The factory presets, by id: Support Studio marks them by their reserved ids
 * (`detail` / `structure` / `anchor`), not by a flag on the record.
 */
const FACTORY_TIER_IDS = new Set([DETAIL_PRESET.id, STRUCTURE_PRESET.id, ANCHOR_PRESET.id]);

/**
 * The store builds a fresh array on every `getPresetList()` call, which
 * `useSyncExternalStore` reads as "the snapshot changed" on every render — an
 * endless render loop. One cached list per notification is the fix, and it keeps
 * the read side of this coupling inside this module.
 */
let studioPresetsSnapshot: SupportPreset[] | null = null;

function readStudioPresets(): SupportPreset[] {
  studioPresetsSnapshot ??= getPresetList();
  return studioPresetsSnapshot;
}

// Registered once for the app's lifetime: the store's listener set is global
// anyway, and the cache has to be dropped for the next read.
subscribeToPresets(() => {
  studioPresetsSnapshot = null;
});

/**
 * The Support Studio presets, factory first, as the store keeps them. Subscribed
 * rather than read once: a rename or a new manual preset has to show up in the
 * control, and in the auto-support preset rows that name a tier.
 */
export function useSupportStudioPresets(): SupportPreset[] {
  return React.useSyncExternalStore(subscribeToPresets, readStudioPresets, readStudioPresets);
}

/**
 * The name of the preset an auto-support block names, for a row label. Falls back
 * to the factory `structure` preset's name — the same fallback the engine sizes
 * with when the id resolves to nothing — and to the raw id if even that is
 * missing, so a broken reference is visible rather than silent.
 */
export function sizingTierName(id: string, presets: readonly SupportPreset[]): string {
  const named = presets.find((preset) => preset.id === id);
  if (named) return named.name;
  const fallback = presets.find((preset) => preset.id === 'structure');
  return fallback ? fallback.name : id;
}

type AutoSupportSizingTierFieldProps = {
  /** The dialog's draft — the tier id the control shows and writes. */
  draft: AutoSupportSettings;
  setDraft: React.Dispatch<React.SetStateAction<AutoSupportSettings>>;
  /** Locked while the active auto-support preset is a built-in: the tier is part of
   *  the block a built-in refuses to have saved over. */
  disabled?: boolean;
};

export function AutoSupportSizingTierField({ draft, setDraft, disabled = false }: AutoSupportSizingTierFieldProps) {
  const { _ } = useLingui();
  const presets = useSupportStudioPresets();

  const label = _(SIZING_TIER_FIELD.label);
  const hint = _(SIZING_TIER_FIELD.hint);
  // Locked, the tier's help is the lock's, and the browser's own `title` is left off
  // so the app's tooltip is the only one that appears.
  const help = disabled ? _(LOCKED_PROFILE_HINT) : hint;

  const field = (
    <div className="col-span-2 space-y-1">
      <span className="ui-label font-medium inline-flex items-center gap-1.5">
        {label}
        <FieldHelpTooltip label={label} help={help} />
      </span>
      <SelectDropdown
        value={draft.sizingPreset}
        options={presets.map((preset) => ({
          value: preset.id,
          label: preset.name,
          // The reference idiom: the type rides on the right of the row.
          rightContent: FACTORY_TIER_IDS.has(preset.id) ? _(msg`Built-in`) : _(msg`Custom`),
        }))}
        onChange={(id) => setDraft((current) => ({ ...current, sizingPreset: id }))}
        ariaLabel={label}
        title={disabled ? undefined : hint}
        disabled={disabled}
        className="space-y-0"
        selectClassName="w-full !h-8 pl-2.5 pr-10 leading-tight text-[12px]"
      />
    </div>
  );

  if (!disabled) return field;
  // The app's own tooltip, on the whole field: a disabled trigger is dead to the
  // pointer (hence `disabled:pointer-events-none` in `SelectDropdown`), so the
  // wrapper is what receives the hover. The child is told to fill the wrapper: it is
  // a flex container, so without it the field would shrink to its intrinsic width.
  return <Tooltip content={help} fullWidth wrapperClassName="w-full [&>*]:w-full">{field}</Tooltip>;
}

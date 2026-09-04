/**
 * Translations for the built-in support preset names and descriptions.
 *
 * Presets are persisted to localStorage, so their stored `name`/`description`
 * must stay language-neutral — a user who switches language should not end up
 * with a preset frozen in the language they created it under. The built-ins are
 * therefore looked up by id at render time; anything else (a preset the user
 * made and named) falls back to what is stored, which is exactly what should be
 * shown.
 *
 * Module level on purpose: React Compiler renames locals inside components
 * before the Lingui macro derives the message id.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { SupportPreset } from '@/supports/Settings/types';

type Translate = (descriptor: MessageDescriptor) => string;

const BUILT_IN_NAMES: Record<string, MessageDescriptor> = {
  detail: msg({ message: 'Detail', comment: 'Support preset for delicate features. Shown on a narrow card next to "Structure" and "Anchor".' }),
  structure: msg({ message: 'Structure', comment: 'Support preset for general use. Shown on a narrow card next to "Detail" and "Anchor".' }),
  anchor: msg({ message: 'Anchor', comment: 'Support preset for large overhangs. Shown on a narrow card next to "Detail" and "Structure".' }),
};

const BUILT_IN_DESCRIPTIONS: Record<string, MessageDescriptor> = {
  detail: msg`Fine supports for delicate features`,
  structure: msg`Balanced supports for general use`,
  anchor: msg`Heavy supports for large overhangs`,
};

export function translatePresetName(preset: SupportPreset, translate: Translate): string {
  const descriptor = BUILT_IN_NAMES[preset.id];
  return descriptor ? translate(descriptor) : preset.name;
}

export function translatePresetDescription(preset: SupportPreset, translate: Translate): string {
  const descriptor = BUILT_IN_DESCRIPTIONS[preset.id];
  return descriptor ? translate(descriptor) : (preset.description ?? '');
}

/** Title of the overwrite confirmation, e.g. `Save Over "Detail"?`. */
export function formatOverwritePresetTitle(presetName: string, translate: Translate): string {
  return translate(msg`Save Over "${presetName}"?`);
}

/** Title of the delete confirmation, e.g. `Delete "My Preset"?`. */
export function formatDeletePresetTitle(presetName: string, translate: Translate): string {
  return translate(msg`Delete "${presetName}"?`);
}

/** Pin submenu entry, e.g. "Slot 3". */
export function formatPresetSlotLabel(slot: number, translate: Translate): string {
  return translate(msg`Slot ${slot}`);
}

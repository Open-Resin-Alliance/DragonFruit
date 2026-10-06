/**
 * Translations for the built-in auto-support preset names.
 *
 * Presets are persisted to localStorage, so a stored `name` must stay
 * language-neutral — a user who switches language should not end up with a
 * built-in frozen in the language it was first shown in. The built-ins are
 * looked up by id at render time; anything else (a preset the user made and
 * named) falls back to what is stored, which is exactly what should be shown.
 *
 * Module level on purpose: React Compiler renames locals inside components
 * before the Lingui macro derives the message id.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { AutoSupportPreset } from './autoSupportPresets';

type Translate = (descriptor: MessageDescriptor) => string;

/**
 * What a preset selector shows before the user has ever picked one. Shared by the
 * panel's dropdown and the settings dialog's strip, so the two surfaces name the
 * state the same way.
 */
export const NO_ACTIVE_PRESET_LABEL = msg`Custom — not a preset`;

const BUILT_IN_NAMES: Record<string, MessageDescriptor> = {
  light: msg({ message: 'Light', context: 'auto-support preset', comment: "Built-in auto-support preset for sparse supports — the Light tier in the Auto Support panel's preset selector." }),
  medium: msg({ message: 'Medium', context: 'auto-support preset', comment: "Built-in auto-support preset for balanced supports — the Medium tier in the Auto Support panel's preset selector." }),
  heavy: msg({ message: 'Heavy', context: 'auto-support preset', comment: "Built-in auto-support preset for dense supports — the Heavy tier in the Auto Support panel's preset selector." }),
};

export function translateAutoSupportPresetName(preset: AutoSupportPreset, translate: Translate): string {
  const descriptor = BUILT_IN_NAMES[preset.id];
  return descriptor ? translate(descriptor) : preset.name;
}

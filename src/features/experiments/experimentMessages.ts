/**
 * Translations for the experiment names and descriptions declared in
 * `src/config/experiments.json`.
 *
 * Lingui cannot extract from JSON, so the manifest stays the source of truth for
 * ids, defaults and gated plugins while the user-facing copy lives here, keyed
 * by experiment id. An experiment with no entry falls back to its manifest
 * string, so adding one to the JSON never leaves a blank row in the tab.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { ExperimentDefinition } from '@/features/experiments/experimentsRegistry';

type Translate = (descriptor: MessageDescriptor) => string;

const NAMES: Record<string, MessageDescriptor> = {
  'chitubox-import': msg`Chitubox File Import`,
  'auto-supports': msg`Auto Supports`,
};

const DESCRIPTIONS: Record<string, MessageDescriptor> = {
  'chitubox-import': msg`Enable importing .chitubox project files. Lacks comprehensive testing and may not work with all files.`,
  'auto-supports': msg`Automatic support generation from model analysis. Early access.`,
};

export function translateExperimentName(definition: ExperimentDefinition, translate: Translate): string {
  const descriptor = NAMES[definition.id];
  return descriptor ? translate(descriptor) : definition.name;
}

export function translateExperimentDescription(definition: ExperimentDefinition, translate: Translate): string {
  const descriptor = DESCRIPTIONS[definition.id];
  return descriptor ? translate(descriptor) : definition.description;
}

/**
 * Names given to pasted and duplicated models. Module level for the same React
 * Compiler reason as `sceneImportMessages.ts`: built inside the hook, the
 * placeholder would get an id the catalogue lacks and print raw in production.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

type Translate = (descriptor: MessageDescriptor) => string;

export function pastedModelName(modelName: string, translate: Translate): string {
  return translate(msg({ message: `${modelName} Copy`, context: 'Name of a pasted model' }));
}

export function duplicatedModelName(modelName: string, copyNumber: number, translate: Translate): string {
  return translate(msg({ message: `${modelName} Copy ${copyNumber}`, context: 'Name of a duplicated model' }));
}

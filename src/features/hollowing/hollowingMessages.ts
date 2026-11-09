/**
 * Error toasts for hollowing and hole punching. Module level for the same React Compiler
 * reason as `sceneImportMessages.ts`.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

type Translate = (descriptor: MessageDescriptor) => string;

export function hollowingDesktopOnlyMessage(translate: Translate): string {
  return translate(msg`Hollowing is available in DragonFruit Desktop only.`);
}

export function hollowingPreviewDesktopOnlyMessage(translate: Translate): string {
  return translate(msg`Hollowing preview is available in DragonFruit Desktop only.`);
}

export function hollowingFailedMessage(message: string, translate: Translate): string {
  return translate(msg`Hollowing failed: ${message}`);
}

export function hollowingPreviewFailedMessage(message: string, translate: Translate): string {
  return translate(msg`Hollowing preview failed: ${message}`);
}

export function shellModeNeedsFaceMessage(translate: Translate): string {
  return translate(msg`Pick the face to open before applying Shell mode.`);
}

export function hollowingRemoveUnavailableMessage(translate: Translate): string {
  return translate(msg`Cannot remove hollowing: original geometry is unavailable.`);
}

export function holePunchDesktopOnlyMessage(translate: Translate): string {
  return translate(msg`Hole punching is available in DragonFruit Desktop only.`);
}

export function holePunchSourceMissingMessage(translate: Translate): string {
  return translate(msg`Hole punch source snapshot is missing or invalid. Re-apply cannot continue.`);
}

export function holePunchFailedMessage(message: string, translate: Translate): string {
  return translate(msg`Hole punching failed: ${message}`);
}

/**
 * Translated strings for the updater that carry an interpolated value.
 *
 * These live at module level on purpose. React Compiler renames locals inside
 * components and hooks (`pct` -> `pct_0`) before the Lingui macro derives the
 * message id, so an interpolation written inside a component ends up with an id
 * the compiled catalogue does not contain — a permanent miss that falls back to
 * the raw source string and prints `{pct_0}%` in production builds. Module-level
 * helpers are outside React Compiler's reach, so their ids stay stable.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

type Translate = (descriptor: MessageDescriptor) => string;

/** Download progress as a percentage, e.g. "42%" — Spanish spaces it as "42 %". */
export function formatUpdateProgressPct(pct: number, translate: Translate): string {
  return translate(msg`${pct}%`);
}

/** Release date line under the "Update Available!" notification title. */
export function formatUpdateReleaseLine(releaseDate: string, translate: Translate): string {
  return translate(msg`Release ${releaseDate}`);
}

/** Version chip on the update notification, e.g. "Version 0.1.16". */
export function formatUpdateVersionChip(version: string, translate: Translate): string {
  return translate(msg`Version ${version}`);
}

/** Byte counter under the download spinner, e.g. "12.4 MB / 68.1 MB (18%)". */
export function formatUpdateDownloadedBytes(
  downloaded: string,
  total: string,
  pct: string,
  translate: Translate,
): string {
  return translate(msg`${downloaded} / ${total} (${pct}%)`);
}

/** Version line when the release notes are already showing, e.g. "Version 0.1.16 • update ready". */
export function formatUpdateVersionReady(version: string, translate: Translate): string {
  return translate(msg`Version ${version} • update ready`);
}

/** Subtitle of the "Update & Restart?" confirmation dialog. */
export function formatUpdateReadyToInstall(version: string, translate: Translate): string {
  return translate(msg`Version ${version} is ready to install`);
}

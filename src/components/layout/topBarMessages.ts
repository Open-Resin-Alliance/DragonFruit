/**
 * Translated topbar strings that interpolate a value.
 *
 * Module level on purpose: React Compiler renames locals inside components
 * (`profileName` -> `profileName_0`) before the Lingui macro derives the message
 * id, so an interpolation written inside `TopBar` gets an id the compiled
 * catalogue does not contain and falls back to the raw source string in
 * production builds. See `printingMonitorFormat.ts` for the same pattern.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

type Translate = (descriptor: MessageDescriptor) => string;

/** Tooltip on the topbar printer badge when the profile owns a fleet. */
export function formatTopbarPrinterTitle(
  profileName: string,
  printerName: string,
  translate: Translate,
): string {
  return translate(msg({
    message: `Printer profile: ${profileName} • Active printer: ${printerName}`,
    comment: '"Printer profile" is the saved configuration (material, output format, etc.); "Active printer" is the physical network device currently connected under that profile. The two are distinct concepts that happen to both contain the word "printer".',
  }));
}

/** Screen-reader label for the same badge, without the bullet separator. */
export function formatTopbarPrinterAriaLabel(
  profileName: string,
  printerName: string,
  translate: Translate,
): string {
  return translate(msg({
    message: `Printer profile ${profileName}, active printer ${printerName}`,
    comment: 'Same distinction as the title tooltip (profile = saved configuration, printer = connected physical device), phrased for screen readers without the bullet separator.',
  }));
}

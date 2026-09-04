/**
 * Translated labels and details for the import progress overlay.
 *
 * These live at module level on purpose. React Compiler renames locals inside
 * components and hooks before the Lingui macro derives the message id, so an
 * interpolation written inside `useSceneCollectionManager` would end up with an
 * id the compiled catalogue does not contain — a permanent miss that falls back
 * to the raw source string and prints `{fileName_0}` in production builds.
 * Module-level helpers are outside React Compiler's reach, so their ids stay
 * stable. See `printingMonitorFormat.ts` for the same pattern.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

type Translate = (descriptor: MessageDescriptor) => string;

// ---------------------------------------------------------------------------
// Labels — the headline of the overlay
// ---------------------------------------------------------------------------

export function importLabelLoadingMesh(fileCount: number, translate: Translate): string {
  return fileCount > 1 ? translate(msg`Loading Mesh Files…`) : translate(msg`Loading Mesh…`);
}

export function importLabelAutoRepairing(fileCount: number, translate: Translate): string {
  return fileCount > 1 ? translate(msg`Auto-Repairing Meshes…`) : translate(msg`Auto-Repairing Mesh…`);
}

export function importLabelInspecting(fileCount: number, translate: Translate): string {
  return fileCount > 1 ? translate(msg`Inspecting Meshes…`) : translate(msg`Inspecting Mesh…`);
}

export function importLabelClassifying(fileCount: number, translate: Translate): string {
  return fileCount > 1 ? translate(msg`Classifying Mesh Shells…`) : translate(msg`Classifying Mesh Shell…`);
}

export function importLabelSplittingSupports(translate: Translate): string {
  return translate(msg`Splitting Supports…`);
}

export function importLabelMergingSupports(translate: Translate): string {
  return translate(msg`Merging Supports…`);
}

export function importLabelScanningSupports(translate: Translate): string {
  return translate(msg`Scanning for Supports…`);
}

export function importLabelVoxlScene(translate: Translate): string {
  return translate(msg`Importing VOXL Scene…`);
}

export function importLabelScenes(translate: Translate): string {
  return translate(msg`Importing Scenes…`);
}

/** `fileTypeName` is the plugin-provided format name, e.g. "CTB" — not translated here. */
export function importLabelFileType(fileTypeName: string, translate: Translate): string {
  return translate(msg`Importing ${fileTypeName}…`);
}

// ---------------------------------------------------------------------------
// Details — the second line under the label
// ---------------------------------------------------------------------------

export function importDetailPreparing(done: number, total: number, translate: Translate): string {
  return translate(msg`Preparing ${done}/${total}`);
}

export function importDetailPreparingGeometry(translate: Translate): string {
  return translate(msg`Preparing Geometry…`);
}

export function importDetailFinalizing(translate: Translate): string {
  return translate(msg`Finalizing…`);
}

export function importDetailFinalizingModel(translate: Translate): string {
  return translate(msg`Finalizing Model…`);
}

export function importDetailIndexedFile(
  index: number,
  total: number,
  fileName: string,
  translate: Translate,
): string {
  return translate(msg`${index}/${total}: ${fileName}`);
}

export function importDetailProcessedCount(done: number, total: number, translate: Translate): string {
  return translate(msg`${done}/${total} processed`);
}

export function importDetailLoadingFile(fileName: string, translate: Translate): string {
  return translate(msg`Loading ${fileName}`);
}

export function importDetailAutoRepairingFile(fileName: string, translate: Translate): string {
  return translate(msg`Auto-Repairing ${fileName}`);
}

export function importDetailInspectingFile(fileName: string, translate: Translate): string {
  return translate(msg`Inspecting ${fileName}`);
}

export function importDetailClassifyingFile(fileName: string, translate: Translate): string {
  return translate(msg`Classifying ${fileName}`);
}

export function importDetailSeparatingGeometry(translate: Translate): string {
  return translate(msg`Separating model and support geometry…`);
}

export function importDetailRecombiningGeometry(translate: Translate): string {
  return translate(msg`Recombining model and support geometry…`);
}

// Per-mesh counters used while a multi-model import walks its meshes.

export function importDetailAutoRepairingMesh(index: number, total: number, translate: Translate): string {
  return translate(msg`Auto-Repairing Mesh ${index}/${total}`);
}

export function importDetailInspectingMesh(index: number, total: number, translate: Translate): string {
  return translate(msg`Inspecting Mesh ${index}/${total}`);
}

export function importDetailClassifyingMesh(index: number, total: number, translate: Translate): string {
  return translate(msg`Classifying Mesh ${index}/${total}`);
}

// VOXL scenes name the model as well as the counter.

export function importDetailVoxlModel(
  index: number,
  total: number,
  modelName: string,
  translate: Translate,
): string {
  return translate(msg`Model ${index}/${total}: ${modelName}`);
}

export function importDetailVoxlAutoRepairing(
  index: number,
  total: number,
  modelName: string,
  translate: Translate,
): string {
  return translate(msg`Auto-Repairing Mesh ${index}/${total}: ${modelName}`);
}

export function importDetailVoxlInspecting(
  index: number,
  total: number,
  modelName: string,
  translate: Translate,
): string {
  return translate(msg`Inspecting Mesh ${index}/${total}: ${modelName}`);
}

export function importDetailVoxlClassifying(
  index: number,
  total: number,
  modelName: string,
  translate: Translate,
): string {
  return translate(msg`Classifying Mesh ${index}/${total}: ${modelName}`);
}

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

import { msg, plural } from '@lingui/core/macro';
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

/**
 * "Restored poussin.stl." — reported once a model's own file has been loaded back over it.
 *
 * Here rather than beside its caller for the reason at the top of this file: the name interpolates,
 * and an interpolation written inside the scene hook loses its message id to React Compiler.
 */
export function reportRestoredModel(modelName: string, translate: Translate): string {
  return translate(msg`Restored ${modelName}`);
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

// ---------------------------------------------------------------------------
// Drag-and-drop overlay
// ---------------------------------------------------------------------------

/** `extensions` is the comma-joined list of accepted formats, e.g. "STL, OBJ, 3MF". */
export function dropOverlaySupportedFormats(extensions: string, translate: Translate): string {
  return translate(msg`Supported: ${extensions}`);
}

export function dropOverlayUnsupportedFormats(extensions: string, translate: Translate): string {
  return translate(msg`Please use: ${extensions}`);
}

// ---------------------------------------------------------------------------
// Reports — the toast once an import or a scene edit is done
// ---------------------------------------------------------------------------

export function reportAutoRepaired(translate: Translate): string {
  return translate(msg`Auto-repaired. Click for details.`);
}

export function reportSplitSupportsFailed(translate: Translate): string {
  return translate(msg`Failed to split supports`);
}

export function reportMergeSupportsFailed(translate: Translate): string {
  return translate(msg`Failed to merge supports`);
}

export function reportScanned(modelName: string, translate: Translate): string {
  return translate(msg`Scanned ${modelName}.`);
}

export function reportScanFailed(message: string, translate: Translate): string {
  return translate(msg`Scan failed: ${message}`);
}

export function reportUnsupportedSceneFile(fileName: string, translate: Translate): string {
  return translate(msg`Unsupported scene file: ${fileName}`);
}

/** `extension` is the file's, with its dot, e.g. ".lys". */
export function reportNoSceneImportHandler(extension: string, translate: Translate): string {
  return translate(msg`No registered scene import handler for ${extension}.`);
}

/**
 * The summary after a scene file loads. `format` is the file type in capitals, e.g. "VOXL";
 * the support count and the skipped-model count are left out when they are zero.
 */
export function reportImportedScene(
  format: string,
  modelCount: number,
  supportCount: number,
  skippedCount: number,
  translate: Translate,
): string {
  if (supportCount > 0 && skippedCount > 0) {
    return translate(msg`Imported ${format} scene: ${plural(modelCount, { one: '# model', other: '# models' })}, ${plural(supportCount, { one: '# support', other: '# supports' })}, skipped ${plural(skippedCount, { one: '# model', other: '# models' })}.`);
  }
  if (supportCount > 0) {
    return translate(msg`Imported ${format} scene: ${plural(modelCount, { one: '# model', other: '# models' })}, ${plural(supportCount, { one: '# support', other: '# supports' })}.`);
  }
  if (skippedCount > 0) {
    return translate(msg`Imported ${format} scene: ${plural(modelCount, { one: '# model', other: '# models' })}, skipped ${plural(skippedCount, { one: '# model', other: '# models' })}.`);
  }
  return translate(msg`Imported ${format} scene: ${plural(modelCount, { one: '# model', other: '# models' })}.`);
}

export function reportSceneImportFailed(message: string, translate: Translate): string {
  return translate(msg`Scene import failed: ${message}`);
}

export function reportVoxlNoMeshes(translate: Translate): string {
  return translate(msg`VOXL import finished with no importable meshes.`);
}

export function reportVoxlUnsupportedVersion(fileName: string, translate: Translate): string {
  return translate(msg`Could not open ${fileName}: unsupported VOXL version.`);
}

export function reportVoxlImportFailed(message: string, translate: Translate): string {
  return translate(msg`VOXL import failed: ${message}`);
}

export function reportSceneFilesImported(count: number, translate: Translate): string {
  return translate(msg`${plural(count, { one: 'Imported # scene file.', other: 'Imported # scene files.' })}`);
}

export function reportSceneFilesPartlyImported(imported: number, total: number, failed: number, translate: Translate): string {
  return translate(msg`Imported ${imported}/${total} scene files (${failed} failed).`);
}

export function reportSceneFilesAllFailed(total: number, translate: Translate): string {
  return translate(msg`${plural(total, { one: 'Scene import failed.', other: 'Scene import failed for all # files.' })}`);
}

export function reportSupportJsonUnsupported(translate: Translate): string {
  return translate(msg`Support import failed: unsupported support JSON format.`);
}

export function reportSupportJsonImported(translate: Translate): string {
  return translate(msg`Imported support data.`);
}

export function reportSupportJsonFailed(translate: Translate): string {
  return translate(msg`Support import failed.`);
}

/** The blocking dialog a failed scene import raises; `message` is the error's own text. */
export function alertSceneImportFailed(message: string, translate: Translate): string {
  return translate(msg`Scene import failed:\n${message}`);
}

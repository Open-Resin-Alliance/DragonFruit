import { asciiFileBaseName } from '@/features/slicing/plateSliceNaming';
import type { SliceExportArtifact } from '@/features/slicing/sliceExportOrchestrator';

/** What the send-to-printer flow needs from a print file, whether just sliced or picked from disk. */
export type PrintUploadFile = Pick<SliceExportArtifact, 'blob' | 'outputName' | 'nativeTempPath'>;

/** A file from disk on its way to one printer. Retries go back to that printer and no other. */
export type ExternalPrintUpload = { file: PrintUploadFile; deviceId: string };

/**
 * A sliced file picked from disk, as an upload for a printer that takes `extension` files.
 * Null when the file is of another format: the dialog's filter can be bypassed, and a plugin
 * names the uploaded file itself, so the wrong format would reach the printer mislabelled.
 */
export function slicedFileToUpload(
  picked: { name: string; path: string },
  extension: string,
): PrintUploadFile | null {
  const suffix = `.${extension.toLowerCase()}`;
  if (!picked.name.toLowerCase().endsWith(suffix)) return null;
  const baseName = picked.name.slice(0, -suffix.length);
  return {
    blob: null,
    outputName: `${asciiFileBaseName(baseName)}${suffix}`,
    nativeTempPath: picked.path,
  };
}

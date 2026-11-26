import { asciiFileBaseName } from '@/features/slicing/plateSliceNaming';
import type { SliceExportArtifact } from '@/features/slicing/sliceExportOrchestrator';

/** What the send-to-printer flow needs from a print file, whether just sliced or picked from disk. */
export type PrintUploadFile = Pick<SliceExportArtifact, 'blob' | 'outputName' | 'nativeTempPath'>;

/** A file from disk on its way to one printer. Retries go back to that printer and no other. */
export type ExternalPrintUpload = { file: PrintUploadFile; deviceId: string };

/**
 * Whether a plates list response already holds a file named `fileName`. Printers differ on
 * what a second upload of a name does, so a file from disk never goes up under a name that
 * is taken. Names compare without case: some storage the printers use ignores it.
 */
export function platesListHasFileNamed(payload: unknown, fileName: string): boolean {
  const plates = payload && typeof payload === 'object' ? (payload as { plates?: unknown }).plates : null;
  if (!Array.isArray(plates)) return false;
  const wanted = fileName.trim().toLowerCase();
  return plates.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const plate = entry as Record<string, unknown>;
    const raw = plate.Path ?? plate.path ?? plate.File ?? plate.file ?? plate.Name ?? plate.name;
    if (typeof raw !== 'string') return false;
    const name = raw.trim().split('/').filter(Boolean).pop() ?? '';
    return name.toLowerCase() === wanted;
  });
}

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

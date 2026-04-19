import JSZip from 'jszip';

/**
 * Extracts all non-directory entries from a ZIP file and returns them as `File` objects.
 * Hidden entries (names starting with `.`) and `__MACOSX` metadata are skipped.
 */
export async function extractFilesFromZip(zip: File): Promise<File[]> {
  const jszip = new JSZip();
  const loaded = await jszip.loadAsync(await zip.arrayBuffer());

  const results: File[] = [];

  for (const [path, entry] of Object.entries(loaded.files)) {
    if (entry.dir) continue;

    // Strip any directory prefix to get just the filename
    const filename = path.split('/').pop() ?? path;

    // Skip hidden files, macOS resource forks, and empty names
    if (!filename || filename.startsWith('.') || path.startsWith('__MACOSX/')) continue;

    const bytes = await entry.async('arraybuffer');
    results.push(new File([bytes], filename, { lastModified: Date.now() }));
  }

  return results;
}

/** Returns the lowercase extension (including dot) for a filename, or empty string. */
export function getFileExtensionLower(name: string): string {
  const match = name.toLowerCase().match(/(\.[^./\\]+)$/);
  return match?.[1] ?? '';
}

/** What one plate's slice covers, and what its output is called. */
export type PlateSliceScope = {
  /** The plate this scope is about, so a sliced plate's output can be shown by plate. */
  plateId: string;
  /** The plate's own name, or '' when the user has not named it. */
  plateName: string;
  modelIds: readonly string[];
  /** The plate's build volume in world coordinates. */
  volumeBoundsMm: { minX: number; minY: number; maxX: number; maxY: number };
  /** Where the plate sits in the cascade, so its geometry can be shifted to the origin. */
  offsetMm: { dxMm: number; dyMm: number };
};

/**
 * A plate's name as a file name: a character no file system takes, a path separator among
 * them, becomes an underscore. Everything else stays, accents and spaces included.
 */
export function sliceFileBaseName(name: string): string {
  return name.replace(/[<>:"/\\|?*]+/g, '_').trim();
}

/**
 * A file in the directory a batch picked, named for the plate it holds.
 *
 * The separator follows the directory's own, because the path goes straight to the native
 * slicer: a Windows slicer handed forward slashes is a second, avoidable failure.
 */
export function joinSliceOutputPath(directory: string, baseName: string, extension: string): string {
  const trimmedDirectory = directory.trim().replace(/[\\/]+$/, '');
  const separator = trimmedDirectory.includes('\\') ? '\\' : '/';
  const trimmedExtension = extension.trim().replace(/^\.+/, '');
  const file = `${sliceFileBaseName(baseName) || 'slice_export'}${trimmedExtension ? `.${trimmedExtension}` : ''}`;
  return `${trimmedDirectory}${separator}${file}`;
}

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
 * Latin letters that are their own letter rather than a base letter with a mark on it, so
 * Unicode decomposition leaves them alone. Each becomes what a reader would type without it.
 */
const ASCII_LETTER_APPROXIMATIONS: Readonly<Record<string, string>> = {
  ß: 'ss', ẞ: 'SS',
  æ: 'ae', Æ: 'AE',
  œ: 'oe', Œ: 'OE',
  ø: 'o', Ø: 'O',
  ł: 'l', Ł: 'L',
  đ: 'd', Đ: 'D',
  ð: 'd', Ð: 'D',
  þ: 'th', Þ: 'Th',
  ħ: 'h', Ħ: 'H',
  ı: 'i',
  ĸ: 'k',
};

/**
 * A name as an ASCII file name, for the files that go to a printer: some firmwares cannot
 * show or open anything else. What has a near ASCII spelling is given it first — ñ is n, ü
 * is u, ß is ss — and only what is left becomes an underscore, so "Arañita (copia)" is
 * "Aranita_copia" rather than "Ara_ita_copia".
 */
export function asciiFileBaseName(raw: string): string {
  const approximated = raw
    .trim()
    // Compatibility decomposition splits a letter from its marks, and a ligature or a
    // full-width form into plain letters; the marks then go.
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[\u0080-\u{10FFFF}]/gu, (letter) => ASCII_LETTER_APPROXIMATIONS[letter] ?? letter);
  const cleaned = approximated.replace(/[^a-z0-9-_]+/gi, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'slice_export';
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

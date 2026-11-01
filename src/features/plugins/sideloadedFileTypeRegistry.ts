/**
 * Extensions contributed by installed `.dfplugin` packages, as plain module
 * state.
 *
 * Kept apart from the Tauri-backed refresh so the drop and import gates (which
 * have to answer synchronously, before anything is opened) can consult it
 * without pulling the native bridge into their import graph.
 */
export type SideloadedFileType = {
  pluginId: string;
  pluginName: string;
  extension: string;
  displayName: string;
  isSceneFile: boolean;
};

/** An output format an installed package can encode, as the pickers need it. */
export type SideloadedOutputFormat = {
  pluginId: string;
  pluginName: string;
  extension: string;
  displayName: string;
  /** The package's format declares it can carry more than one material. */
  multiTank?: boolean;
  formatVersions?: Array<{ id: string; label: string; isDefault?: boolean }>;
  /** The chosen version is the output file extension, not just a tag. */
  fileExtensionFromVersion?: boolean;
};

const EMPTY: SideloadedFileType[] = [];
const EMPTY_FORMATS: SideloadedOutputFormat[] = [];

let snapshot: SideloadedFileType[] = EMPTY;
let formatSnapshot: SideloadedOutputFormat[] = EMPTY_FORMATS;
const listeners = new Set<() => void>();

export function subscribeSideloadedFileTypes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSideloadedFileTypesSnapshot(): SideloadedFileType[] {
  return snapshot;
}

/** Replaces the snapshot. The refresh path and tests both come through here. */
export function applySideloadedFileTypes(next: SideloadedFileType[]): void {
  const same =
    next.length === snapshot.length &&
    next.every((entry, index) => {
      const current = snapshot[index];
      return (
        current?.pluginId === entry.pluginId &&
        current.extension === entry.extension &&
        current.displayName === entry.displayName &&
        current.isSceneFile === entry.isSceneFile
      );
    });
  if (same) return;
  snapshot = next.length === 0 ? EMPTY : next;
  for (const listener of listeners) listener();
}

function normalizedExtension(name: string): string {
  const trimmed = name.trim().toLowerCase();
  const dot = trimmed.lastIndexOf('.');
  return dot < 0 ? '' : trimmed.slice(dot);
}

/**
 * Whether two format entries are the same contribution. Every field counts: a
 * package reinstalled at the same id and extension can still add a multi-tank
 * flag or new output versions, and comparing only the identity left the old
 * snapshot in place so the profile editor never offered them.
 */
function sameOutputFormat(left: SideloadedOutputFormat | undefined, right: SideloadedOutputFormat): boolean {
  if (!left) return false;
  if (
    left.pluginId !== right.pluginId
    || left.pluginName !== right.pluginName
    || left.extension !== right.extension
    || left.displayName !== right.displayName
    || (left.multiTank === true) !== (right.multiTank === true)
    || (left.fileExtensionFromVersion === true) !== (right.fileExtensionFromVersion === true)
  ) {
    return false;
  }
  const leftVersions = left.formatVersions ?? [];
  const rightVersions = right.formatVersions ?? [];
  return leftVersions.length === rightVersions.length
    && leftVersions.every((entry, index) => (
      entry.id === rightVersions[index]?.id
      && entry.label === rightVersions[index]?.label
      && (entry.isDefault === true) === (rightVersions[index]?.isDefault === true)
    ));
}

export function applySideloadedOutputFormats(next: SideloadedOutputFormat[]): void {
  const same =
    next.length === formatSnapshot.length &&
    next.every((entry, index) => sameOutputFormat(formatSnapshot[index], entry));
  if (same) return;
  formatSnapshot = next.length === 0 ? EMPTY_FORMATS : next;
  for (const listener of listeners) listener();
}

/** Encoder formats contributed by installed packages, in id order. */
export function sideloadedOutputFormats(): readonly SideloadedOutputFormat[] {
  return formatSnapshot;
}

/** Snapshot for `useSyncExternalStore`; the subscription is shared with file types. */
export function getSideloadedOutputFormatsSnapshot(): SideloadedOutputFormat[] {
  return formatSnapshot;
}

/** Any extension an installed package claims, scene or not. */
export function isSideloadedFileName(name: string): boolean {
  const extension = normalizedExtension(name);
  return extension !== '' && snapshot.some((entry) => entry.extension === extension);
}

/** Only the scene ones: the ones the import pipeline can take. */
export function isSideloadedSceneFileName(name: string): boolean {
  const extension = normalizedExtension(name);
  return (
    extension !== '' &&
    snapshot.some((entry) => entry.isSceneFile && entry.extension === extension)
  );
}

export function sideloadedSceneExtensions(): string[] {
  return snapshot.filter((entry) => entry.isSceneFile).map((entry) => entry.extension);
}

/** The package that opens `fileName`, matched case-insensitively by extension. */
export function findSideloadedSceneFileType(fileName: string): SideloadedFileType | null {
  const extension = normalizedExtension(fileName);
  if (!extension) return null;
  return snapshot.find((entry) => entry.isSceneFile && entry.extension === extension) ?? null;
}

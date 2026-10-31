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

const EMPTY: SideloadedFileType[] = [];

let snapshot: SideloadedFileType[] = EMPTY;
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

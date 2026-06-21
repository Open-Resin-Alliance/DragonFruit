import React from 'react';
import { detectIsIOS } from '@/hooks/usePlatform';
import { suppressSceneAutosave } from '@/hooks/useSceneAutosave';
import { extractFilesFromZip, getFileExtensionLower } from '@/utils/zipImport';
import {
  pickOpenFilesWithNativeDialog,
  readPrintArtifactBytesFromPath,
} from '@/features/slicing/tauri/nativeSlicerBridge';
import type { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import {
  getFileExtension,
  getFileNameFromPath,
  isSupportedPrepareDropName,
  getDroppedFileMimeType,
  isSceneFileName,
  normalizeActiveVoxlScenePath,
  extractTauriDroppedPaths,
  isLikelyFileDragPayload,
  getPrepareDropSupportStateFromDataTransfer,
  buildDroppedFilesSignature,
  type LaunchSceneFileEntry,
  type SceneFileHandoffPayload,
} from '@/features/import-export/fileHandling';

type SceneManager = ReturnType<typeof useSceneCollectionManager>;

const COLD_START_SCENE_HANDOFF_DELAY_MS = 1150;

/** Late / cross-domain dependencies read at event/effect time via deps.current.*.
 *  Home populates this ref AFTER the slicing manager and the select-all model
 *  state exist, breaking the TDZ/dependency cycle (mirrors the hollowing manager). */
export type ImportExportManagerDeps = {
  /** Stable environment probe (read at event/effect time, not reactive). */
  isDesktopRuntime: () => boolean;
  /** Slicing manager layer-index access used by the export-thumbnail capture runner. */
  slicing: {
    layerIndex: number;
    setLayerIndex: React.Dispatch<React.SetStateAction<number>>;
  };
  /** Select-all visual state, owned by Home and shared with unrelated code. */
  isSelectAllModelsActive: boolean;
  setIsSelectAllModelsActive: React.Dispatch<React.SetStateAction<boolean>>;
};

export type UseImportExportManagerOptions = {
  scene: SceneManager;
  /** Shared callbacks defined before this hook's call site (direct deps). */
  importSceneFile: SceneManager['importSceneFile'];
  importSceneFiles: SceneManager['importSceneFiles'];
  recentOpenedFiles: SceneManager['recentOpenedFiles'];
  reopenRecentOpenedFile: SceneManager['reopenRecentOpenedFile'];
  maybeConfirmPluginImportWarning: (filesInput: FileList | File[]) => Promise<boolean>;
  markSceneSaveBaseline: () => void;
  setActiveSceneFilePath: React.Dispatch<React.SetStateAction<string | null>>;
  setLoadedSceneSaveSource: React.Dispatch<React.SetStateAction<{ name: string; path: string | null } | null>>;
  sceneImportAutosaveSuppressMs: number;
  /** Late / cross-domain deps (see ImportExportManagerDeps). */
  deps: React.MutableRefObject<ImportExportManagerDeps>;
};

export function useImportExportManager({
  scene,
  importSceneFile,
  importSceneFiles,
  recentOpenedFiles,
  reopenRecentOpenedFile,
  maybeConfirmPluginImportWarning,
  markSceneSaveBaseline,
  setActiveSceneFilePath,
  setLoadedSceneSaveSource,
  sceneImportAutosaveSuppressMs,
  deps,
}: UseImportExportManagerOptions) {

  const exportThumbnailCaptureRef = React.useRef<(() => Promise<Uint8Array | null>) | null>(null);

  const exportThumbnailCaptureRunnerRef = React.useRef<(() => Promise<Uint8Array | null>) | null>(null);

  const [isPrepareDragActive, setIsPrepareDragActive] = React.useState(false);

  const [isPrepareDragUnsupported, setIsPrepareDragUnsupported] = React.useState(false);

  const [zipPickerState, setZipPickerState] = React.useState<{
    zipName: string;
    files: File[];
    category: 'mesh' | 'scene' | 'mixed';
    defaultSelectionCategory: 'mesh' | 'scene';
  } | null>(null);

  const zipPickerResolveRef = React.useRef<((files: File[]) => void) | null>(null);

  const dragDepthRef = React.useRef(0);

  const launchSceneFilesHandledRef = React.useRef(false);

  const startupSceneHandoffReadyRef = React.useRef(false);

  const queuedLaunchSceneEntriesRef = React.useRef<LaunchSceneFileEntry[]>([]);

  const coldStartSceneHandoffTimerRef = React.useRef<number | null>(null);

  const launchSceneImportInFlightRef = React.useRef(false);

  // Stable ref so the launch effect can always call the latest version of
  // this callback without listing it as a dep (which causes effect re-runs
  // and cancelled-flag races during scene initialization).
  const importSceneFromLaunchEntriesRef = React.useRef<((entries: LaunchSceneFileEntry[]) => Promise<boolean>) | null>(null);

  const [pendingStartupSceneHandoff, setPendingStartupSceneHandoff] = React.useState(false);

  const lastPrepareDropRef = React.useRef<{ signature: string; atMs: number }>({
    signature: '',
    atMs: 0,
  });

    const handleRegisterExportThumbnailCapture = React.useCallback((capture: (() => Promise<Uint8Array | null>) | null) => {
      exportThumbnailCaptureRef.current = capture;
    }, []);

    const captureExportThumbnailPng = React.useCallback(async () => {
      const runCapture = exportThumbnailCaptureRunnerRef.current;
      if (!runCapture) return null;
      return runCapture();
    }, []);

  const importSceneFilesWithPluginWarning = React.useCallback(async (
    filesInput: FileList | File[],
    options?: { resultingScenePath?: string | null; sourcePaths?: Array<string | null | undefined> },
  ): Promise<boolean> => {
    const sceneFiles = Array.from(filesInput);
    if (sceneFiles.length === 0) return false;

    const proceed = await maybeConfirmPluginImportWarning(sceneFiles);
    if (!proceed) return false;

    // Fresh imports can emit a burst of history/model-count changes while meshes are
    // still decoding and settling. Keep autosave asleep across the import and the
    // immediate post-import stabilization window to avoid adding save/export work to
    // the hot path.
    suppressSceneAutosave(sceneImportAutosaveSuppressMs);

    const imported = sceneFiles.length === 1
      ? await importSceneFile(sceneFiles[0], {
          sourcePath: options?.sourcePaths?.[0] ?? options?.resultingScenePath ?? null,
        })
      : await importSceneFiles(sceneFiles, {
          sourcePaths: options?.sourcePaths,
        });

    if (imported) {
      const importedSingleFile = sceneFiles.length === 1 ? sceneFiles[0] : null;
      const importedSingleIsVoxl = Boolean(importedSingleFile && getFileExtension(importedSingleFile.name) === '.voxl');
      const normalizedScenePath = normalizeActiveVoxlScenePath(options?.resultingScenePath);
      setActiveSceneFilePath(normalizedScenePath);
      if (importedSingleFile && importedSingleIsVoxl) {
        setLoadedSceneSaveSource({
          name: importedSingleFile.name,
          path: normalizedScenePath,
        });
        markSceneSaveBaseline();
      } else {
        setLoadedSceneSaveSource(null);
      }

      suppressSceneAutosave(sceneImportAutosaveSuppressMs);
    }

    return imported;
  }, [importSceneFile, importSceneFiles, markSceneSaveBaseline, maybeConfirmPluginImportWarning, sceneImportAutosaveSuppressMs]);

  // ── ZIP import helpers ───────────────────────────────────────────────────

  const resolveZipFiles = React.useCallback(async (
    zip: File,
    requestedCategory: 'mesh' | 'scene',
  ): Promise<{ meshFiles: File[]; sceneFiles: File[] }> => {
    const meshExts = new Set(['.stl', '.obj', '.3mf']);
    const sceneExts = new Set(['.voxl', '.lys']);
    const oppositeCategory = requestedCategory === 'mesh' ? 'scene' : 'mesh';

    const readingLabel = 'Loading Archive…';
    setNativePickerPreparationState({
      active: true,
      label: readingLabel,
      detail: `Reading ${zip.name}…`,
      progress: null,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    let extracted: File[];
    try {
      extracted = await extractFilesFromZip(zip);
    } catch (err) {
      console.error('[ZIP] Failed to read ZIP archive:', err);
      setNativePickerPreparationState({ active: false, label: '', detail: '', progress: null });
      return { meshFiles: [], sceneFiles: [] };
    }

    const meshCandidates = extracted.filter((f) => meshExts.has(getFileExtensionLower(f.name)));
    const sceneCandidates = extracted.filter((f) => sceneExts.has(getFileExtensionLower(f.name)));

    // Clear spinner before potentially showing the picker modal (or returning nothing)
    setNativePickerPreparationState({ active: false, label: '', detail: '', progress: null });

    const hasMeshCandidates = meshCandidates.length > 0;
    const hasSceneCandidates = sceneCandidates.length > 0;

    let targetCategory: 'mesh' | 'scene' | 'mixed';
    let targetCandidates: File[];

    if (hasMeshCandidates && hasSceneCandidates) {
      // Fully mixed ZIP: allow user to choose any combination of mesh/scene files.
      targetCategory = 'mixed';
      targetCandidates = [...meshCandidates, ...sceneCandidates];
    } else {
      const primaryCandidates = requestedCategory === 'mesh' ? meshCandidates : sceneCandidates;
      const oppositeCandidates = requestedCategory === 'mesh' ? sceneCandidates : meshCandidates;
      targetCategory = primaryCandidates.length === 0 && oppositeCandidates.length > 0
        ? oppositeCategory
        : requestedCategory;
      targetCandidates = targetCategory === 'mesh' ? meshCandidates : sceneCandidates;
    }

    if (targetCandidates.length === 0) {
      return { meshFiles: [], sceneFiles: [] };
    }

    const uniqueExts = new Set(targetCandidates.map((f) => getFileExtensionLower(f.name)));
    const selectedCandidates = (targetCategory !== 'mixed' && uniqueExts.size === 1)
      ? targetCandidates
      : await new Promise<File[]>((resolve) => {
          zipPickerResolveRef.current = resolve;
          setZipPickerState({
            zipName: zip.name,
            files: targetCandidates,
            category: targetCategory,
            defaultSelectionCategory: requestedCategory,
          });
        });

    const selectedMeshFiles = selectedCandidates.filter((file) => meshExts.has(getFileExtensionLower(file.name)));
    const selectedSceneFiles = selectedCandidates.filter((file) => sceneExts.has(getFileExtensionLower(file.name)));

    return {
      meshFiles: selectedMeshFiles,
      sceneFiles: selectedSceneFiles,
    };
  }, []);

  const expandPickedFilesWithZip = React.useCallback(async (
    files: File[],
    requestedCategory: 'mesh' | 'scene',
  ): Promise<{ meshFiles: File[]; sceneFiles: File[] }> => {
    const meshExts = new Set(['.stl', '.obj', '.3mf']);
    const sceneExts = new Set(['.voxl', '.lys']);

    const meshFiles: File[] = [];
    const sceneFiles: File[] = [];

    for (const file of files) {
      const ext = getFileExtensionLower(file.name);
      if (ext === '.zip') {
        const expanded = await resolveZipFiles(file, requestedCategory);
        if (expanded.meshFiles.length > 0) meshFiles.push(...expanded.meshFiles);
        if (expanded.sceneFiles.length > 0) sceneFiles.push(...expanded.sceneFiles);
      } else if (meshExts.has(ext)) {
        meshFiles.push(file);
      } else if (sceneExts.has(ext)) {
        sceneFiles.push(file);
      }
    }

    return { meshFiles, sceneFiles };
  }, [resolveZipFiles]);

  // ─────────────────────────────────────────────────────────────────────────

  const handleImportSceneInputChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const files = Array.from(e.target.files);
    void importSceneFilesWithPluginWarning(files);
    e.target.value = '';
  }, [importSceneFilesWithPluginWarning]);

  const handleLoadMeshChangeWithZip = React.useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const files = Array.from(e.target.files);
    e.target.value = '';
    const processed = await expandPickedFilesWithZip(files, 'mesh');
    if (processed.meshFiles.length > 0) {
      void scene.loadFiles(processed.meshFiles);
    }
    if (processed.sceneFiles.length > 0) {
      await importSceneFilesWithPluginWarning(processed.sceneFiles, { resultingScenePath: null });
    }
  }, [expandPickedFilesWithZip, importSceneFilesWithPluginWarning, scene]);

  const handleImportSceneChangeWithZip = React.useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const files = Array.from(e.target.files);
    e.target.value = '';
    const processed = await expandPickedFilesWithZip(files, 'scene');
    if (processed.sceneFiles.length > 0) {
      await importSceneFilesWithPluginWarning(processed.sceneFiles, { resultingScenePath: null });
    }
    if (processed.meshFiles.length > 0) {
      void scene.loadFiles(processed.meshFiles);
    }
  }, [expandPickedFilesWithZip, importSceneFilesWithPluginWarning, scene]);

  const handleReopenRecentFile = React.useCallback(async (entryId: string) => {
    const entry = recentOpenedFiles.find((item) => item.id === entryId);
    if (!entry) return false;

    if (entry.kind === 'scene' && entry.name.trim().toLowerCase().endsWith('.lys')) {
      const proceed = await maybeConfirmPluginImportWarning([
        new File([], entry.name, { type: 'application/octet-stream' }),
      ]);
      if (!proceed) return false;
    }

    const sourcePath = typeof entry.sourcePath === 'string' && entry.sourcePath.trim().length > 0
      ? entry.sourcePath.trim()
      : null;

    // Preferred path for desktop: reload from the original source file so the
    // editing session can resume with an overwrite-capable scene path.
    if (entry.kind === 'scene' && sourcePath) {
      try {
        const sourceBytes = await readPrintArtifactBytesFromPath(sourcePath);
        if (sourceBytes && sourceBytes.length > 0) {
          const restoredFile = new File([Uint8Array.from(sourceBytes)], entry.name, {
            type: getDroppedFileMimeType(entry.name),
            lastModified: Date.now(),
          });

          const importedFromSource = await importSceneFilesWithPluginWarning([restoredFile], {
            resultingScenePath: sourcePath,
            sourcePaths: [sourcePath],
          });

          if (importedFromSource) {
            return true;
          }
        }
      } catch (error) {
        console.warn('[RecentFiles] Failed reopening scene from original source path; falling back to cached copy.', error);
      }
    }

    const reopened = await reopenRecentOpenedFile(entryId);
    if (reopened && entry.kind === 'scene') {
      setActiveSceneFilePath(normalizeActiveVoxlScenePath(sourcePath));
      if (entry.name.trim().toLowerCase().endsWith('.voxl')) {
        setLoadedSceneSaveSource({
          name: entry.name,
          path: normalizeActiveVoxlScenePath(sourcePath),
        });
        markSceneSaveBaseline();
      } else {
        setLoadedSceneSaveSource(null);
      }
    }
    return reopened;
  }, [importSceneFilesWithPluginWarning, markSceneSaveBaseline, maybeConfirmPluginImportWarning, recentOpenedFiles, reopenRecentOpenedFile]);

  const buildSyntheticFileChangeEvent = React.useCallback((nextFiles: File[]): React.ChangeEvent<HTMLInputElement> => {
    const dt = new DataTransfer();
    nextFiles.forEach((file) => dt.items.add(file));
    const target = { files: dt.files, value: '' } as unknown as HTMLInputElement;
    return { target, currentTarget: target } as React.ChangeEvent<HTMLInputElement>;
  }, []);

  const [nativePickerPreparationState, setNativePickerPreparationState] = React.useState<{
    active: boolean;
    label: string;
    detail: string;
    progress: number | null;
  }>({
    active: false,
    label: '',
    detail: '',
    progress: null,
  });

  const waitForUiTick = React.useCallback(() => new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  }), []);

  const createPathBackedStlFile = React.useCallback((sourcePath: string, name: string): File => {
    const file = new File([], name, {
      type: getDroppedFileMimeType(name),
      lastModified: Date.now(),
    });
    (file as File & { filePath?: string }).filePath = sourcePath;
    return file;
  }, []);

  const pickFilesWithNativeDialog = React.useCallback(async (category: 'mesh' | 'scene', multiple: boolean): Promise<File[] | null> => {
    if (!deps.current.isDesktopRuntime()) return null;

    try {
      const picked = await pickOpenFilesWithNativeDialog(category, multiple);
      if (!picked || picked.length === 0) return [];

      const core = await import('@tauri-apps/api/core');
      const files: File[] = [];

      const readingLabel = category === 'scene' ? 'Loading Scene…' : 'Loading Mesh…';
      const singleNoun = category === 'scene' ? 'scene file' : 'mesh file';
      const pluralNoun = category === 'scene' ? 'scene files' : 'mesh files';

      setNativePickerPreparationState({
        active: true,
        label: readingLabel,
        detail: picked.length > 1
          ? `Reading 0/${picked.length} selected ${pluralNoun}…`
          : `Reading selected ${singleNoun}…`,
        progress: null,
      });
      await waitForUiTick();

      try {
        for (let i = 0; i < picked.length; i += 1) {
          const entry = picked[i];
        try {
          const sourcePath = entry.path.trim();
          if (!sourcePath) continue;

          const resolvedName = entry.name || getFileNameFromPath(sourcePath);
          setNativePickerPreparationState({
            active: true,
            label: readingLabel,
            detail: picked.length > 1
              ? `Reading ${i + 1}/${picked.length}: ${resolvedName}`
              : `Reading ${resolvedName}…`,
            progress: null,
          });

          const name = resolvedName;
          if (getFileExtensionLower(name) === '.stl') {
            files.push(createPathBackedStlFile(sourcePath, name));
          } else {
            const bytes = await core.invoke<ArrayBuffer>('read_print_file_bytes', { sourcePath });
            files.push(new File([new Uint8Array(bytes)], name, {
              type: getDroppedFileMimeType(name),
              lastModified: Date.now(),
            }));
          }
        } catch (error) {
          console.warn(`[Picker] Failed reading picked file path: ${entry.path}`, error);
        }
      }

        return files;
      } finally {
        setNativePickerPreparationState({
          active: false,
          label: '',
          detail: '',
          progress: null,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      const cancelled = message.toLowerCase().includes('cancel');
      if (cancelled) return [];
      console.warn(`[Picker] Native ${category} picker failed, falling back to web input.`, error);
      return null;
    }
  }, [createPathBackedStlFile, deps.current.isDesktopRuntime, waitForUiTick]);

  const pickFilesWithWebInput = React.useCallback((accept: string, multiple: boolean): Promise<File[]> => {
    return new Promise((resolve) => {
      if (typeof document === 'undefined') {
        resolve([]);
        return;
      }

      const input = document.createElement('input');
      input.type = 'file';
      // iOS WebKit greys out files whose extension it can't map to a known UTI
      // (e.g. .stl, .3mf), and it ignores MIME hints too, so drop the filter
      // there and rely on extension validation when the picked files are processed.
      input.accept = detectIsIOS() ? '' : accept;
      input.multiple = multiple;

      input.onchange = () => {
        resolve(Array.from(input.files ?? []));
      };

      input.click();
    });
  }, []);

  const pickSceneFilesWithNativeDialog = React.useCallback(async (): Promise<Array<{ file: File; sourcePath: string }> | null> => {
    if (!deps.current.isDesktopRuntime()) return null;

    try {
      const picked = await pickOpenFilesWithNativeDialog('scene', true);
      if (!picked || picked.length === 0) return [];

      const core = await import('@tauri-apps/api/core');
      const files: Array<{ file: File; sourcePath: string }> = [];

      setNativePickerPreparationState({
        active: true,
        label: 'Loading Scene…',
        detail: picked.length > 1
          ? `Reading 0/${picked.length} selected scene files…`
          : 'Reading selected scene file…',
        progress: null,
      });
      await waitForUiTick();

      try {
        for (let i = 0; i < picked.length; i += 1) {
          const entry = picked[i];
        try {
          const sourcePath = entry.path.trim();
          if (!sourcePath) continue;

          const resolvedName = entry.name || getFileNameFromPath(sourcePath);
          setNativePickerPreparationState({
            active: true,
            label: 'Loading Scene…',
            detail: picked.length > 1
              ? `Reading ${i + 1}/${picked.length}: ${resolvedName}`
              : `Reading ${resolvedName}…`,
            progress: null,
          });

          const bytes = await core.invoke<ArrayBuffer>('read_print_file_bytes', { sourcePath });
          const name = resolvedName;

          files.push({
            file: new File([new Uint8Array(bytes)], name, {
              type: getDroppedFileMimeType(name),
              lastModified: Date.now(),
            }),
            sourcePath,
          });
        } catch (error) {
          console.warn(`[Picker] Failed reading picked scene file path: ${entry.path}`, error);
        }
      }

        return files;
      } finally {
        setNativePickerPreparationState({
          active: false,
          label: '',
          detail: '',
          progress: null,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      const cancelled = message.toLowerCase().includes('cancel');
      if (cancelled) return [];
      console.warn('[Picker] Native scene picker failed, falling back to web input.', error);
      return null;
    }
  }, [deps.current.isDesktopRuntime, waitForUiTick]);

  const handleOpenMeshDialog = React.useCallback(async () => {
    const nativeFiles = await pickFilesWithNativeDialog('mesh', true);
    if (nativeFiles) {
      if (nativeFiles.length === 0) return;
      const expanded = await expandPickedFilesWithZip(nativeFiles, 'mesh');
      if (expanded.meshFiles.length > 0) {
        void scene.loadFiles(expanded.meshFiles);
      }
      if (expanded.sceneFiles.length > 0) {
        await importSceneFilesWithPluginWarning(expanded.sceneFiles, { resultingScenePath: null });
      }
      return;
    }

    const webFiles = await pickFilesWithWebInput('.stl,.obj,.3mf,.zip', true);
    if (webFiles.length === 0) return;
    const expanded = await expandPickedFilesWithZip(webFiles, 'mesh');
    if (expanded.meshFiles.length > 0) {
      scene.onFileChange(buildSyntheticFileChangeEvent(expanded.meshFiles));
    }
    if (expanded.sceneFiles.length > 0) {
      await importSceneFilesWithPluginWarning(expanded.sceneFiles, { resultingScenePath: null });
    }
  }, [buildSyntheticFileChangeEvent, importSceneFilesWithPluginWarning, pickFilesWithNativeDialog, pickFilesWithWebInput, scene, expandPickedFilesWithZip]);

  const handleOpenSceneDialog = React.useCallback(async () => {
    const nativeFiles = await pickSceneFilesWithNativeDialog();
    if (nativeFiles) {
      if (nativeFiles.length === 0) return;
      const nonZip = nativeFiles.filter((e) => getFileExtensionLower(e.file.name) !== '.zip');
      const zips = nativeFiles.filter((e) => getFileExtensionLower(e.file.name) === '.zip');
      const expandedFromZips = await expandPickedFilesWithZip(zips.map((e) => e.file), 'scene');
      const sceneFiles = [...nonZip.map((e) => e.file), ...expandedFromZips.sceneFiles];

      if (sceneFiles.length > 0) {
        await importSceneFilesWithPluginWarning(
          sceneFiles,
          {
            resultingScenePath: nonZip.length === 1 && expandedFromZips.sceneFiles.length === 0
              ? nativeFiles[0]?.sourcePath ?? null
              : null,
            sourcePaths: [
              ...nonZip.map((e) => e.sourcePath),
              ...Array.from({ length: expandedFromZips.sceneFiles.length }, () => null),
            ],
          },
        );
      }

      if (expandedFromZips.meshFiles.length > 0) {
        void scene.loadFiles(expandedFromZips.meshFiles);
      }
      return;
    }

    const webFiles = await pickFilesWithWebInput('.voxl,.lys,.zip', true);
    if (webFiles.length === 0) return;
    const expanded = await expandPickedFilesWithZip(webFiles, 'scene');
    if (expanded.sceneFiles.length > 0) {
      await importSceneFilesWithPluginWarning(expanded.sceneFiles, { resultingScenePath: null });
    }
    if (expanded.meshFiles.length > 0) {
      void scene.loadFiles(expanded.meshFiles);
    }
  }, [importSceneFilesWithPluginWarning, pickSceneFilesWithNativeDialog, pickFilesWithWebInput, expandPickedFilesWithZip]);

  const importSceneFromLaunchEntries = React.useCallback(async (entries: LaunchSceneFileEntry[]): Promise<boolean> => {
    if (!entries || entries.length === 0) return false;

    const sceneEntries = entries.filter((entry) => {
      const name = (entry.name || getFileNameFromPath(entry.path)).trim();
      return isSceneFileName(name);
    });

    if (sceneEntries.length === 0) return false;

    const core = await import('@tauri-apps/api/core');

    const files: File[] = [];
    for (const sceneEntry of sceneEntries) {
      const sourcePath = sceneEntry.path.trim();
      if (!sourcePath) continue;

      const bytes = await core.invoke<ArrayBuffer>('read_print_file_bytes', { sourcePath });
      const name = sceneEntry.name || getFileNameFromPath(sourcePath);
      files.push(new File([new Uint8Array(bytes)], name, {
        type: getDroppedFileMimeType(name),
        lastModified: Date.now(),
      }));
    }

    if (files.length === 0) return false;
    return await importSceneFilesWithPluginWarning(files, {
      resultingScenePath: files.length === 1 ? sceneEntries[0]?.path ?? null : null,
      sourcePaths: sceneEntries.map((entry) => entry.path),
    });
  }, [importSceneFilesWithPluginWarning]);

  // Keep the ref in sync with the latest callback.
  React.useEffect(() => {
    importSceneFromLaunchEntriesRef.current = importSceneFromLaunchEntries;
  }, [importSceneFromLaunchEntries]);

  const flushQueuedLaunchSceneImports = React.useCallback(async (): Promise<void> => {
    if (!startupSceneHandoffReadyRef.current) return;
    if (launchSceneImportInFlightRef.current) return;

    const queuedEntries = queuedLaunchSceneEntriesRef.current;
    if (!queuedEntries || queuedEntries.length === 0) {
      setPendingStartupSceneHandoff(false);
      return;
    }

    queuedLaunchSceneEntriesRef.current = [];
    launchSceneImportInFlightRef.current = true;

    try {
      const handler = importSceneFromLaunchEntriesRef.current;
      if (!handler) return;

      const imported = await handler(queuedEntries);
      if (!imported) {
        console.warn('[LaunchOpen] App launched with file arguments, but no supported scene file (.voxl/.lys) was found.');
      }
    } catch (error) {
      console.warn('[LaunchOpen] Failed handling queued launch scene file arguments.', error);
    } finally {
      launchSceneImportInFlightRef.current = false;
      const stillQueued = queuedLaunchSceneEntriesRef.current.length > 0;
      setPendingStartupSceneHandoff(stillQueued && !startupSceneHandoffReadyRef.current);
      if (stillQueued) {
        void flushQueuedLaunchSceneImports();
      }
    }
  }, []);

  const queueLaunchSceneEntries = React.useCallback((entries: LaunchSceneFileEntry[]) => {
    if (!entries || entries.length === 0) return;

    const merged = new Map<string, LaunchSceneFileEntry>();
    for (const entry of queuedLaunchSceneEntriesRef.current) {
      const key = entry.path.trim().toLowerCase();
      if (!key) continue;
      merged.set(key, entry);
    }
    for (const entry of entries) {
      const key = entry.path.trim().toLowerCase();
      if (!key) continue;
      merged.set(key, entry);
    }

    queuedLaunchSceneEntriesRef.current = Array.from(merged.values());

    if (!startupSceneHandoffReadyRef.current) {
      setPendingStartupSceneHandoff(true);
      return;
    }

    void flushQueuedLaunchSceneImports();
  }, [flushQueuedLaunchSceneImports]);

  React.useEffect(() => {
    if (!deps.current.isDesktopRuntime()) {
      startupSceneHandoffReadyRef.current = true;
      return;
    }

    if (coldStartSceneHandoffTimerRef.current !== null) {
      window.clearTimeout(coldStartSceneHandoffTimerRef.current);
    }

    coldStartSceneHandoffTimerRef.current = window.setTimeout(() => {
      coldStartSceneHandoffTimerRef.current = null;
      startupSceneHandoffReadyRef.current = true;
      void flushQueuedLaunchSceneImports();
    }, COLD_START_SCENE_HANDOFF_DELAY_MS);

    return () => {
      if (coldStartSceneHandoffTimerRef.current !== null) {
        window.clearTimeout(coldStartSceneHandoffTimerRef.current);
        coldStartSceneHandoffTimerRef.current = null;
      }
      startupSceneHandoffReadyRef.current = true;
    };
  }, [flushQueuedLaunchSceneImports, deps.current.isDesktopRuntime]);

  // Primary-launch file loading. Uses importSceneFromLaunchEntriesRef (a
  // stable ref) so this effect only runs once on mount and is never
  // cancelled mid-flight by scene re-renders during initialization.
  React.useEffect(() => {
    if (launchSceneFilesHandledRef.current) return;
    launchSceneFilesHandledRef.current = true;

    if (!deps.current.isDesktopRuntime()) return;

    void (async () => {
      try {
        const core = await import('@tauri-apps/api/core');
        const launchEntries = await core.invoke<LaunchSceneFileEntry[]>('get_launch_scene_files');
        if (!launchEntries || launchEntries.length === 0) return;

        queueLaunchSceneEntries(launchEntries);
      } catch (error) {
        console.warn('[LaunchOpen] Failed handling launch scene file arguments.', error);
      }
    })();
    // deps.current.isDesktopRuntime is a stable useCallback([]) — this effect runs once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps.current.isDesktopRuntime, queueLaunchSceneEntries]);

  React.useEffect(() => {
    if (!deps.current.isDesktopRuntime()) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        unlisten = await listen<SceneFileHandoffPayload>('dragonfruit://scene-file-handoff', (event) => {
          if (disposed) return;
          const paths = Array.isArray(event.payload?.paths) ? event.payload.paths : [];
          if (paths.length === 0) return;

          const entries: LaunchSceneFileEntry[] = paths
            .map((path) => {
              const trimmed = path.trim();
              if (!trimmed) return null;
              return {
                path: trimmed,
                name: getFileNameFromPath(trimmed),
              } satisfies LaunchSceneFileEntry;
            })
            .filter((entry): entry is LaunchSceneFileEntry => Boolean(entry));

          queueLaunchSceneEntries(entries);
        });
      } catch (error) {
        if (!disposed) {
          console.warn('[LaunchOpen] Failed subscribing to scene-file handoff events.', error);
        }
      }
    })();

    return () => {
      disposed = true;
      if (unlisten) {
        try {
          unlisten();
        } catch {
          // noop
        }
      }
    };
  }, [deps.current.isDesktopRuntime, queueLaunchSceneEntries]);

  const handleTopBarOpenScene = React.useCallback(() => {
    void handleOpenSceneDialog();
  }, [handleOpenSceneDialog]);

  const handleDroppedPrepareFiles = React.useCallback(async (
    files: File[],
    options?: { prearmedLoadingUi?: boolean },
  ) => {
    if (scene.mode !== 'prepare') return;

    const supportedFiles = files.filter((file) => isSupportedPrepareDropName(file.name));
    if (supportedFiles.length === 0) {
      console.warn('[DragDrop] No supported files dropped. Supported: .stl, .obj, .3mf, .lys, .voxl');
      return;
    }

    const signature = buildDroppedFilesSignature(supportedFiles);
    const nowMs = Date.now();
    const last = lastPrepareDropRef.current;
    if (signature.length > 0 && last.signature === signature && (nowMs - last.atMs) < 1500) {
      // Tauri desktop can emit both native drag-drop and DOM drop for a single gesture.
      // Ignore near-identical repeat payloads to prevent duplicate imports.
      return;
    }
    lastPrepareDropRef.current = { signature, atMs: nowMs };

    const meshFiles = supportedFiles.filter((file) => {
      const ext = getFileExtension(file.name);
      return ext === '.stl' || ext === '.obj' || ext === '.3mf';
    });
    const sceneFiles = supportedFiles.filter((file) => {
      const ext = getFileExtension(file.name);
      return ext === '.lys' || ext === '.voxl';
    });

    const buildSyntheticFileChangeEvent = (nextFiles: File[]): React.ChangeEvent<HTMLInputElement> => {
      const dt = new DataTransfer();
      nextFiles.forEach((file) => dt.items.add(file));
      const target = { files: dt.files, value: '' } as unknown as HTMLInputElement;
      return { target, currentTarget: target } as React.ChangeEvent<HTMLInputElement>;
    };

    if (sceneFiles.length > 0) {
      // Match "Import Scene" button behavior: when a scene file is present,
      // treat the drop as a scene import path and don't separately load mesh files.
      // Use the same handler as the Import Scene button.
      const shouldPrearmLoadingUi = !options?.prearmedLoadingUi;

      if (shouldPrearmLoadingUi) {
        setNativePickerPreparationState({
          active: true,
          label: sceneFiles.length > 1 ? 'Loading dropped scenes…' : 'Loading dropped scene…',
          detail: sceneFiles.length > 1
            ? `Preparing ${sceneFiles.length} dropped scene files…`
            : 'Preparing dropped scene file…',
          progress: null,
        });

        await waitForUiTick();
      }

      try {
        await importSceneFilesWithPluginWarning(sceneFiles);
      } finally {
        if (shouldPrearmLoadingUi) {
          setNativePickerPreparationState({
            active: false,
            label: '',
            detail: '',
            progress: null,
          });
        }
      }
      return;
    }

    if (meshFiles.length > 0) {
      // Use the same handler as the Load Mesh button.
      const meshEvent = buildSyntheticFileChangeEvent(meshFiles);
      scene.onFileChange(meshEvent);
    }
  }, [importSceneFilesWithPluginWarning, scene, waitForUiTick]);

  const createFilesFromTauriDroppedPaths = React.useCallback(async (paths: string[]) => {
    const normalizedSupportedPaths = paths
      .map((path) => path.trim())
      .filter((path) => path.length > 0)
      .filter((path) => isSupportedPrepareDropName(getFileNameFromPath(path)));

    if (normalizedSupportedPaths.length === 0) return [] as File[];

    try {
      const core = await import('@tauri-apps/api/core');
      const files: File[] = [];

      for (const sourcePath of normalizedSupportedPaths) {
        try {
          const name = getFileNameFromPath(sourcePath);
          if (getFileExtensionLower(name) === '.stl') {
            files.push(createPathBackedStlFile(sourcePath, name));
          } else {
            const bytes = await core.invoke<ArrayBuffer>('read_print_file_bytes', { sourcePath });
            files.push(new File([new Uint8Array(bytes)], name, {
              type: getDroppedFileMimeType(name),
              lastModified: Date.now(),
            }));
          }
        } catch (error) {
          console.warn(`[DragDrop] Failed reading dropped file path: ${sourcePath}`, error);
        }
      }

      return files;
    } catch {
      return [] as File[];
    }
  }, [createPathBackedStlFile]);

  const sceneModeRef = React.useRef(scene.mode);
  const createFilesFromTauriDroppedPathsRef = React.useRef(createFilesFromTauriDroppedPaths);
  const handleDroppedPrepareFilesRef = React.useRef(handleDroppedPrepareFiles);

  React.useEffect(() => {
    sceneModeRef.current = scene.mode;
  }, [scene.mode]);

  React.useEffect(() => {
    createFilesFromTauriDroppedPathsRef.current = createFilesFromTauriDroppedPaths;
  }, [createFilesFromTauriDroppedPaths]);

  React.useEffect(() => {
    handleDroppedPrepareFilesRef.current = handleDroppedPrepareFiles;
  }, [handleDroppedPrepareFiles]);

  React.useEffect(() => {
    if (scene.mode !== 'prepare') return;
    if (typeof window === 'undefined') return;

    const isLikelyDesktopRuntime =
      window.location.protocol === 'tauri:'
      || window.location.protocol === 'file:'
      || window.location.hostname === 'tauri.localhost'
      || typeof (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';

    if (!isLikelyDesktopRuntime) return;

    const unlisten: Array<() => void | Promise<void>> = [];
    let disposed = false;

    const invokeUnlistenSafely = (remove: (() => void | Promise<void>) | undefined) => {
      if (!remove) return;
      try {
        const result = remove();
        if (result && typeof result.then === 'function') {
          void result.catch(() => {
            // noop
          });
        }
      } catch {
        // noop
      }
    };

    const registerUnlisten = (remove: () => void | Promise<void>) => {
      if (disposed) {
        invokeUnlistenSafely(remove);
        return;
      }
      unlisten.push(remove);
    };

    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        const unlistenDragOver = await listen<unknown>('tauri://drag-over', (event) => {
          if (disposed || sceneModeRef.current !== 'prepare') return;
          setIsPrepareDragActive(true);

          const paths = extractTauriDroppedPaths(event.payload);
          if (paths.length === 0) {
            return;
          }

          const hasSupportedPath = paths.some((path) => {
            const fileName = getFileNameFromPath(path);
            return isSupportedPrepareDropName(fileName);
          });
          setIsPrepareDragUnsupported(!hasSupportedPath);
        });
        registerUnlisten(unlistenDragOver);

        const hideOverlay = () => {
          dragDepthRef.current = 0;
          setIsPrepareDragActive(false);
          setIsPrepareDragUnsupported(false);
        };

        const unlistenDragLeave = await listen('tauri://drag-leave', () => {
          if (disposed) return;
          hideOverlay();
        });
        registerUnlisten(unlistenDragLeave);

        const unlistenDragCancelled = await listen('tauri://drag-drop-cancelled', () => {
          if (disposed) return;
          hideOverlay();
        });
        registerUnlisten(unlistenDragCancelled);

        const unlistenDragDrop = await listen<unknown>('tauri://drag-drop', (event) => {
          if (disposed || sceneModeRef.current !== 'prepare') return;

          hideOverlay();

          const paths = extractTauriDroppedPaths(event.payload);
          if (paths.length === 0) return;

          const supportedPathCount = paths.filter((path) => {
            const fileName = getFileNameFromPath(path);
            return isSupportedPrepareDropName(fileName);
          }).length;

          void (async () => {
            if (supportedPathCount > 0) {
              setNativePickerPreparationState({
                active: true,
                label: 'Loading dropped files…',
                detail: supportedPathCount > 1
                  ? `Reading 0/${supportedPathCount} dropped files…`
                  : 'Reading dropped file…',
                progress: null,
              });

              await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
              });
            }

            try {
              const files = await createFilesFromTauriDroppedPathsRef.current(paths);
              if (files.length === 0) return;
              await handleDroppedPrepareFilesRef.current(files, { prearmedLoadingUi: true });
            } finally {
              if (supportedPathCount > 0) {
                setNativePickerPreparationState({
                  active: false,
                  label: '',
                  detail: '',
                  progress: null,
                });
              }
            }
          })();
        });
        registerUnlisten(unlistenDragDrop);
      } catch {
        // Ignore in non-Tauri environments or when listeners are unavailable.
      }
    })();

    return () => {
      disposed = true;
      while (unlisten.length > 0) {
        const remove = unlisten.pop();
        invokeUnlistenSafely(remove);
      }
    };
  }, [scene.mode]);

  const handlePrepareDragEnter = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (scene.mode !== 'prepare') return;
    if (!isLikelyFileDragPayload(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    const supportState = getPrepareDropSupportStateFromDataTransfer(e.dataTransfer);
    if (supportState === 'unsupported') {
      setIsPrepareDragUnsupported(true);
    } else if (supportState === 'supported') {
      setIsPrepareDragUnsupported(false);
    }
    setIsPrepareDragActive(true);
  }, [scene.mode]);

  const handlePrepareDragOver = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (scene.mode !== 'prepare') return;
    if (!isLikelyFileDragPayload(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    const supportState = getPrepareDropSupportStateFromDataTransfer(e.dataTransfer);
    if (supportState === 'unsupported') {
      setIsPrepareDragUnsupported(true);
    } else if (supportState === 'supported') {
      setIsPrepareDragUnsupported(false);
    }
    e.dataTransfer.dropEffect = supportState === 'unsupported' ? 'none' : 'copy';
    setIsPrepareDragActive(true);
  }, [scene.mode]);

  const handlePrepareDragLeave = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (scene.mode !== 'prepare') return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsPrepareDragActive(false);
      setIsPrepareDragUnsupported(false);
    }
  }, [scene.mode]);

  const handlePrepareDrop = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (scene.mode !== 'prepare') return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setIsPrepareDragActive(false);
    setIsPrepareDragUnsupported(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;

    const supportedFileCount = files.filter((file) => isSupportedPrepareDropName(file.name)).length;

    if (supportedFileCount > 0) {
      void (async () => {
        setNativePickerPreparationState({
          active: true,
          label: 'Loading dropped files…',
          detail: supportedFileCount > 1
            ? `Preparing ${supportedFileCount} dropped files…`
            : 'Preparing dropped file…',
          progress: null,
        });

        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });

        try {
          await handleDroppedPrepareFiles(files, { prearmedLoadingUi: true });
        } finally {
          setNativePickerPreparationState({
            active: false,
            label: '',
            detail: '',
            progress: null,
          });
        }
      })();
      return;
    }

    void handleDroppedPrepareFiles(files);
  }, [handleDroppedPrepareFiles, scene.mode]);

  const runExportThumbnailCapture = React.useCallback(async () => {
    const capture = exportThumbnailCaptureRef.current;
    if (!capture) return null;

    const previousLayerIndex = deps.current.slicing.layerIndex;
    const previousActiveModelId = scene.activeModelId;
    const previousSelectedModelIds = scene.selectedModelIds;
    const previousSelectAllActive = deps.current.isSelectAllModelsActive;
    const visibleModelIds = scene.models.filter((model) => model.visible).map((model) => model.id);
    const forcedActiveModelId = visibleModelIds[0] ?? null;

    const sameSelection = (
      previousSelectedModelIds.length === visibleModelIds.length
      && previousSelectedModelIds.every((id, index) => id === visibleModelIds[index])
    );

    const shouldResetLayer = previousLayerIndex !== 0;
    const shouldSetSelection = visibleModelIds.length > 0 && !sameSelection;
    const shouldSetActive = forcedActiveModelId !== previousActiveModelId;
    const shouldSetSelectAllVisual = !previousSelectAllActive;

    try {
      // Ensure export thumbnail shows full geometry (no cross-section clipping)
      // and equivalent to Ctrl+A model visibility context.
      if (shouldResetLayer) {
        deps.current.slicing.setLayerIndex(0);
      }

      if (visibleModelIds.length > 0) {
        if (shouldSetSelection) {
          scene.setSelectedModelIds(visibleModelIds);
        }
        if (shouldSetActive) {
          scene.setActiveModelId(forcedActiveModelId);
        }
        if (shouldSetSelectAllVisual) {
          deps.current.setIsSelectAllModelsActive(true);
        }
      }

      if (shouldResetLayer || shouldSetSelection || shouldSetActive || shouldSetSelectAllVisual) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }

      return await capture();
    } finally {
      if (shouldResetLayer) {
        deps.current.slicing.setLayerIndex(previousLayerIndex);
      }
      if (shouldSetSelection) {
        scene.setSelectedModelIds(previousSelectedModelIds);
      }
      if (shouldSetActive) {
        scene.setActiveModelId(previousActiveModelId);
      }
      if (shouldSetSelectAllVisual) {
        deps.current.setIsSelectAllModelsActive(previousSelectAllActive);
      }
    }
  }, [
    deps.current.isSelectAllModelsActive,
    scene.activeModelId,
    scene.models,
    scene.selectedModelIds,
    scene.setActiveModelId,
    scene.setSelectedModelIds,
    deps.current.slicing.layerIndex,
    deps.current.slicing.setLayerIndex,
  ]);

  React.useEffect(() => {
    exportThumbnailCaptureRunnerRef.current = runExportThumbnailCapture;
  }, [runExportThumbnailCapture]);

  return {
    isPrepareDragActive,
    setIsPrepareDragActive,
    isPrepareDragUnsupported,
    setIsPrepareDragUnsupported,
    exportThumbnailCaptureRunnerRef,
    handleRegisterExportThumbnailCapture,
    captureExportThumbnailPng,
    runExportThumbnailCapture,
    zipPickerState,
    setZipPickerState,
    zipPickerResolveRef,
    nativePickerPreparationState,
    setNativePickerPreparationState,
    pendingStartupSceneHandoff,
    setPendingStartupSceneHandoff,
    handleTopBarOpenScene,
    handleImportSceneInputChange,
    handleLoadMeshChangeWithZip,
    handleImportSceneChangeWithZip,
    handleReopenRecentFile,
    handleOpenMeshDialog,
    handleOpenSceneDialog,
    importSceneFilesWithPluginWarning,
    handleDroppedPrepareFiles,
    handlePrepareDragEnter,
    handlePrepareDragOver,
    handlePrepareDragLeave,
    handlePrepareDrop,
  };
}

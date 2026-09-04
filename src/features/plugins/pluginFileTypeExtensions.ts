import React from 'react';
import { getBuiltinComplexPluginDefinitions } from './builtinComplexPlugins';
import { computeGatedPluginIds, EXPERIMENT_DEFINITIONS, getEnabledExperimentIds, subscribeToExperiments } from '@/features/experiments/experimentsRegistry';
import { GENERATED_BUILTIN_COMPLEX_PLUGIN_DEFINITIONS } from '@/features/plugins/generatedBuiltinComplexPlugins';

// Server snapshot must match what SSR renders (window === undefined -> defaultEnabled).
// On the client, getServerSnapshot is called during hydration to compare against SSR HTML,
// so it must return the *server* value (without gated plugins like .chitubox), not the
// client-enabled value, otherwise React reports a hydration mismatch.
const SERVER_GATED_IDS = computeGatedPluginIds(EXPERIMENT_DEFINITIONS, (id) => EXPERIMENT_DEFINITIONS.find((e) => e.id === id)?.defaultEnabled ?? false);
const SERVER_PLUGIN_DEFINITIONS = GENERATED_BUILTIN_COMPLEX_PLUGIN_DEFINITIONS.filter((def) => !SERVER_GATED_IDS.has(def.id));
const SERVER_PLUGIN_CONTRIBUTED: readonly string[] = Object.freeze(
  SERVER_PLUGIN_DEFINITIONS.flatMap((def) => def.fileTypes ?? []).map((ft) => ft.fileExtension.replace(/^\./, '').toLowerCase()),
);
const SERVER_PLUGIN_SCENE: readonly string[] = Object.freeze(
  SERVER_PLUGIN_DEFINITIONS.flatMap((def) => def.fileTypes ?? [])
    .filter((ft) => ft.isSceneFile)
    .map((ft) => ft.fileExtension.replace(/^\./, '').toLowerCase()),
);
const SERVER_SCENE: readonly string[] = Object.freeze(['voxl', ...SERVER_PLUGIN_SCENE]);
const SERVER_LABELS: string[] = SERVER_SCENE.map((ext) => ext.toUpperCase());
const SERVER_ACCEPT_WITH_ZIP: string = [...SERVER_SCENE.map((ext) => `.${ext}`), '.zip'].join(',');
const SERVER_ACCEPT_WITHOUT_ZIP: string = SERVER_SCENE.map((ext) => `.${ext}`).join(',');

// Client snapshots are cached by enabled-experiment key so getSnapshot returns stable refs.
let cachedKey: string | null = null;
let cachedPluginContributed: readonly string[] | null = null;
let cachedPluginScene: readonly string[] | null = null;
let cachedScene: readonly string[] | null = null;
let cachedLabels: string[] | null = null;
let cachedAcceptWithZip: string | null = null;
let cachedAcceptWithoutZip: string | null = null;

function getEnabledKey(): string {
  return getEnabledExperimentIds().slice().sort().join('|');
}

function ensureCache(): void {
  const key = getEnabledKey();
  if (cachedKey === key && cachedPluginContributed && cachedPluginScene && cachedScene && cachedLabels && cachedAcceptWithZip !== null && cachedAcceptWithoutZip !== null) return;
  cachedKey = key;
  cachedPluginContributed = Object.freeze(
    getBuiltinComplexPluginDefinitions()
      .flatMap((def) => def.fileTypes ?? [])
      .map((ft) => ft.fileExtension.replace(/^\./, '').toLowerCase()),
  );
  cachedPluginScene = Object.freeze(
    getBuiltinComplexPluginDefinitions()
      .flatMap((def) => def.fileTypes ?? [])
      .filter((ft) => ft.isSceneFile)
      .map((ft) => ft.fileExtension.replace(/^\./, '').toLowerCase()),
  );
  cachedScene = Object.freeze(['voxl', ...cachedPluginScene]);
  cachedLabels = cachedScene.map((ext) => ext.toUpperCase());
  const base = cachedScene.map((ext) => `.${ext}`);
  cachedAcceptWithZip = [...base, '.zip'].join(',');
  cachedAcceptWithoutZip = base.join(',');
}

function getPluginContributedFileExtensionsSnapshot(): readonly string[] {
  ensureCache();
  return cachedPluginContributed!;
}

function getPluginSceneFileExtensionsSnapshot(): readonly string[] {
  ensureCache();
  return cachedPluginScene!;
}

function getSceneFileExtensionsSnapshot(): readonly string[] {
  ensureCache();
  return cachedScene!;
}

function getSceneFileInputAcceptSnapshot(includeZip = true): string {
  ensureCache();
  return includeZip ? cachedAcceptWithZip! : cachedAcceptWithoutZip!;
}

function getSceneFileExtensionLabelsSnapshot(): string[] {
  ensureCache();
  return cachedLabels!;
}

/**
 * File extensions contributed by built-in fileType plugins (without leading dot, lowercase).
 * Derived at module load time from the auto-generated plugin registry (filtered
 * to exclude plugins gated behind disabled experiments).
 * For render paths that must stay hydration-safe, prefer the `use*` hooks below.
 */
export const PLUGIN_CONTRIBUTED_FILE_EXTENSIONS: readonly string[] = getPluginContributedFileExtensionsSnapshot();

/**
 * Scene file extensions contributed by built-in plugins (without leading dot,
 * lowercase). Only `isSceneFile` types are included -- these are the formats the
 * host routes through a plugin handler rather than loading as a plain mesh.
 * For render paths that must stay hydration-safe, prefer the `use*` hooks below.
 */
export const PLUGIN_SCENE_FILE_EXTENSIONS: readonly string[] = getPluginSceneFileExtensionsSnapshot();

/**
 * Every scene extension the app can open: the built-in `.voxl` plus whatever
 * plugins contribute. Mirrors the Rust-side list the native file dialog builds,
 * so both pickers offer the same formats.
 * For render paths that must stay hydration-safe, prefer the `use*` hooks below.
 */
export const SCENE_FILE_EXTENSIONS: readonly string[] = getSceneFileExtensionsSnapshot();

/**
 * `accept` attribute for a scene `<input type="file">`, e.g. ".voxl,.lys,.zip".
 * `.zip` is appended because scene bundles are accepted alongside loose files.
 * Imperative callers (file pickers) may call this directly; React render paths
 * should use `useSceneFileInputAccept()` to avoid hydration mismatches when
 * plugin-gated extensions (e.g. `.chitubox` behind an experiment) differ between
 * SSR (no localStorage) and the hydrated client.
 */
export function sceneFileInputAccept(includeZip = true): string {
  return getSceneFileInputAcceptSnapshot(includeZip);
}

/** Uppercase scene format names for display, e.g. "VOXL, LYS, CHITUBOX". */
export function sceneFileExtensionLabels(): string[] {
  return getSceneFileExtensionLabelsSnapshot();
}

/**
 * Regex that strips all known source file extensions from the tail of a filename,
 * including chained suffixes (e.g. "model.stl.lys" → "model").
 *
 * Core extensions are hardcoded here; plugin-contributed extensions are included
 * automatically from the generated plugin registry.
 */
export const KNOWN_SOURCE_EXTENSION_STRIP_RE: RegExp = (() => {
  const core = ['stl', 'obj', '3mf', 'json', 'voxl'];
  const all = [...core, ...PLUGIN_CONTRIBUTED_FILE_EXTENSIONS];
  return new RegExp(`(\\.(${all.join('|')}))+$`, 'i');
})();

// ---------------------------------------------------------------------------
// Hydration-safe hooks — use these inside React render for any UI that
// surfaces scene extensions. Server and initial client render use the
// SERVER_* constants (defaults) so hydration matches; after mount the
// hooks sync to the localStorage-aware snapshot and subscribe to experiment
// changes. This avoids the useSyncExternalStore server-snapshot caching
// pitfalls and guarantees no hydration mismatch for gated extensions.
// ---------------------------------------------------------------------------
export function usePluginContributedFileExtensions(): readonly string[] {
  const [value, setValue] = React.useState<readonly string[]>(() => SERVER_PLUGIN_CONTRIBUTED);
  React.useEffect(() => {
    setValue(getPluginContributedFileExtensionsSnapshot());
    return subscribeToExperiments(() => setValue(getPluginContributedFileExtensionsSnapshot()));
  }, []);
  return value;
}

export function usePluginSceneFileExtensions(): readonly string[] {
  const [value, setValue] = React.useState<readonly string[]>(() => SERVER_PLUGIN_SCENE);
  React.useEffect(() => {
    setValue(getPluginSceneFileExtensionsSnapshot());
    return subscribeToExperiments(() => setValue(getPluginSceneFileExtensionsSnapshot()));
  }, []);
  return value;
}

export function useSceneFileExtensions(): readonly string[] {
  const [value, setValue] = React.useState<readonly string[]>(() => SERVER_SCENE);
  React.useEffect(() => {
    setValue(getSceneFileExtensionsSnapshot());
    return subscribeToExperiments(() => setValue(getSceneFileExtensionsSnapshot()));
  }, []);
  return value;
}

export function useSceneFileInputAccept(includeZip = true): string {
  const [value, setValue] = React.useState<string>(() => (includeZip ? SERVER_ACCEPT_WITH_ZIP : SERVER_ACCEPT_WITHOUT_ZIP));
  React.useEffect(() => {
    setValue(getSceneFileInputAcceptSnapshot(includeZip));
    return subscribeToExperiments(() => setValue(getSceneFileInputAcceptSnapshot(includeZip)));
  }, [includeZip]);
  return value;
}

export function useSceneFileExtensionLabels(): string[] {
  const [value, setValue] = React.useState<string[]>(() => SERVER_LABELS);
  React.useEffect(() => {
    setValue(getSceneFileExtensionLabelsSnapshot());
    return subscribeToExperiments(() => setValue(getSceneFileExtensionLabelsSnapshot()));
  }, []);
  return value;
}

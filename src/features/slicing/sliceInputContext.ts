import {
  DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
  getActiveMaterialProfile,
  getActivePrinterProfile,
  getProfileStoreSnapshot,
  subscribeToProfileStore,
  type MaterialProfile,
  type PrinterProfile,
  type ProfileStoreState,
} from '@/features/profiles/profileStore';
import {
  getPrinterReachabilitySnapshot,
  subscribeToPrinterReachability,
  type PrinterReachabilityMap,
} from '@/features/network/printerReachabilityStore';
import { getProfileNetworkUiAdapter } from '@/features/plugins/pluginRegistry';
import { DEFAULT_SAVED_CURVES, type SavedCurve } from './lutCurves';
import type { AaAutoPresetChoice, SliceAntiAliasingOverride, SliceJobAntiAliasingRequest } from './sliceAntiAliasing';

export const SLICING_AA_AUTO_PRESET_STORAGE_KEY = 'dragonfruit.slicing.aaAutoPreset';
export const SLICING_3DAA_SAVED_CURVES_STORAGE_KEY = 'dragonfruit.slicing.3daaSavedCurves';
export const SLICING_SESSION_AA_OVERRIDE_STORAGE_KEY = 'dragonfruit.slicing.sessionAaOverrideByMaterial.v1';
export const SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY = 'dragonfruit.slicing.remoteOfflineLayerHeightMm';
export const REMOTE_OFFLINE_LAYER_HEIGHT_CHANGED_EVENT = 'dragonfruit:slicing-remote-offline-layer-height-changed';
const SLICE_INPUT_PREFERENCES_CHANGED_EVENT = 'dragonfruit:slicing-input-preferences-changed';

export type StoredSliceInputValues = {
  preset: string | null;
  curves: string | null;
  sessionOverride: string | null;
  offlineLayerHeight: string | null;
};

/** Storage precedence is the panel's: curves/session overrides are session-first. */
export function readStoredSliceInputValues(): StoredSliceInputValues {
  if (typeof window === 'undefined') return { preset: null, curves: null, sessionOverride: null, offlineLayerHeight: null };
  return {
    preset: window.localStorage.getItem(SLICING_AA_AUTO_PRESET_STORAGE_KEY)
      ?? window.sessionStorage.getItem(SLICING_AA_AUTO_PRESET_STORAGE_KEY),
    curves: window.sessionStorage.getItem(SLICING_3DAA_SAVED_CURVES_STORAGE_KEY)
      ?? window.localStorage.getItem(SLICING_3DAA_SAVED_CURVES_STORAGE_KEY),
    sessionOverride: window.sessionStorage.getItem(SLICING_SESSION_AA_OVERRIDE_STORAGE_KEY),
    offlineLayerHeight: window.localStorage.getItem(SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY)
      ?? window.sessionStorage.getItem(SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY),
  };
}

export function resolveInitialAaAutoPreset(raw = readStoredSliceInputValues().preset): AaAutoPresetChoice {
  return raw === 'raw' || raw === 'sharp' || raw === 'smooth' ? raw : 'balanced';
}

export function resolveInitialSavedCurves(raw?: string | null): SavedCurve[] {
  try {
    const stored = raw === undefined ? readStoredSliceInputValues().curves : raw;
    if (stored) {
      const parsed = JSON.parse(stored) as SavedCurve[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch { /* ignore malformed persisted curves, as the panel does */ }
  return DEFAULT_SAVED_CURVES;
}

export function readSessionAaOverride(profile: MaterialProfile, raw?: string | null): SliceAntiAliasingOverride | null {
  try {
    const stored = raw === undefined ? readStoredSliceInputValues().sessionOverride : raw;
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entry = parsed[profile.id];
    if (!entry || typeof entry !== 'object') return null;
    const minimumAaAlphaPercent = Number(entry.minimumAaAlphaPercent);
    return {
      minimumAaAlphaPercent: Number.isFinite(minimumAaAlphaPercent)
        ? Math.max(0, Math.min(100, Math.round(minimumAaAlphaPercent)))
        : profile.minimumAaAlphaPercent,
      antiAliasingSettings: {
        ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
        ...(profile.antiAliasingSettings ?? {}),
        ...(entry.antiAliasingSettings && typeof entry.antiAliasingSettings === 'object' ? entry.antiAliasingSettings : {}),
      },
    };
  } catch {
    return null;
  }
}

export function clampRemoteOfflineLayerHeightMm(value: number, fallback = 0.05): number {
  const fallbackClamped = Math.max(0.01, Math.min(1, fallback));
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallbackClamped;
  return Math.round(Math.max(0.01, Math.min(1, numeric)) * 1000) / 1000;
}

export function resolveInitialRemoteOfflineLayerHeightMm(raw = readStoredSliceInputValues().offlineLayerHeight): number {
  if (raw == null || raw.trim().length === 0) return 0.05;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? clampRemoteOfflineLayerHeightMm(parsed) : 0.05;
}

/** The same remote-material and offline-layer-height calculation used by the panel. */
export function resolveSliceMaterialInput(input: {
  printerProfile: PrinterProfile | null;
  materialProfile: MaterialProfile | null;
  reachability: PrinterReachabilityMap;
  networkUiAdapter: { supportsRemoteMaterialProfiles?: boolean } | null | undefined;
  remoteOfflineLayerHeightMm: number;
}) {
  const { printerProfile, materialProfile, reachability, networkUiAdapter, remoteOfflineLayerHeightMm } = input;
  const connectionIp = printerProfile?.networkConnection?.ipAddress?.trim().toLowerCase() ?? '';
  const selectedNetworkDeviceId = printerProfile?.activeNetworkDeviceId?.trim()
    || (connectionIp ? printerProfile?.networkFleet?.find((device) => (device.ipAddress || '').trim().toLowerCase() === connectionIp)?.id : null)
    || null;
  const isRemoteNetworkUnavailable = Boolean(networkUiAdapter) && (
    printerProfile?.networkConnection?.connected !== true
    || (selectedNetworkDeviceId != null && reachability[selectedNetworkDeviceId] === false)
  );
  const showRemoteOfflineLayerHeightOverride = Boolean(networkUiAdapter)
    && isRemoteNetworkUnavailable
    && networkUiAdapter?.supportsRemoteMaterialProfiles !== false;
  const effectiveDeviceId = printerProfile?.activeNetworkDeviceId?.trim()
    || printerProfile?.networkFleet?.find((device) => (device.ipAddress || '').trim().toLowerCase() === connectionIp)?.id;
  let effectiveMaterialProfile = materialProfile;
  if (materialProfile && printerProfile && networkUiAdapter && !isRemoteNetworkUnavailable
    && (!effectiveDeviceId || reachability[effectiveDeviceId] !== false)
    && printerProfile.networkConnection?.selectedMaterialId?.trim()) {
    const connection = printerProfile.networkConnection;
    const layerHeight = Number(connection.selectedMaterialLayerHeightMm);
    const normalExposure = Number(connection.selectedMaterialNormalExposureSec);
    const bottomExposure = Number(connection.selectedMaterialBottomExposureSec);
    const bottomLayers = Number(connection.selectedMaterialBottomLayerCount);
    effectiveMaterialProfile = {
      ...materialProfile,
      name: connection.selectedMaterialName?.trim() || materialProfile.name,
      layerHeightMm: Number.isFinite(layerHeight) && layerHeight > 0 ? layerHeight : materialProfile.layerHeightMm,
      normalExposureSec: Number.isFinite(normalExposure) && normalExposure > 0 ? normalExposure : materialProfile.normalExposureSec,
      bottomExposureSec: Number.isFinite(bottomExposure) && bottomExposure > 0 ? bottomExposure : materialProfile.bottomExposureSec,
      bottomLayerCount: Number.isFinite(bottomLayers) && bottomLayers >= 0 ? bottomLayers : materialProfile.bottomLayerCount,
    };
  }
  const materialHeight = Number(effectiveMaterialProfile?.layerHeightMm);
  const effectiveLayerHeightMm = showRemoteOfflineLayerHeightOverride
    ? clampRemoteOfflineLayerHeightMm(remoteOfflineLayerHeightMm, clampRemoteOfflineLayerHeightMm(materialProfile?.layerHeightMm ?? 0.05))
    : effectiveMaterialProfile
      ? (Number.isFinite(materialHeight) ? Math.round(Math.max(0.001, Math.min(1, materialHeight)) * 1000) / 1000 : 0.05)
      : null;
  const materialProfileForSlicing = effectiveMaterialProfile ? {
    ...effectiveMaterialProfile,
    layerHeightMm: effectiveLayerHeightMm ?? clampRemoteOfflineLayerHeightMm(materialProfile?.layerHeightMm ?? 0.05),
  } : null;
  return {
    selectedNetworkDeviceId,
    isRemoteNetworkUnavailable,
    showRemoteOfflineLayerHeightOverride,
    effectiveMaterialProfile,
    effectiveLayerHeightMm,
    materialProfileForSlicing,
  };
}

export type SceneSliceMeshWarmupContext = {
  printerProfile: PrinterProfile;
  materialProfile: MaterialProfile;
  antiAliasing: SliceJobAntiAliasingRequest;
  targetPlateId?: string;
};

type PanelSliceMeshWarmupInput = {
  /** A publication may override preferences only for the profile revision it rendered. */
  profileState: ProfileStoreState;
  antiAliasing: SliceJobAntiAliasingRequest;
  remoteOfflineLayerHeightMm: number;
  targetPlateId?: string;
};

let publishedInput: PanelSliceMeshWarmupInput | null = null;
let publishedStoredKey = '';
const listeners = new Set<() => void>();
let stopSubscriptions: (() => void) | null = null;
let cachedDependencies: { profiles: ProfileStoreState; reachability: PrinterReachabilityMap; storedKey: string; publication: PanelSliceMeshWarmupInput | null } | null = null;
let cachedContext: SceneSliceMeshWarmupContext | null = null;
function sameSliceInputValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameSliceInputValue(left[key], right[key]));
}

/** Publish live panel choices, never profiles or geometry. Clear only when that panel unmounts. */
export function publishSliceMeshWarmupContext(input: PanelSliceMeshWarmupInput | null): void {
  publishedInput = input;
  publishedStoredKey = JSON.stringify(readStoredSliceInputValues());
  listeners.forEach((listener) => listener());
}

export function notifySliceMeshWarmupPreferencesChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SLICE_INPUT_PREFERENCES_CHANGED_EVENT));
}

/** Safe as an external-store snapshot: repeated reads retain identity until resolved inputs change. */
export function readSliceMeshWarmupContext(): SceneSliceMeshWarmupContext | null {
  const profiles = getProfileStoreSnapshot();
  const reachability = getPrinterReachabilitySnapshot();
  const stored = readStoredSliceInputValues();
  const storedKey = JSON.stringify(stored);
  if (cachedDependencies?.profiles === profiles && cachedDependencies.reachability === reachability
    && cachedDependencies.storedKey === storedKey && cachedDependencies.publication === publishedInput) return cachedContext;
  cachedDependencies = { profiles, reachability, storedKey, publication: publishedInput };
  const printerProfile = getActivePrinterProfile(profiles);
  const materialProfile = getActiveMaterialProfile(profiles);
  const live = publishedInput?.profileState === profiles ? publishedInput : null;
  const livePreferences = publishedStoredKey === storedKey ? live : null;
  const material = resolveSliceMaterialInput({
    printerProfile,
    materialProfile,
    reachability,
    networkUiAdapter: getProfileNetworkUiAdapter(printerProfile?.networkSupport),
    remoteOfflineLayerHeightMm: livePreferences?.remoteOfflineLayerHeightMm ?? resolveInitialRemoteOfflineLayerHeightMm(stored.offlineLayerHeight),
  }).materialProfileForSlicing;
  const next = printerProfile && material ? {
    printerProfile,
    materialProfile: material,
    antiAliasing: livePreferences?.antiAliasing ?? {
      preset: resolveInitialAaAutoPreset(stored.preset),
      override: materialProfile ? readSessionAaOverride(materialProfile, stored.sessionOverride) : null,
      lutCurves: resolveInitialSavedCurves(stored.curves),
    },
    ...(live?.targetPlateId ? { targetPlateId: live.targetPlateId } : {}),
  } : null;
  if (next && cachedContext) {
    if (sameSliceInputValue(next.printerProfile, cachedContext.printerProfile)) next.printerProfile = cachedContext.printerProfile;
    if (sameSliceInputValue(next.materialProfile, cachedContext.materialProfile)) next.materialProfile = cachedContext.materialProfile;
    if (sameSliceInputValue(next.antiAliasing, cachedContext.antiAliasing)) next.antiAliasing = cachedContext.antiAliasing;
  }
  if (!sameSliceInputValue(next, cachedContext)) cachedContext = next;
  return cachedContext;
}

export function subscribeToSliceInputPreferences(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key == null || [SLICING_AA_AUTO_PRESET_STORAGE_KEY, SLICING_3DAA_SAVED_CURVES_STORAGE_KEY,
      SLICING_SESSION_AA_OVERRIDE_STORAGE_KEY, SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY].includes(event.key)) listener();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(SLICE_INPUT_PREFERENCES_CHANGED_EVENT, listener);
  window.addEventListener(REMOTE_OFFLINE_LAYER_HEIGHT_CHANGED_EVENT, listener);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(SLICE_INPUT_PREFERENCES_CHANGED_EVENT, listener);
    window.removeEventListener(REMOTE_OFFLINE_LAYER_HEIGHT_CHANGED_EVENT, listener);
  };
}

export function subscribeToSliceMeshWarmupContext(listener: () => void): () => void {
  listeners.add(listener);
  if (!stopSubscriptions) {
    const notify = () => listeners.forEach((subscriber) => subscriber());
    const stopProfiles = subscribeToProfileStore(notify);
    const stopReachability = subscribeToPrinterReachability(notify);
    const stopPreferences = subscribeToSliceInputPreferences(notify);
    stopSubscriptions = () => {
      stopProfiles();
      stopReachability();
      stopPreferences();
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopSubscriptions?.();
      stopSubscriptions = null;
    }
  };
}

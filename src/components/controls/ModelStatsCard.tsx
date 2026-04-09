
import React from 'react';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import {
  getActiveMaterialProfile,
  getActivePrinterProfile,
  getProfileStoreSnapshot,
  getProfileStoreServerSnapshot,
  subscribeToProfileStore,
} from '@/features/profiles/profileStore';
import { openProfileSettingsModal } from '@/components/settings/profileModalEvents';

interface ModelStatsCardProps {
  model: LoadedModel | null;
  models: LoadedModel[];
  selectedModelIds: string[];
  inBoundsModelIds: string[];
  numLayers: number;
  heightMm: number;
  estimatedPrintTimeLabelOverride?: string | null;
  estimatedResinLabelOverride?: string | null;
}

export function ModelStatsCard({
  model,
  models,
  selectedModelIds,
  inBoundsModelIds,
  numLayers,
  heightMm,
  estimatedPrintTimeLabelOverride,
  estimatedResinLabelOverride,
}: ModelStatsCardProps) {
  const [isFlipped, setIsFlipped] = React.useState(false);
  const baseResinMlCacheRef = React.useRef<Map<string, number | null>>(new Map());
  const inFlightBaseResinMlRef = React.useRef<Map<string, Promise<number | null>>>(new Map());
  const [estimatedResinMl, setEstimatedResinMl] = React.useState<number | null>(null);
  const profileState = React.useSyncExternalStore(subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreServerSnapshot);
  const activePrinterProfile = React.useMemo(() => getActivePrinterProfile(profileState), [profileState]);
  const activeMaterialProfile = React.useMemo(() => getActiveMaterialProfile(profileState), [profileState]);
  const connectedHostName = React.useMemo(() => {
    const networkConnection = activePrinterProfile?.networkConnection;
    if (!networkConnection?.connected) return null;
    return networkConnection.hostName || networkConnection.ipAddress || null;
  }, [activePrinterProfile]);

  const effectiveMaterialName = React.useMemo(() => {
    const networkConnection = activePrinterProfile?.networkConnection;
    if (activePrinterProfile?.networkSupport === 'nanodlp' && networkConnection?.connected) {
      return networkConnection.selectedMaterialName || networkConnection.selectedMaterialId || '-';
    }
    return activeMaterialProfile?.name ?? '-';
  }, [activeMaterialProfile, activePrinterProfile]);

  const effectiveLayerHeightMm = React.useMemo(() => {
    const networkConnection = activePrinterProfile?.networkConnection;
    if (
      activePrinterProfile?.networkSupport === 'nanodlp'
      && networkConnection?.connected
      && Number.isFinite(Number(networkConnection.selectedMaterialLayerHeightMm))
    ) {
      const value = Number(networkConnection.selectedMaterialLayerHeightMm);
      if (value > 0) return value;
    }
    return activeMaterialProfile?.layerHeightMm;
  }, [activeMaterialProfile, activePrinterProfile]);

  const effectiveNormalExposureSec = React.useMemo(() => {
    const networkConnection = activePrinterProfile?.networkConnection;
    if (
      activePrinterProfile?.networkSupport === 'nanodlp'
      && networkConnection?.connected
      && Number.isFinite(Number(networkConnection.selectedMaterialNormalExposureSec))
    ) {
      const value = Number(networkConnection.selectedMaterialNormalExposureSec);
      if (value > 0) return value;
    }
    return activeMaterialProfile?.normalExposureSec;
  }, [activeMaterialProfile, activePrinterProfile]);

  const effectiveBottomExposureSec = React.useMemo(() => {
    const networkConnection = activePrinterProfile?.networkConnection;
    if (
      activePrinterProfile?.networkSupport === 'nanodlp'
      && networkConnection?.connected
      && Number.isFinite(Number(networkConnection.selectedMaterialBottomExposureSec))
    ) {
      const value = Number(networkConnection.selectedMaterialBottomExposureSec);
      if (value > 0) return value;
    }
    return activeMaterialProfile?.bottomExposureSec;
  }, [activeMaterialProfile, activePrinterProfile]);

  const effectiveBottomLayerCount = React.useMemo(() => {
    const networkConnection = activePrinterProfile?.networkConnection;
    if (
      activePrinterProfile?.networkSupport === 'nanodlp'
      && networkConnection?.connected
      && Number.isFinite(Number(networkConnection.selectedMaterialBottomLayerCount))
    ) {
      const value = Number(networkConnection.selectedMaterialBottomLayerCount);
      if (value > 0) return value;
    }
    return activeMaterialProfile?.bottomLayerCount ?? 0;
  }, [activeMaterialProfile, activePrinterProfile]);

  // Compute per-model layer counts

  const formatBytes = (bytes: number) => {
    const abs = Math.max(0, bytes);
    const KB = 1024;
    const MB = KB * 1024;
    const GB = MB * 1024;

    if (abs >= GB) return `${(abs / GB).toFixed(2)} GB`;
    if (abs >= MB) return `${(abs / MB).toFixed(2)} MB`;
    if (abs >= KB) return `${(abs / KB).toFixed(1)} KB`;
    return `${abs.toFixed(0)} B`;
  };

  const formatDuration = (seconds: number) => {
    const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
    const h = Math.floor(safeSeconds / 3600);
    const m = Math.floor((safeSeconds % 3600) / 60);
    const s = safeSeconds % 60;

    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };


  // Sets of model IDs used by memoized selectors; must be declared before hooks that use them
  const selectedModelSet = React.useMemo(() => new Set(selectedModelIds), [selectedModelIds]);
  const inBoundsModelSet = React.useMemo(() => new Set(inBoundsModelIds), [inBoundsModelIds]);

  const getModelLayerCount = React.useCallback((entry: LoadedModel): number | null => {
    // Use model height and effective layer height
    const bbox = entry.geometry.bbox;
    const minZ = bbox.min.z;
    const maxZ = bbox.max.z;
    const height = Math.max(0, maxZ - minZ) * Math.abs(entry.transform.scale.z || 1);
    if (!effectiveLayerHeightMm || effectiveLayerHeightMm <= 0) return null;
    return Math.ceil(height / effectiveLayerHeightMm);
  }, [effectiveLayerHeightMm]);

  // Compute per-selected or plate layer count
  const selectedLayerCounts = React.useMemo(() => {
    if (selectedModelSet.size > 0) {
      return models.filter((entry) => selectedModelSet.has(entry.id) && entry.visible)
        .map((entry) => ({ count: getModelLayerCount(entry) }));
    }
    if (inBoundsModelSet.size > 0) {
      return models.filter((entry) => inBoundsModelSet.has(entry.id) && entry.visible)
        .map((entry) => ({ count: getModelLayerCount(entry) }));
    }
    return [];
  }, [getModelLayerCount, inBoundsModelSet, models, selectedModelSet]);

  const maxLayerCount = React.useMemo(() => {
    if (selectedLayerCounts.length === 0) return null;
    return selectedLayerCounts.reduce((max, entry) => (entry.count != null && entry.count > max ? entry.count : max), 0);
  }, [selectedLayerCounts]);

  const resinTargetModels = React.useMemo(() => {
    const visibleModels = models.filter((entry) => entry.visible);

    if (selectedModelSet.size > 0) {
      return visibleModels.filter((entry) => selectedModelSet.has(entry.id));
    }

    if (inBoundsModelSet.size > 0) {
      return visibleModels.filter((entry) => inBoundsModelSet.has(entry.id));
    }

    return [] as LoadedModel[];
  }, [inBoundsModelSet, models, selectedModelSet]);

  const estimatedExposureOnlySeconds = React.useMemo(() => {
    if (resinTargetModels.length === 0 || numLayers <= 0 || effectiveNormalExposureSec == null) return null;

    const bottomLayers = Math.max(0, Math.min(numLayers, Math.round(effectiveBottomLayerCount || 0)));
    const normalLayers = Math.max(0, numLayers - bottomLayers);

    const bottomTime = bottomLayers * Math.max(0, effectiveBottomExposureSec ?? effectiveNormalExposureSec);
    const normalTime = normalLayers * Math.max(0, effectiveNormalExposureSec);

    // A small fixed overhead per layer for lift/retract + settle.
    const movementOverheadSec = numLayers * 3.0;
    return bottomTime + normalTime + movementOverheadSec;
  }, [effectiveBottomExposureSec, effectiveBottomLayerCount, effectiveNormalExposureSec, numLayers, resinTargetModels.length]);

  const yieldToMainThread = React.useCallback(async () => {
    await new Promise<void>((resolve) => {
      if (typeof window !== 'undefined' && typeof (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback === 'function') {
        (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback?.(() => resolve(), { timeout: 16 });
        return;
      }
      setTimeout(resolve, 0);
    });
  }, []);

  const computeBaseResinMlChunked = React.useCallback(async (
    position: { getX: (i: number) => number; getY: (i: number) => number; getZ: (i: number) => number; count: number },
    index: { getX: (i: number) => number; count: number } | null,
  ): Promise<number | null> => {
    let signedVolume = 0;

    const vax = { x: 0, y: 0, z: 0 };
    const vbx = { x: 0, y: 0, z: 0 };
    const vcx = { x: 0, y: 0, z: 0 };

    const readVertex = (i: number, out: { x: number; y: number; z: number }) => {
      out.x = position.getX(i);
      out.y = position.getY(i);
      out.z = position.getZ(i);
    };

    const addTriangle = (ia: number, ib: number, ic: number) => {
      readVertex(ia, vax);
      readVertex(ib, vbx);
      readVertex(ic, vcx);

      signedVolume += (
        vax.x * (vbx.y * vcx.z - vbx.z * vcx.y)
        - vax.y * (vbx.x * vcx.z - vbx.z * vcx.x)
        + vax.z * (vbx.x * vcx.y - vbx.y * vcx.x)
      ) / 6;
    };

    const yieldEveryTriangles = 4096;
    let processedTriangles = 0;

    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        addTriangle(index.getX(i), index.getX(i + 1), index.getX(i + 2));
        processedTriangles += 1;
        if (processedTriangles % yieldEveryTriangles === 0) {
          await yieldToMainThread();
        }
      }
    } else {
      for (let i = 0; i < position.count; i += 3) {
        addTriangle(i, i + 1, i + 2);
        processedTriangles += 1;
        if (processedTriangles % yieldEveryTriangles === 0) {
          await yieldToMainThread();
        }
      }
    }

    const baseVolumeMm3 = Math.abs(signedVolume);
    return Number.isFinite(baseVolumeMm3) ? (baseVolumeMm3 / 1000) : null;
  }, [yieldToMainThread]);

  const getOrComputeBaseResinMl = React.useCallback(async (entry: LoadedModel): Promise<number | null> => {
    const geometry = entry.geometry.geometry;
    const positionAttr = geometry.getAttribute('position');
    if (!positionAttr) return null;

    const sourceKey = String(geometry.userData?.resinVolumeSourceKey ?? geometry.uuid);
    geometry.userData = {
      ...geometry.userData,
      resinVolumeSourceKey: sourceKey,
    };

    const position = positionAttr as {
      getX: (i: number) => number;
      getY: (i: number) => number;
      getZ: (i: number) => number;
      count: number;
      version?: number;
      data?: { version?: number };
    };
    const index = geometry.getIndex() as ({ getX: (i: number) => number; count: number; version?: number } | null);

    const positionVersion = position.version ?? position.data?.version ?? 0;
    const indexVersion = index?.version ?? 0;
    const cacheKey = `${sourceKey}:${positionVersion}:${indexVersion}`;

    const cached = baseResinMlCacheRef.current.get(cacheKey);
    if (cached !== undefined) return cached;

    const inFlight = inFlightBaseResinMlRef.current.get(cacheKey);
    if (inFlight) return inFlight;

    const promise = computeBaseResinMlChunked(position, index)
      .then((result) => {
        baseResinMlCacheRef.current.set(cacheKey, result);
        inFlightBaseResinMlRef.current.delete(cacheKey);
        return result;
      })
      .catch(() => {
        inFlightBaseResinMlRef.current.delete(cacheKey);
        return null;
      });

    inFlightBaseResinMlRef.current.set(cacheKey, promise);
    return promise;
  }, [computeBaseResinMlChunked]);

  React.useEffect(() => {
    let cancelled = false;

    if (resinTargetModels.length === 0) {
      setEstimatedResinMl(null);
      return () => {
        cancelled = true;
      };
    }

    const run = async () => {
      let totalMl = 0;
      let found = false;

      for (const entry of resinTargetModels) {
        if (cancelled) return;

        const baseMl = await getOrComputeBaseResinMl(entry);
        if (cancelled) return;
        if (baseMl == null) continue;

        const sx = Math.abs(entry.transform.scale.x || 1);
        const sy = Math.abs(entry.transform.scale.y || 1);
        const sz = Math.abs(entry.transform.scale.z || 1);
        totalMl += baseMl * sx * sy * sz;
        found = true;
      }

      if (cancelled) return;
      setEstimatedResinMl(found ? totalMl : null);
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [getOrComputeBaseResinMl, resinTargetModels]);

  const estimatedResinCost = React.useMemo(() => {
    if (estimatedResinMl == null || !activeMaterialProfile) return null;
    const bottleMl = Math.max(1, activeMaterialProfile.bottleCapacityMl || 0);
    const price = Math.max(0, activeMaterialProfile.bottlePrice || 0);
    const currency = (activeMaterialProfile.currencyCode || 'USD').toUpperCase();
    const cost = (estimatedResinMl / bottleMl) * price;
    return `${currency} ${cost.toFixed(2)}`;
  }, [activeMaterialProfile, estimatedResinMl]);

  const frontHeader = connectedHostName || activePrinterProfile?.name || 'No printer connected';

  const handleToggleFlip = React.useCallback(() => {
    setIsFlipped((prev) => !prev);
  }, []);

  const handleCardKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setIsFlipped((prev) => !prev);
    }
  }, []);

  const stopEvent = (event: React.MouseEvent) => {
    event.stopPropagation();
  };

  return (
    <div className="pointer-events-auto select-none w-[320px] max-w-[320px]">
      <div
        className="w-full [perspective:1200px]"
      >
        <div
          role="button"
          tabIndex={0}
          aria-label="Flip model stats card"
          onClick={handleToggleFlip}
          onKeyDown={handleCardKeyDown}
          className="grid w-full min-w-0 transition-transform duration-500 ease-out [transform-style:preserve-3d] focus:outline-none"
          style={{ transform: isFlipped ? 'rotateY(180deg)' : 'rotateY(0deg)' }}
        >
          <div
            className="[grid-area:1/1] w-full min-w-0 ui-panel rounded-md px-3 py-2.5 shadow-md space-y-1.5 flex flex-col"
            style={{
              background: 'color-mix(in srgb, var(--surface-0), transparent 8%)',
              backfaceVisibility: 'hidden',
            }}
          >
            <div className="font-semibold text-[12px] truncate" style={{ color: connectedHostName ? '#86efac' : 'var(--text-strong)' }}>
              {frontHeader}
            </div>

            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <span>Printer:</span>
              <button
                type="button"
                onMouseDown={stopEvent}
                onClick={(event) => {
                  event.stopPropagation();
                  openProfileSettingsModal('printer');
                }}
                className="min-w-0 truncate text-left underline decoration-dotted underline-offset-2 hover:opacity-85 transition-opacity"
                style={{ color: 'var(--text-strong)' }}
                title="Open printer profiles"
              >
                {activePrinterProfile?.name ?? '-'}
              </button>

              <span>Material:</span>
              <button
                type="button"
                onMouseDown={stopEvent}
                onClick={(event) => {
                  event.stopPropagation();
                  openProfileSettingsModal('material');
                }}
                className="min-w-0 truncate text-left underline decoration-dotted underline-offset-2 hover:opacity-85 transition-opacity"
                style={{ color: 'var(--text-strong)' }}
                title="Open material profiles"
              >
                {effectiveMaterialName}
              </button>

              <span>Layer profile:</span>
              <span className="min-w-0 truncate" style={{ color: 'var(--text-strong)' }}>
                {effectiveLayerHeightMm != null ? `${Math.round(effectiveLayerHeightMm * 1000)}μm` : '-'}
              </span>

              <span>Exposure:</span>
              <span className="min-w-0 truncate" style={{ color: 'var(--text-strong)' }}>
                {effectiveNormalExposureSec != null
                  ? `${effectiveNormalExposureSec.toFixed(1)}s • ${(effectiveBottomExposureSec ?? effectiveNormalExposureSec).toFixed(1)}s`
                  : '-'}
              </span>


              <span>Layers:</span>
              <span className="min-w-0 truncate" style={{ color: 'var(--text-strong)' }}>
                {maxLayerCount != null ? maxLayerCount : '-'}
              </span>

              <span>Est. print time:</span>
              <span className="min-w-0 truncate" style={{ color: 'var(--text-strong)' }}>
                {estimatedPrintTimeLabelOverride ?? (estimatedExposureOnlySeconds != null ? formatDuration(estimatedExposureOnlySeconds) : '-')}
              </span>

              <span>Est. resin:</span>
              <span className="min-w-0 truncate" style={{ color: 'var(--text-strong)' }}>
                {estimatedResinLabelOverride ?? (estimatedResinMl != null
                  ? `${estimatedResinMl.toFixed(2)} ml${estimatedResinCost ? ` (${estimatedResinCost})` : ''}`
                  : '-')}
              </span>
            </div>

            <div className="pt-0.5 text-[10px] mt-auto" style={{ color: 'var(--text-muted)' }}>
              Click card to view model details
            </div>
          </div>

          <div
            className="[grid-area:1/1] w-full min-w-0 ui-panel rounded-md px-3 py-2.5 shadow-md space-y-1.5 flex flex-col"
            style={{
              background: 'color-mix(in srgb, var(--surface-0), transparent 8%)',
              backfaceVisibility: 'hidden',
              transform: 'rotateY(180deg)',
            }}
          >
            <div className="w-full min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap font-semibold text-[12px]" style={{ color: 'var(--text-strong)' }} title={model ? model.name : 'No model selected'}>
              {model ? model.name : 'No model selected'}
            </div>

            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <span>STL size:</span>
              <span className="min-w-0 truncate" style={{ color: 'var(--text-strong)' }}>{model?.fileSizeBytes != null ? formatBytes(model.fileSizeBytes) : '-'}</span>

              <span>Polygons:</span>
              <span className="min-w-0 truncate" style={{ color: 'var(--text-strong)' }}>{model ? model.polygonCount.toLocaleString() : '-'}</span>

              <span>Height:</span>
              <span className="min-w-0 truncate" style={{ color: 'var(--text-strong)' }}>{model ? `${heightMm.toFixed(2)} mm` : '-'}</span>
            </div>

            {model?.geometry.meshDefects?.hasDefects && (
              <div
                className="flex items-start gap-1.5 rounded px-2 py-1 text-[10px]"
                style={{
                  background: model.geometry.meshDefects.repairedByManifold
                    ? 'color-mix(in srgb, #22c55e, var(--surface-1) 84%)'
                    : 'color-mix(in srgb, #f59e0b, var(--surface-1) 82%)',
                  color: model.geometry.meshDefects.repairedByManifold ? '#86efac' : '#fde68a',
                  border: model.geometry.meshDefects.repairedByManifold
                    ? '1px solid color-mix(in srgb, #22c55e, transparent 55%)'
                    : '1px solid color-mix(in srgb, #f59e0b, transparent 55%)',
                }}
              >
                <span>{model.geometry.meshDefects.repairedByManifold ? '✓' : '⚠'}</span>
                <span>
                  {model.geometry.meshDefects.repairedByManifold
                    ? `Auto-Repaired — ${model.geometry.meshDefects.repairedFloats} errors`
                    : `Defective — ${model.geometry.meshDefects.repairedFloats} errors`}
                </span>
              </div>
            )}

            <div className="pt-0.5 text-[10px] mt-auto" style={{ color: 'var(--text-muted)' }}>
              Click card to return to print settings
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

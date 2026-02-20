
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
}

export function ModelStatsCard({
  model,
  models,
  selectedModelIds,
  inBoundsModelIds,
  numLayers,
  heightMm
}: ModelStatsCardProps) {
  const [isFlipped, setIsFlipped] = React.useState(false);
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


  // Move these above selectedLayerCounts to avoid use-before-declaration

  // Must be declared before any hook that uses them

  // Must be declared before any hook or logic that uses them
  const selectedModelSet = React.useMemo(() => new Set(selectedModelIds), [selectedModelIds]);
  const inBoundsModelSet = React.useMemo(() => new Set(inBoundsModelIds), [inBoundsModelIds]);

  // Compute per-model layer counts
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

  const estimateModelResinMl = React.useCallback((entry: LoadedModel): number | null => {
    const geometry = entry.geometry.geometry;
    const position = geometry.getAttribute('position');
    if (!position) return null;

    const index = geometry.getIndex();
    const sx = Math.abs(entry.transform.scale.x || 1);
    const sy = Math.abs(entry.transform.scale.y || 1);
    const sz = Math.abs(entry.transform.scale.z || 1);

    let signedVolume = 0;

    const vax = { x: 0, y: 0, z: 0 };
    const vbx = { x: 0, y: 0, z: 0 };
    const vcx = { x: 0, y: 0, z: 0 };

    const readVertex = (i: number, out: { x: number; y: number; z: number }) => {
      out.x = position.getX(i) * sx;
      out.y = position.getY(i) * sy;
      out.z = position.getZ(i) * sz;
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

    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        addTriangle(index.getX(i), index.getX(i + 1), index.getX(i + 2));
      }
    } else {
      for (let i = 0; i < position.count; i += 3) {
        addTriangle(i, i + 1, i + 2);
      }
    }

    const volumeMm3 = Math.abs(signedVolume);
    if (!Number.isFinite(volumeMm3)) return null;
    return volumeMm3 / 1000; // 1000 mm^3 = 1 ml
  }, []);

  const estimatedResinMl = React.useMemo(() => {
    if (resinTargetModels.length === 0) return null;

    let totalMl = 0;
    let found = false;

    for (const entry of resinTargetModels) {
      const modelMl = estimateModelResinMl(entry);
      if (modelMl == null) continue;
      totalMl += modelMl;
      found = true;
    }

    return found ? totalMl : null;
  }, [estimateModelResinMl, resinTargetModels]);

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
    <div className="absolute bottom-4 left-2 pointer-events-auto select-none w-fit">
      <div
        className="min-w-[290px] [perspective:1200px]"
      >
        <div
          role="button"
          tabIndex={0}
          aria-label="Flip model stats card"
          onClick={handleToggleFlip}
          onKeyDown={handleCardKeyDown}
          className="grid transition-transform duration-500 ease-out [transform-style:preserve-3d] focus:outline-none"
          style={{ transform: isFlipped ? 'rotateY(180deg)' : 'rotateY(0deg)' }}
        >
          <div
            className="[grid-area:1/1] ui-panel rounded-md px-3 py-2.5 shadow-md space-y-1.5 flex flex-col"
            style={{
              background: 'color-mix(in srgb, var(--surface-0), transparent 8%)',
              backfaceVisibility: 'hidden',
            }}
          >
            <div className="font-semibold text-[12px] truncate" style={{ color: connectedHostName ? '#86efac' : 'var(--text-strong)' }}>
              {frontHeader}
            </div>

            <div className="grid grid-cols-[auto_auto] gap-x-2 gap-y-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <span>Printer:</span>
              <button
                type="button"
                onMouseDown={stopEvent}
                onClick={(event) => {
                  event.stopPropagation();
                  openProfileSettingsModal('printer');
                }}
                className="text-left underline decoration-dotted underline-offset-2 hover:opacity-85 transition-opacity"
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
                className="text-left underline decoration-dotted underline-offset-2 hover:opacity-85 transition-opacity"
                style={{ color: 'var(--text-strong)' }}
                title="Open material profiles"
              >
                {effectiveMaterialName}
              </button>

              <span>Layer profile:</span>
              <span style={{ color: 'var(--text-strong)' }}>
                {effectiveLayerHeightMm != null ? `${Math.round(effectiveLayerHeightMm * 1000)}μm` : '-'}
              </span>

              <span>Exposure:</span>
              <span style={{ color: 'var(--text-strong)' }}>
                {effectiveNormalExposureSec != null
                  ? `${effectiveNormalExposureSec.toFixed(1)}s • ${(effectiveBottomExposureSec ?? effectiveNormalExposureSec).toFixed(1)}s`
                  : '-'}
              </span>


              <span>Layers:</span>
              <span style={{ color: 'var(--text-strong)' }}>
                {maxLayerCount != null ? maxLayerCount : '-'}
              </span>

              <span>Est. print time:</span>
              <span style={{ color: 'var(--text-strong)' }}>
                {estimatedExposureOnlySeconds != null ? formatDuration(estimatedExposureOnlySeconds) : '-'}
              </span>

              <span>Est. resin:</span>
              <span style={{ color: 'var(--text-strong)' }}>
                {estimatedResinMl != null
                  ? `${estimatedResinMl.toFixed(2)} ml${estimatedResinCost ? ` (${estimatedResinCost})` : ''}`
                  : '-'}
              </span>
            </div>

            <div className="pt-0.5 text-[10px] mt-auto" style={{ color: 'var(--text-muted)' }}>
              Click card to view model details
            </div>
          </div>

          <div
            className="[grid-area:1/1] ui-panel rounded-md px-3 py-2.5 shadow-md space-y-1.5 flex flex-col"
            style={{
              background: 'color-mix(in srgb, var(--surface-0), transparent 8%)',
              backfaceVisibility: 'hidden',
              transform: 'rotateY(180deg)',
            }}
          >
            <div className="font-semibold text-[12px] truncate" style={{ color: 'var(--text-strong)' }}>
              {model ? model.name : 'No model selected'}
            </div>

            <div className="grid grid-cols-[auto_auto] gap-x-2 gap-y-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <span>STL size:</span>
              <span style={{ color: 'var(--text-strong)' }}>{model?.fileSizeBytes != null ? formatBytes(model.fileSizeBytes) : '-'}</span>

              <span>Polygons:</span>
              <span style={{ color: 'var(--text-strong)' }}>{model ? model.polygonCount.toLocaleString() : '-'}</span>

              <span>Height:</span>
              <span style={{ color: 'var(--text-strong)' }}>{model ? `${heightMm.toFixed(2)} mm` : '-'}</span>
            </div>

            <div className="pt-0.5 text-[10px] mt-auto" style={{ color: 'var(--text-muted)' }}>
              Click card to return to print settings
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


import React from 'react';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import {
  getActiveMaterialProfile,
  getActivePrinterProfile,
  getProfileStoreSnapshot,
  subscribeToProfileStore,
} from '@/features/profiles/profileStore';

interface ModelStatsCardProps {
  model: LoadedModel | null;
  numLayers: number;
  heightMm: number;
}

export function ModelStatsCard({
  model,
  numLayers,
  heightMm
}: ModelStatsCardProps) {
  const profileState = React.useSyncExternalStore(subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreSnapshot);
  const activePrinterProfile = React.useMemo(() => getActivePrinterProfile(profileState), [profileState]);
  const activeMaterialProfile = React.useMemo(() => getActiveMaterialProfile(profileState), [profileState]);

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

  const estimatedExposureOnlySeconds = React.useMemo(() => {
    if (!model || !activeMaterialProfile || numLayers <= 0) return null;

    const bottomLayers = Math.max(0, Math.min(numLayers, Math.round(activeMaterialProfile.bottomLayerCount || 0)));
    const normalLayers = Math.max(0, numLayers - bottomLayers);

    const bottomTime = bottomLayers * Math.max(0, activeMaterialProfile.bottomExposureSec || 0);
    const normalTime = normalLayers * Math.max(0, activeMaterialProfile.normalExposureSec || 0);

    // A small fixed overhead per layer for lift/retract + settle.
    const movementOverheadSec = numLayers * 3.0;
    return bottomTime + normalTime + movementOverheadSec;
  }, [activeMaterialProfile, model, numLayers]);

  const estimatedResinMl = React.useMemo(() => {
    if (!model) return null;

    const geometry = model.geometry.geometry;
    const position = geometry.getAttribute('position');
    if (!position) return null;

    const index = geometry.getIndex();
    const sx = Math.abs(model.transform.scale.x || 1);
    const sy = Math.abs(model.transform.scale.y || 1);
    const sz = Math.abs(model.transform.scale.z || 1);

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
  }, [model]);

  const estimatedResinCost = React.useMemo(() => {
    if (estimatedResinMl == null || !activeMaterialProfile) return null;
    const bottleMl = Math.max(1, activeMaterialProfile.bottleCapacityMl || 0);
    const price = Math.max(0, activeMaterialProfile.bottlePrice || 0);
    const currency = (activeMaterialProfile.currencyCode || 'USD').toUpperCase();
    const cost = (estimatedResinMl / bottleMl) * price;
    return `${currency} ${cost.toFixed(2)}`;
  }, [activeMaterialProfile, estimatedResinMl]);

  return (
    <div className="absolute bottom-4 left-2 pointer-events-none select-none w-fit">
      <div
        className="ui-panel rounded-md px-3 py-2.5 shadow-md space-y-1.5 min-w-[250px]"
        style={{ background: 'color-mix(in srgb, var(--surface-0), transparent 8%)' }}
      >
        <div className="font-semibold text-[12px] truncate" style={{ color: 'var(--text-strong)' }}>
          {model ? model.name : 'No model selected'}
        </div>

        <div className="grid grid-cols-[auto_auto] gap-x-2 gap-y-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          <span>Printer:</span>
          <span style={{ color: 'var(--text-strong)' }}>{activePrinterProfile?.name ?? '-'}</span>

          <span>Material:</span>
          <span style={{ color: 'var(--text-strong)' }}>{activeMaterialProfile?.name ?? '-'}</span>

          <span>Layer profile:</span>
          <span style={{ color: 'var(--text-strong)' }}>
            {activeMaterialProfile ? `${Math.round(activeMaterialProfile.layerHeightMm * 1000)}μm` : '-'}
          </span>

          <span>Exposure:</span>
          <span style={{ color: 'var(--text-strong)' }}>
            {activeMaterialProfile
              ? `${activeMaterialProfile.normalExposureSec.toFixed(1)}s • ${activeMaterialProfile.bottomExposureSec.toFixed(1)}s`
              : '-'}
          </span>

          <span>STL Size:</span>
          <span style={{ color: 'var(--text-strong)' }}>{model?.fileSizeBytes != null ? formatBytes(model.fileSizeBytes) : '-'}</span>

          <span>Polygons:</span>
          <span style={{ color: 'var(--text-strong)' }}>{model ? model.polygonCount.toLocaleString() : '-'}</span>

          <span>Height:</span>
          <span style={{ color: 'var(--text-strong)' }}>{model ? `${heightMm.toFixed(2)} mm` : '-'}</span>

          <span>Layers:</span>
          <span style={{ color: 'var(--text-strong)' }}>{model ? numLayers : '-'}</span>

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
      </div>
    </div>
  );
}

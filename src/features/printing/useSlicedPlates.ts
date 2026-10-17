import React from 'react';
import { subscribeHistoryChanges } from '@/history/historyStore';
import {
  readPrintLayerPreviewPngFromPath,
  readPrintLayerPreviewPngsFromPath,
} from '@/features/slicing/tauri/nativeSlicerBridge';
import {
  createSlicedPlates,
  isSlicedPlateStale,
  type LayerPreviewSource,
  type PreviewUrls,
  type SlicedPlate,
  type SlicedPlates,
  type SlicedPlatesSnapshot,
} from './slicedPlates';

const nativeLayerPreviewSource: LayerPreviewSource = {
  readLayer: readPrintLayerPreviewPngFromPath,
  readLayers: readPrintLayerPreviewPngsFromPath,
};

const objectPreviewUrls: PreviewUrls = {
  create(pngBytes) {
    const bytes = new Uint8Array(pngBytes.length);
    bytes.set(pngBytes);
    return URL.createObjectURL(new Blob([bytes.buffer], { type: 'image/png' }));
  },
  revoke: (url) => URL.revokeObjectURL(url),
};

export interface UseSlicedPlatesOptions<Model extends object> {
  activePlateId: string;
  models: readonly Model[];
  plateOf: (model: Model) => string;
  /** The printer and material slicing would use now; see `sliceProfileFingerprint`. */
  profileFingerprint: string;
}

export interface SlicedPlatesView {
  slicedPlates: SlicedPlates;
  plates: SlicedPlatesSnapshot['plates'];
  /** The slice of the plate being worked on, if it has one. */
  activeSlice: SlicedPlate | null;
  /** That slice no longer matches the plate or the profile. */
  isActiveSliceStale: boolean;
  /** Any plate has a slice: the printing workspace is enterable, its preview is per plate. */
  hasSlicedPlate: boolean;
  /** The active plate's preview of a layer, if it has been read. Changes when a read lands. */
  layerPreviewUrlAt: (layerNumber: number) => string | null;
  /** How many of the active plate's layers are in memory. */
  layerPreviewCount: number;
}

/**
 * The scene's sliced plates, for the app shell: the store, the active plate's view of it, and
 * the two things only React can tell it — that a history entry landed, and what the models
 * looked like after it did.
 */
export function useSlicedPlates<Model extends object>({
  activePlateId,
  models,
  plateOf,
  profileFingerprint,
}: UseSlicedPlatesOptions<Model>): SlicedPlatesView {
  const [slicedPlates] = React.useState(() => createSlicedPlates({
    source: nativeLayerPreviewSource,
    urls: objectPreviewUrls,
  }));
  const snapshot = React.useSyncExternalStore(slicedPlates.subscribe, slicedPlates.getSnapshot, slicedPlates.getSnapshot);

  React.useEffect(() => () => slicedPlates.clear(), [slicedPlates]);

  // A history entry is only a signal; the models it changed are known after the render it
  // caused, which is when the effect below compares them.
  const [historyEditTick, setHistoryEditTick] = React.useState(0);
  React.useEffect(() => {
    const unsubscribe = subscribeHistoryChanges(() => {
      setHistoryEditTick((tick) => tick + 1);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  const observedEditTickRef = React.useRef(historyEditTick);
  React.useEffect(() => {
    const edited = observedEditTickRef.current !== historyEditTick;
    observedEditTickRef.current = historyEditTick;
    const modelsByPlate = new Map<string, Model[]>();
    for (const model of models) {
      const plateId = plateOf(model);
      const onPlate = modelsByPlate.get(plateId);
      if (onPlate) onPlate.push(model);
      else modelsByPlate.set(plateId, [model]);
    }
    slicedPlates.observeModels(modelsByPlate, edited);
  }, [historyEditTick, models, plateOf, slicedPlates]);

  const activeSlice = snapshot.plates[activePlateId] ?? null;
  const activePreviews = snapshot.previews[activePlateId];
  const layerPreviewUrlAt = React.useCallback(
    (layerNumber: number) => activePreviews?.get(layerNumber) ?? null,
    [activePreviews],
  );

  return {
    slicedPlates,
    plates: snapshot.plates,
    activeSlice,
    isActiveSliceStale: isSlicedPlateStale(activeSlice, profileFingerprint),
    hasSlicedPlate: Object.values(snapshot.plates).some((plate) => plate.artifact !== null),
    layerPreviewUrlAt,
    layerPreviewCount: activePreviews?.size ?? 0,
  };
}

/**
 * Keeps the layer on screen read, and every fresh slice read ahead around it. Separate from
 * `useSlicedPlates` because the layer on screen belongs to the preview manager, which is built
 * from the slice.
 */
export function useSlicedPlatePreviewLoading(
  { slicedPlates, plates, activeSlice }: Pick<SlicedPlatesView, 'slicedPlates' | 'plates' | 'activeSlice'>,
  { activePlateId, displayedLayer, isPrinting }: { activePlateId: string; displayedLayer: number; isPrinting: boolean },
): void {
  const totalLayers = activeSlice?.totalLayers ?? 0;
  const artifact = activeSlice?.artifact ?? null;
  React.useEffect(() => {
    if (!isPrinting || !artifact || totalLayers <= 0) return;
    slicedPlates.loadLayerPreview(activePlateId, Math.max(1, Math.min(totalLayers, displayedLayer)));
  }, [activePlateId, artifact, displayedLayer, isPrinting, slicedPlates, totalLayers]);

  React.useEffect(() => {
    slicedPlates.prefetch(displayedLayer);
  }, [displayedLayer, plates, slicedPlates]);
}

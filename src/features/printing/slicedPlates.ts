import type { SliceExportArtifact } from '@/features/slicing/sliceExportOrchestrator';

/**
 * The slices of a scene's plates, and everything that hangs off them: which artifact each plate
 * was sliced into, how many layers it has, whether the plate has changed since, and the layer
 * previews read out of it.
 *
 * One owner for all of it. The printing workspace shows the slice of the plate being worked on,
 * so a batch of plates is a set of slices rather than whichever finished last; and a preview's
 * object URL lives exactly as long as the slice it was read from.
 *
 * No React here. `useSlicedPlates` is the glue; the native archive and the object URLs come in
 * through `LayerPreviewSource` and `PreviewUrls`, so tests run it in memory.
 */

export interface SlicedPlate {
  /** The file the plate was sliced into; null while a run for it is under way. */
  readonly artifact: SliceExportArtifact | null;
  readonly totalLayers: number;
  /** The printer and material the slice was made for; see `sliceProfileFingerprint`. */
  readonly profileFingerprint: string | null;
  /** The plate's models changed after it was sliced. */
  readonly edited: boolean;
}

export interface SlicedPlatesSnapshot {
  readonly plates: Readonly<Record<string, SlicedPlate>>;
  /** Each plate's layer previews already read, by layer number. A new map whenever one changes. */
  readonly previews: Readonly<Record<string, ReadonlyMap<number, string>>>;
}

/** Reads layer previews out of a sliced file. The native archive, in the app. */
export interface LayerPreviewSource {
  readLayer(path: string, layerNumber: number, outputFormat: string): Promise<Uint8Array>;
  /** Several in one round trip; an empty entry is a layer that would not decode. */
  readLayers(path: string, layerNumbers: readonly number[], outputFormat: string): Promise<Uint8Array[]>;
}

/** Where a preview's URL comes from and goes back to. Object URLs, in the app. */
export interface PreviewUrls {
  create(pngBytes: Uint8Array): string;
  revoke(url: string): void;
}

export interface SlicedPlatesOptions {
  source: LayerPreviewSource;
  urls: PreviewUrls;
  /** How many layers of one plate are kept before the oldest are dropped. */
  cacheLimit?: number;
  /** How many layers either side of the one on screen a fresh slice reads ahead. */
  prefetchRadius?: number;
}

export interface SlicedPlates {
  subscribe(listener: () => void): () => void;
  getSnapshot(): SlicedPlatesSnapshot;
  /** A run for this plate has started: its slice, and the previews read from it, are going away. */
  runStarted(plateId: string): void;
  /** The layer count of the run started last, which a single run only knows at the end. */
  runFinished(totalLayers: number): void;
  /**
   * Records a plate's slice. A batch records each plate as it lands and hands the same artifacts
   * over again when it finishes, so recording the same artifact twice is a no-op.
   */
  record(plateId: string, artifact: SliceExportArtifact, details: { totalLayers?: number; profileFingerprint: string }): void;
  /**
   * The scene's models, by plate, after a render. `edited` says a history entry landed since the
   * last call: the plates whose models changed are then the ones it edited.
   */
  observeModels(modelsByPlate: ReadonlyMap<string, readonly object[]>, edited: boolean): void;
  /** Reads a layer if it is not read and not being read; subscribers hear when it lands. */
  loadLayerPreview(plateId: string, layerNumber: number): void;
  /** Reads the layers around `centreLayer` once per slice of every plate. */
  prefetch(centreLayer: number): void;
  /** Forgets every plate's slice and revokes every preview; a read that lands later is dropped. */
  clear(): void;
}

/** What a slice is bound to besides the models: the printer and material it was made for. */
export function sliceProfileFingerprint(printerProfileId: unknown, materialProfileId: unknown): string {
  return `${String(printerProfileId ?? '').trim()}::${String(materialProfileId ?? '').trim()}`;
}

/** A slice no longer matches what it would be sliced from now. */
export function isSlicedPlateStale(plate: SlicedPlate | null | undefined, activeProfileFingerprint: string): boolean {
  if (!plate?.artifact) return false;
  if (plate.edited) return true;
  return plate.profileFingerprint !== null && plate.profileFingerprint !== activeProfileFingerprint;
}

const DEFAULT_CACHE_LIMIT = 24;
const DEFAULT_PREFETCH_RADIUS = 2;

export function createSlicedPlates(options: SlicedPlatesOptions): SlicedPlates {
  const { source, urls } = options;
  const cacheLimit = Math.max(1, options.cacheLimit ?? DEFAULT_CACHE_LIMIT);
  const prefetchRadius = Math.max(0, options.prefetchRadius ?? DEFAULT_PREFETCH_RADIUS);

  let snapshot: SlicedPlatesSnapshot = { plates: {}, previews: {} };
  const listeners = new Set<() => void>();
  /** Layer previews by plate and layer, in the order they were read: the first is the oldest. */
  const previews = new Map<string, Map<number, string>>();
  /** Reads under way, `${plateId}:${layer}`, each tagged with the artifact it reads from. */
  const inFlight = new Map<string, SliceExportArtifact>();
  /** The artifact each plate was last read ahead from: once per slice. */
  const prefetched = new Map<string, SliceExportArtifact>();
  /** The models on each plate when last observed. */
  let lastModelsByPlate: ReadonlyMap<string, ReadonlySet<object>> = new Map();
  let runningPlateId: string | null = null;

  const emit = () => {
    for (const listener of listeners) listener();
  };

  /** The snapshot's copy of the previews, with these plates' maps taken afresh. */
  const publishedPreviews = (plateIds: readonly string[]) => {
    const next = { ...snapshot.previews };
    for (const plateId of plateIds) {
      const layers = previews.get(plateId);
      if (layers) next[plateId] = new Map(layers);
      else delete next[plateId];
    }
    return next;
  };

  const setPlates = (plates: Record<string, SlicedPlate>, previewsChangedFor: readonly string[] = []) => {
    snapshot = {
      plates,
      previews: previewsChangedFor.length > 0 ? publishedPreviews(previewsChangedFor) : snapshot.previews,
    };
    emit();
  };

  const previewsChanged = (plateId: string) => {
    snapshot = { ...snapshot, previews: publishedPreviews([plateId]) };
    emit();
  };

  /** Drops a plate's previews and revokes their URLs; true if there were any. */
  const dropPreviews = (plateId: string): boolean => {
    const layers = previews.get(plateId);
    prefetched.delete(plateId);
    if (!layers) return false;
    for (const url of layers.values()) urls.revoke(url);
    previews.delete(plateId);
    return true;
  };

  const cachePreview = (plateId: string, layerNumber: number, pngBytes: Uint8Array) => {
    const layers = previews.get(plateId) ?? new Map<number, string>();
    const previous = layers.get(layerNumber);
    if (previous) {
      urls.revoke(previous);
      layers.delete(layerNumber);
    }
    layers.set(layerNumber, urls.create(pngBytes));
    previews.set(plateId, layers);

    // Scrubbing a tall print would otherwise cache every layer it passes: the oldest go first,
    // and a layer that is asked for again is simply read again.
    while (layers.size > cacheLimit) {
      const oldest = layers.keys().next();
      if (oldest.done) break;
      const url = layers.get(oldest.value);
      if (url) urls.revoke(url);
      layers.delete(oldest.value);
    }
  };

  /** A read still belongs to the plate's slice: the plate was not re-sliced or forgotten meanwhile. */
  const isCurrent = (plateId: string, artifact: SliceExportArtifact) => (
    snapshot.plates[plateId]?.artifact === artifact
  );

  const samePlateModels = (a: ReadonlySet<object> | undefined, b: ReadonlySet<object> | undefined) => {
    if ((a?.size ?? 0) !== (b?.size ?? 0)) return false;
    if (!a || !b) return true;
    for (const model of a) if (!b.has(model)) return false;
    return true;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot: () => snapshot,

    runStarted(plateId) {
      runningPlateId = plateId;
      const hadPreviews = dropPreviews(plateId);
      const current = snapshot.plates[plateId];
      // Only the plate being sliced loses its slice: a re-slice of one plate does not unslice the
      // others. A plate with no entry yet gets one, so the run's layer count has somewhere to go.
      if (current && current.artifact === null && current.totalLayers === 0 && !current.edited) {
        if (hadPreviews) previewsChanged(plateId);
        return;
      }
      setPlates({
        ...snapshot.plates,
        [plateId]: { artifact: null, totalLayers: 0, profileFingerprint: null, edited: false },
      }, hadPreviews ? [plateId] : []);
    },

    runFinished(totalLayers) {
      if (runningPlateId === null) return;
      const plateId = runningPlateId;
      const current = snapshot.plates[plateId];
      setPlates({
        ...snapshot.plates,
        [plateId]: {
          artifact: current?.artifact ?? null,
          totalLayers: Math.max(1, totalLayers),
          profileFingerprint: current?.profileFingerprint ?? null,
          edited: current?.edited ?? false,
        },
      });
    },

    record(plateId, artifact, details) {
      const current = snapshot.plates[plateId];
      if (current?.artifact === artifact) return;
      // A different artifact is a different slice: what was read from the old one goes.
      const hadPreviews = dropPreviews(plateId);
      setPlates({
        ...snapshot.plates,
        [plateId]: {
          artifact,
          // A batch hands the totals over with the artifact; a single run hands them over when it
          // finishes, after this.
          totalLayers: Math.max(1, details.totalLayers ?? current?.totalLayers ?? 1),
          profileFingerprint: details.profileFingerprint,
          edited: false,
        },
      }, hadPreviews ? [plateId] : []);
    },

    observeModels(modelsByPlate, edited) {
      const next = new Map<string, ReadonlySet<object>>();
      for (const [plateId, models] of modelsByPlate) next.set(plateId, new Set(models));
      const previous = lastModelsByPlate;
      lastModelsByPlate = next;
      if (!edited) return;

      const sliced = Object.entries(snapshot.plates).filter(([, plate]) => plate.artifact && !plate.edited);
      if (sliced.length === 0) return;

      // Edits that replace a model — a move, a scale, a model added or taken away — show up as a
      // plate whose models are not the ones it had. One that does not (supports, for one, live
      // outside the models) cannot be put on a plate, so it counts against every plate.
      const changedPlates = new Set<string>();
      for (const plateId of new Set([...previous.keys(), ...next.keys()])) {
        if (!samePlateModels(previous.get(plateId), next.get(plateId))) changedPlates.add(plateId);
      }
      const editedPlates = changedPlates.size > 0
        ? sliced.filter(([plateId]) => changedPlates.has(plateId))
        : sliced;
      if (editedPlates.length === 0) return;

      const plates = { ...snapshot.plates };
      for (const [plateId, plate] of editedPlates) plates[plateId] = { ...plate, edited: true };
      setPlates(plates);
    },

    loadLayerPreview(plateId, layerNumber) {
      const artifact = snapshot.plates[plateId]?.artifact;
      if (!artifact?.nativeTempPath) return;
      if (previews.get(plateId)?.has(layerNumber)) return;
      const key = `${plateId}:${layerNumber}`;
      if (inFlight.get(key) === artifact) return;
      inFlight.set(key, artifact);

      void source.readLayer(artifact.nativeTempPath, layerNumber, artifact.outputFormat)
        .then((pngBytes) => {
          if (!isCurrent(plateId, artifact)) return;
          cachePreview(plateId, layerNumber, pngBytes);
          previewsChanged(plateId);
        })
        .catch((error: unknown) => {
          if (isCurrent(plateId, artifact)) {
            console.warn(`[Printing] Failed loading layer ${layerNumber} preview PNG from archive.`, error);
          }
        })
        .finally(() => {
          if (inFlight.get(key) === artifact) inFlight.delete(key);
        });
    },

    prefetch(centreLayer) {
      // Runs as each slice lands — while a batch is still slicing, not while anyone is scrubbing,
      // which is the difference between a read-ahead that helps and one that competes with the
      // drag. The workspace then opens with those layers already in memory.
      for (const [plateId, plate] of Object.entries(snapshot.plates)) {
        const artifact = plate.artifact;
        if (!artifact?.nativeTempPath || !artifact.outputFormat) continue;
        if (prefetched.get(plateId) === artifact) continue;
        prefetched.set(plateId, artifact);

        const total = Math.max(1, plate.totalLayers);
        const centre = Math.max(1, Math.min(total, centreLayer));
        const wanted = [centre];
        for (let offset = 1; offset <= prefetchRadius; offset += 1) {
          if (centre + offset <= total) wanted.push(centre + offset);
          if (centre - offset >= 1) wanted.push(centre - offset);
        }
        const missing = wanted.filter((layerNumber) => !previews.get(plateId)?.has(layerNumber));
        if (missing.length === 0) continue;

        void source.readLayers(artifact.nativeTempPath, missing, artifact.outputFormat)
          .then((layers) => {
            if (!isCurrent(plateId, artifact)) return;
            let cached = false;
            missing.forEach((layerNumber, index) => {
              const pngBytes = layers[index];
              if (!pngBytes || pngBytes.length === 0) return;
              if (previews.get(plateId)?.has(layerNumber)) return;
              cachePreview(plateId, layerNumber, pngBytes);
              cached = true;
            });
            if (cached) previewsChanged(plateId);
          })
          .catch(() => {
            // An older build without the batch command, or a file that would not decode: the
            // layer is read again when it is shown, one at a time.
          });
      }
    },

    clear() {
      const hadPreviews = previews.size > 0;
      for (const plateId of [...previews.keys()]) dropPreviews(plateId);
      prefetched.clear();
      runningPlateId = null;
      if (Object.keys(snapshot.plates).length === 0 && !hadPreviews) return;
      snapshot = { plates: {}, previews: {} };
      emit();
    },
  };
}

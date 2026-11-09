import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { SliceExportArtifact } from '@/features/slicing/sliceExportOrchestrator';
import {
  createSlicedPlates,
  isSlicedPlateStale,
  sliceProfileFingerprint,
  type LayerPreviewSource,
  type SlicedPlatesOptions,
} from './slicedPlates';

const FINGERPRINT = sliceProfileFingerprint('saturn-2', 'standard');

function artifact(name: string): SliceExportArtifact {
  return {
    blob: null,
    outputName: `${name}.ctb`,
    mimeType: 'application/octet-stream',
    byteSize: 1,
    nativeTempPath: `/tmp/${name}.ctb`,
    outputFormat: '.ctb',
  };
}

/** An archive whose reads stay pending until the test settles them. */
function fakeArchive() {
  const reads: Array<{ path: string; layers: number[]; resolve: () => void; reject: (error: Error) => void }> = [];
  const source: LayerPreviewSource = {
    readLayer: (path, layerNumber) => new Promise((resolve, reject) => {
      reads.push({ path, layers: [layerNumber], resolve: () => resolve(new Uint8Array([layerNumber])), reject });
    }),
    readLayers: (path, layerNumbers) => new Promise((resolve, reject) => {
      reads.push({
        path,
        layers: [...layerNumbers],
        resolve: () => resolve(layerNumbers.map((layerNumber) => new Uint8Array([layerNumber]))),
        reject,
      });
    }),
  };
  return { source, reads };
}

function fakeUrls() {
  let next = 0;
  const live = new Set<string>();
  const revoked: string[] = [];
  return {
    live,
    revoked,
    urls: {
      create: (pngBytes: Uint8Array) => {
        const url = `blob:${next++}:layer-${pngBytes[0]}`;
        live.add(url);
        return url;
      },
      revoke: (url: string) => {
        assert.ok(live.delete(url), `revoked ${url}, which is not live`);
        revoked.push(url);
      },
    },
  };
}

function setup(options: Partial<SlicedPlatesOptions> = {}) {
  const archive = fakeArchive();
  const urls = fakeUrls();
  const plates = createSlicedPlates({ source: archive.source, urls: urls.urls, ...options });
  return { plates, archive, urls };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function resolveAll(reads: ReturnType<typeof fakeArchive>['reads']) {
  for (const read of reads.splice(0)) read.resolve();
  await settle();
}

describe('slicedPlates', () => {
  it('reads a layer once, however often it is asked for, and publishes it', async () => {
    const { plates, archive } = setup();
    let notified = 0;
    plates.subscribe(() => { notified += 1; });
    plates.record('plate-1', artifact('a'), { totalLayers: 10, profileFingerprint: FINGERPRINT });

    plates.loadLayerPreview('plate-1', 3);
    plates.loadLayerPreview('plate-1', 3);
    assert.equal(archive.reads.length, 1);

    const before = notified;
    await resolveAll(archive.reads);
    assert.equal(notified, before + 1);
    assert.match(plates.getSnapshot().previews['plate-1']?.get(3) ?? '', /layer-3$/);

    plates.loadLayerPreview('plate-1', 3);
    assert.equal(archive.reads.length, 0, 'a layer in memory is not read again');
  });

  it('keeps a bounded number of layers per plate and revokes the oldest', async () => {
    const { plates, archive, urls } = setup({ cacheLimit: 3 });
    plates.record('plate-1', artifact('a'), { totalLayers: 10, profileFingerprint: FINGERPRINT });

    for (const layer of [1, 2, 3, 4]) {
      plates.loadLayerPreview('plate-1', layer);
      await resolveAll(archive.reads);
    }

    const layers = plates.getSnapshot().previews['plate-1'];
    assert.deepEqual([...(layers?.keys() ?? [])], [2, 3, 4]);
    assert.equal(urls.revoked.length, 1);
    assert.match(urls.revoked[0], /layer-1$/);
    assert.equal(urls.live.size, 3);
  });

  it('drops what was read from a slice when the plate is sliced into a different file', async () => {
    const { plates, archive, urls } = setup();
    const first = artifact('a');
    plates.record('plate-1', first, { totalLayers: 10, profileFingerprint: FINGERPRINT });
    plates.loadLayerPreview('plate-1', 1);
    await resolveAll(archive.reads);

    // A batch hands the same artifact over again when it finishes.
    plates.record('plate-1', first, { totalLayers: 10, profileFingerprint: FINGERPRINT });
    assert.equal(plates.getSnapshot().previews['plate-1']?.size, 1);

    plates.record('plate-1', artifact('b'), { totalLayers: 10, profileFingerprint: FINGERPRINT });
    assert.equal(plates.getSnapshot().previews['plate-1'], undefined);
    assert.equal(urls.live.size, 0);
  });

  it('a run for one plate leaves the others sliced', async () => {
    const { plates, archive } = setup();
    plates.record('plate-1', artifact('a'), { totalLayers: 10, profileFingerprint: FINGERPRINT });
    plates.record('plate-2', artifact('b'), { totalLayers: 20, profileFingerprint: FINGERPRINT });
    plates.loadLayerPreview('plate-1', 1);
    plates.loadLayerPreview('plate-2', 1);
    await resolveAll(archive.reads);

    plates.runStarted('plate-2');

    const { plates: slices, previews } = plates.getSnapshot();
    assert.equal(slices['plate-1']?.artifact?.outputName, 'a.ctb');
    assert.equal(previews['plate-1']?.size, 1);
    assert.equal(slices['plate-2']?.artifact, null);
    assert.equal(previews['plate-2'], undefined);
  });

  it('gives the layer count of a finished run to the plate that was sliced, not another', () => {
    const { plates } = setup();
    plates.record('plate-1', artifact('a'), { totalLayers: 10, profileFingerprint: FINGERPRINT });
    plates.runStarted('plate-2');
    plates.record('plate-2', artifact('b'), { profileFingerprint: FINGERPRINT });

    plates.runFinished(42);

    assert.equal(plates.getSnapshot().plates['plate-1']?.totalLayers, 10);
    assert.equal(plates.getSnapshot().plates['plate-2']?.totalLayers, 42);
  });

  it('drops a read that lands after its plate was re-sliced, and never makes a URL for it', async () => {
    const { plates, archive, urls } = setup();
    plates.record('plate-1', artifact('a'), { totalLayers: 10, profileFingerprint: FINGERPRINT });
    plates.loadLayerPreview('plate-1', 5);

    plates.runStarted('plate-1');
    await resolveAll(archive.reads);

    assert.equal(plates.getSnapshot().previews['plate-1'], undefined);
    assert.equal(urls.live.size, 0);
  });

  it('reads ahead around the layer on screen once per slice of every plate', async () => {
    const { plates, archive } = setup({ prefetchRadius: 2 });
    plates.record('plate-1', artifact('a'), { totalLayers: 10, profileFingerprint: FINGERPRINT });
    plates.record('plate-2', artifact('b'), { totalLayers: 3, profileFingerprint: FINGERPRINT });

    plates.prefetch(2);
    assert.deepEqual(
      archive.reads.map((read) => [read.path, read.layers.slice().sort((a, b) => a - b)]),
      [['/tmp/a.ctb', [1, 2, 3, 4]], ['/tmp/b.ctb', [1, 2, 3]]],
    );
    await resolveAll(archive.reads);

    plates.prefetch(5);
    assert.equal(archive.reads.length, 0, 'the same slices are not read ahead twice');

    plates.record('plate-1', artifact('c'), { totalLayers: 10, profileFingerprint: FINGERPRINT });
    plates.prefetch(5);
    assert.deepEqual(archive.reads.map((read) => read.layers.slice().sort((a, b) => a - b)), [[3, 4, 5, 6, 7]]);
  });

  it('marks only the plate whose models an edit replaced', () => {
    const { plates } = setup();
    const onPlate1 = { id: 'm1' };
    const onPlate2 = { id: 'm2' };
    plates.observeModels(new Map([['plate-1', [onPlate1]], ['plate-2', [onPlate2]]]), false);
    plates.record('plate-1', artifact('a'), { totalLayers: 10, profileFingerprint: FINGERPRINT });
    plates.record('plate-2', artifact('b'), { totalLayers: 10, profileFingerprint: FINGERPRINT });

    const moved = { ...onPlate2 };
    plates.observeModels(new Map([['plate-1', [onPlate1]], ['plate-2', [moved]]]), true);

    const { plates: slices } = plates.getSnapshot();
    assert.equal(isSlicedPlateStale(slices['plate-1'], FINGERPRINT), false);
    assert.equal(isSlicedPlateStale(slices['plate-2'], FINGERPRINT), true);
  });

  it('marks a plate a model moved onto or off', () => {
    const { plates } = setup();
    const model = { id: 'm1' };
    plates.observeModels(new Map([['plate-1', [model]]]), false);
    plates.record('plate-1', artifact('a'), { totalLayers: 10, profileFingerprint: FINGERPRINT });
    plates.record('plate-2', artifact('b'), { totalLayers: 10, profileFingerprint: FINGERPRINT });

    plates.observeModels(new Map([['plate-2', [{ ...model }]]]), true);

    const { plates: slices } = plates.getSnapshot();
    assert.equal(slices['plate-1']?.edited, true);
    assert.equal(slices['plate-2']?.edited, true);
  });

  it('counts an edit it cannot put on a plate against every plate', () => {
    const { plates } = setup();
    const models = new Map([['plate-1', [{ id: 'm1' }]], ['plate-2', [{ id: 'm2' }]]]);
    plates.observeModels(models, false);
    plates.record('plate-1', artifact('a'), { totalLayers: 10, profileFingerprint: FINGERPRINT });
    plates.record('plate-2', artifact('b'), { totalLayers: 10, profileFingerprint: FINGERPRINT });

    // A support edit: a history entry, and the models are the same objects.
    plates.observeModels(models, true);

    const { plates: slices } = plates.getSnapshot();
    assert.equal(slices['plate-1']?.edited, true);
    assert.equal(slices['plate-2']?.edited, true);
  });

  it('does not count a change no history entry made', () => {
    const { plates } = setup();
    plates.observeModels(new Map([['plate-1', [{ id: 'm1' }]]]), false);
    plates.record('plate-1', artifact('a'), { totalLayers: 10, profileFingerprint: FINGERPRINT });

    plates.observeModels(new Map([['plate-1', [{ id: 'm1' }]]]), false);

    assert.equal(plates.getSnapshot().plates['plate-1']?.edited, false);
  });

  it('re-slicing one plate does not make another one fresh', () => {
    const { plates } = setup();
    const models = new Map([['plate-1', [{ id: 'm1' }]], ['plate-2', [{ id: 'm2' }]]]);
    plates.observeModels(models, false);
    plates.record('plate-1', artifact('a'), { totalLayers: 10, profileFingerprint: FINGERPRINT });
    plates.record('plate-2', artifact('b'), { totalLayers: 10, profileFingerprint: FINGERPRINT });
    plates.observeModels(models, true);

    plates.runStarted('plate-2');
    plates.record('plate-2', artifact('c'), { totalLayers: 10, profileFingerprint: FINGERPRINT });

    const { plates: slices } = plates.getSnapshot();
    assert.equal(isSlicedPlateStale(slices['plate-1'], FINGERPRINT), true);
    assert.equal(isSlicedPlateStale(slices['plate-2'], FINGERPRINT), false);
  });

  it('holds a slice to the printer and material it was made for', () => {
    const { plates } = setup();
    plates.record('plate-1', artifact('a'), { totalLayers: 10, profileFingerprint: FINGERPRINT });
    const slice = plates.getSnapshot().plates['plate-1'];

    assert.equal(isSlicedPlateStale(slice, sliceProfileFingerprint('saturn-2', 'tough')), true);
    assert.equal(isSlicedPlateStale(slice, FINGERPRINT), false);
    assert.equal(isSlicedPlateStale(undefined, FINGERPRINT), false, 'no slice is not a stale one');
  });

  it('clear revokes every preview and drops reads still under way', async () => {
    const { plates, archive, urls } = setup();
    plates.record('plate-1', artifact('a'), { totalLayers: 10, profileFingerprint: FINGERPRINT });
    plates.loadLayerPreview('plate-1', 1);
    await resolveAll(archive.reads);
    plates.loadLayerPreview('plate-1', 2);

    plates.clear();
    await resolveAll(archive.reads);

    assert.deepEqual(plates.getSnapshot(), { plates: {}, previews: {} });
    assert.equal(urls.live.size, 0);
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import { getSnapshot, setSnapshot } from '@/supports/state';
import { createEmptySupportCollections } from '@/supports/supportTypeRegistry';
import { getRaftSettings, setRaftSettings, updateRaftSettings } from '@/supports/Rafts/Crenelated/RaftState';
import { buildSolidSliceMeshForWasm } from '../rasterLayerZipExport';
import { cubeModel } from './helpers/captureAppSliceJob';

let fixtureId = 0;
function fixture() {
  const model = cubeModel(`cooperative-${++fixtureId}`, 2);
  const position = model.geometry.geometry.getAttribute('position');
  const template = new Float32Array(position.array);
  const positions = new Float32Array(template.length * 16384);
  for (let offset=0;offset<positions.length;offset+=template.length) positions.set(template, offset);
  model.geometry.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  model.polygonCount = positions.length / 9;
  const supports = getSnapshot();
  const raft = getRaftSettings();
  setSnapshot({ ...supports, ...createEmptySupportCollections() });
  updateRaftSettings({ bottomMode: 'off' });
  return {
    model, positions,
    options: {
      models: [model], filenameBase: 'cooperative', meshChunkTargetBytes: 4*1024*1024,
      printerProfile: { id:'cooperative-printer', name:'Cooperative', buildVolumeMm:{width:20,depth:20,height:20}, display:{resolutionX:64,resolutionY:64,outputFormat:'.ctb'} } as PrinterProfile,
      materialProfile: { id:'cooperative-material', name:'Cooperative', layerHeightMm:0.05 } as MaterialProfile,
    },
    dispose() { model.geometry.geometry.dispose(); setSnapshot(supports); setRaftSettings(raft); },
  };
}
function gate() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return { entered: entered.promise, release: release.resolve, wait: async () => { entered.resolve(); await release.promise; } };
}

test('streamed cooperative transforms preserve exact triangle order and plate-local coordinates', async () => {
  const f = fixture();
  const chunks: Uint8Array[] = [];
  try {
    const mesh = await buildSolidSliceMeshForWasm({ ...f.options, plateOffsetMm: { dxMm:0.5,dyMm:0.25 },
      flushBinaryMeshChunk: async bytes => { chunks.push(bytes.slice()); } });
    const actual = new Uint8Array(chunks.reduce((sum,bytes)=>sum+bytes.byteLength,0));
    let offset=0; for(const chunk of chunks) { actual.set(chunk,offset); offset+=chunk.byteLength; }
    const expected = f.positions.slice();
    for(let i=0;i<expected.length;i+=3) { expected[i]-=0.5; expected[i+1]-=0.25; }
    assert.deepEqual(actual,new Uint8Array(expected.buffer));
    assert.equal(mesh.modelTriangleCount,f.model.polygonCount);
    assert.equal(mesh.trianglesXYZ.length,0);
  } finally { f.dispose(); }
});

test('producer observes backpressure and cancellation before reading the entire source', {timeout:10000}, async () => {
  const f=fixture();
  const blocked=gate();
  const controller=new AbortController();
  const position=f.model.geometry.geometry.getAttribute('position');
  const getX=position.getX.bind(position);
  let reads=0;
  position.getX=index=>{reads++;return getX(index);};
  try {
    const preparing=buildSolidSliceMeshForWasm({...f.options,abortSignal:controller.signal,
      flushBinaryMeshChunk:async()=>blocked.wait()});
    const rejected=assert.rejects(preparing,{name:'AbortError'});
    await blocked.entered;
    assert.ok(reads<position.count,'a blocked consumer cannot accumulate the entire mesh before it is awaited');
    controller.abort(); blocked.release();
    await rejected;
    assert.ok(reads<position.count,'cancellation stops the remaining source scan');
  } finally { blocked.release(); f.dispose(); }
});

test('an in-place geometry edit during a yielded scan fails rather than mixing revisions', {timeout:10000}, async () => {
  const f=fixture();
  const blocked=gate();
  let first=true;
  try {
    const preparing=buildSolidSliceMeshForWasm({...f.options,flushBinaryMeshChunk:async()=>{if(first){first=false;await blocked.wait();}}});
    const rejected=assert.rejects(preparing,/Geometry changed while preparing slice input/);
    await blocked.entered;
    const position=f.model.geometry.geometry.getAttribute('position');
    position.setX(position.count-1,position.getX(position.count-1)+0.25);
    position.needsUpdate=true;
    blocked.release();
    await rejected;
  } finally { blocked.release(); f.dispose(); }
});

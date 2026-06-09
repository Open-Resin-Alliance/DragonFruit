/**
 * Diagnostic: which point-transform seats the contacts ON the mesh surface?
 *
 * The main probe shows contacts float 3-15mm off the mesh in all directions.
 * That signals the contact-point transform and the mesh transform are not in the
 * same frame. Here we try several candidate transforms for the contact points and,
 * for each, measure the nearest-surface distance (a true seat → ~0mm). Whichever
 * candidate seats all contacts is the real frame the importer must be using.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { decode } from '@msgpack/msgpack';

const LYS_PATH = 'C:\\Users\\tyman\\Desktop\\Lys Conversion\\V3 Puck.lys';
const KEY='DragonFruitFTW';
const XOR=[0x25,0x4a,0x04,0x02,0x5e,0x5f,0x72,0x44,0x58,0x51,0x10,0x76,0x67,0x7a,0x70,0x10,0x57,0x5e,0x42,0x56,0x27,0x44,0x42,0x44,0x41,0x7f,0x64,0x67,0x7d,0x13,0x52,0x01,0x56,0x0b,0x23,0x45];
function xorD(i,m){const mb=new TextEncoder().encode(m);const o=new Uint8Array(i.length);for(let x=0;x<i.length;x++)o[x]=i[x]^mb[x%mb.length];return new TextDecoder().decode(o);}
const APP=xorD(XOR,KEY);
function dec(d,k){const o=new Uint8Array(d.length);const kb=new TextEncoder().encode(k);for(let i=0;i<d.length;i++){const v=d[i]-kb[i%kb.length];o[i]=((v%256)+256)%256;}return o;}
function fh(data){const dc=new TextDecoder();const max=Math.min(data.length,2_000_000);const ext=(s)=>{let d=0,is=false,es=false;for(let i=s;i<max;i++){const c=data[i];if(is){if(es){es=false;continue;}if(c===92){es=true;continue;}if(c===34)is=false;continue;}if(c===34){is=true;continue;}if(c===123){d++;continue;}if(c===125){d--;if(d===0)return{start:s,end:i+1};if(d<0)return null;}}return null;};const mk=new TextEncoder().encode('"mangoFiles"');const ms=[];for(let i=0;i<=max-mk.length;i++){let ok=true;for(let j=0;j<mk.length;j++)if(data[i+j]!==mk[j]){ok=false;break;}if(ok)ms.push(i);}const cs=[];for(const m of ms)for(let i=m;i>=Math.max(0,m-200_000);i--)if(data[i]===123){cs.push(i);break;}for(let i=0;i<max;i++){if(data[i]===123)cs.push(i);if(cs.length>2000)break;}const seen=new Set();for(const s of cs){if(seen.has(s))continue;seen.add(s);const b=ext(s);if(!b)continue;try{const p=JSON.parse(dc.decode(data.subarray(b.start,b.end)));if(p&&typeof p==='object'&&(p.mangoFiles||p.version||p.scene))return b;}catch{}}throw new Error('no header');}
function parseGeometry(buffer){const MIN=20;const view=new DataView(buffer);const dh=view.getUint32(4,true);const off=(dh>=MIN&&dh<=buffer.byteLength)?dh:MIN;const ni=view.getUint32(8,true);const nc=view.getUint32(12,true);const ib=ni*4,cb=nc*4;const idx=new Uint32Array(buffer.slice(off,off+ib));const crd=new Float32Array(buffer.slice(off+ib,off+ib+cb));const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(crd,3));g.setIndex(new THREE.BufferAttribute(idx,1));const f=g.toNonIndexed();f.computeVertexNormals();return f;}

const buf=readFileSync(LYS_PATH);const data=new Uint8Array(buf.buffer,buf.byteOffset,buf.byteLength);
const {start,end}=fh(data);const manifest=JSON.parse(new TextDecoder().decode(data.subarray(start,end)));
let ds=end;while(ds<data.length&&data[ds]===0)ds++;
let sb=null;const blobs=new Map();
for(const [f,info] of Object.entries(manifest.mangoFiles||{})){const off=ds+Number(info.offset||0);const sz=Number(info.size||0);if(f.toLowerCase()==='scene.bin')sb=data.subarray(off,off+sz);else if(f.toLowerCase().endsWith('.bin'))blobs.set(f.slice(0,-4),data.subarray(off,off+sz));}
const scene=decode(dec(sb,APP));
const objects=scene.objects.present.byId;const o4=objects.o4;
const hash=o4.properties.hash;let blob=blobs.get(hash);if(!blob){let best=null;for(const[,b]of blobs)if(!best||b.byteLength>best.byteLength)best=b;blob=best;}
const geo=parseGeometry(blob.slice().buffer);

const center=o4.formerCenter||o4.center||{x:0,y:0,z:0};
const position=o4.position||{x:0,y:0,z:0};
const scale=o4.scale||{x:1,y:1,z:1};

// Raw geometry AABB (pre-transform) so we understand the mesh's native frame.
geo.computeBoundingBox();
const gb=geo.boundingBox;
console.log('RAW geometry AABB (as stored in blob):');
console.log('  min', `(${gb.min.x.toFixed(3)},${gb.min.y.toFixed(3)},${gb.min.z.toFixed(3)})`, 'max', `(${gb.max.x.toFixed(3)},${gb.max.y.toFixed(3)},${gb.max.z.toFixed(3)})`);
console.log('  size', `(${(gb.max.x-gb.min.x).toFixed(3)},${(gb.max.y-gb.min.y).toFixed(3)},${(gb.max.z-gb.min.z).toFixed(3)})`);
console.log('  o4.center', JSON.stringify(center));
console.log('  o4.dimension', JSON.stringify(o4.dimension));
console.log('  o4.position', JSON.stringify(position), 'scale', JSON.stringify(scale));

const supports=scene.supports.present.byId;
const pts=[
  ['s573.base', supports.s573.base],
  ['s573.tip', supports.s573.tip],
  ['s574.base', supports.s574.base],
  ['s574.tip', supports.s574.tip],
];
console.log('\nRaw contact points (as stored):');
for(const[n,p]of pts) console.log(`  ${n.padEnd(11)} (${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)})`);

// Build a mesh from raw geometry (NO transform) and a BVH-free nearest-distance probe.
// We'll measure nearest surface distance by sampling: build a raycaster shooting in +X/-X/+Y/-Y/+Z/-Z
// from the candidate point and taking the min hit distance (good enough to spot ~0 seats).
const meshRaw=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
meshRaw.updateMatrixWorld(true);
const DIRS=[new THREE.Vector3(1,0,0),new THREE.Vector3(-1,0,0),new THREE.Vector3(0,1,0),new THREE.Vector3(0,-1,0),new THREE.Vector3(0,0,1),new THREE.Vector3(0,0,-1)];
function nearestSurfaceDist(p){
  let best=Infinity;
  for(const d of DIRS){const rc=new THREE.Raycaster();rc.set(p.clone(),d);const h=rc.intersectObject(meshRaw,false);if(h.length)best=Math.min(best,h[0].distance);}
  return best;
}

// Candidate transforms for a contact point p (object-local authored) → mesh-raw frame.
// meshRaw is in the blob's native coordinates. We try:
const candidates = {
  'identity (p as-is)':        (p)=>new THREE.Vector3(p.x,p.y,p.z),
  'p + center':                (p)=>new THREE.Vector3(p.x+center.x,p.y+center.y,p.z+center.z),
  'p - center':                (p)=>new THREE.Vector3(p.x-center.x,p.y-center.y,p.z-center.z),
  'p*scale + center':          (p)=>new THREE.Vector3(p.x*scale.x+center.x,p.y*scale.y+center.y,p.z*scale.z+center.z),
  '(p - position)+center':     (p)=>new THREE.Vector3(p.x-position.x+center.x,p.y-position.y+center.y,p.z-position.z+center.z),
  '(p - position)':            (p)=>new THREE.Vector3(p.x-position.x,p.y-position.y,p.z-position.z),
};

console.log('\n=== nearest-surface distance per candidate transform (lower = seats on mesh) ===');
for(const [name,fn] of Object.entries(candidates)){
  const dists=pts.map(([,p])=>nearestSurfaceDist(fn(p)));
  const fmt=dists.map(d=>Number.isFinite(d)?d.toFixed(3):'inf').join(', ');
  const max=Math.max(...dists.filter(Number.isFinite));
  console.log(`  ${name.padEnd(26)} dists=[${fmt}]  worst=${Number.isFinite(max)?max.toFixed(3):'inf'}`);
}

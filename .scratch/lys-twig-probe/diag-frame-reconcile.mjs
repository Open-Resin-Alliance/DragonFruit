/**
 * Reconcile the two frames precisely.
 *
 * KNOWN (probe2): raw contact point P_raw sits ON the raw geometry surface (~0mm).
 * The ghost mesh's inner mesh has matrixWorld M. A raw-geometry vertex V is placed
 * in world at M * V. So the surface point that P_raw lies on appears in world at
 * M * P_raw.
 *
 * The importer's contact point is transformObjectPoint(P_raw_authored). For the
 * raycast to hit the surface, transformObjectPoint(P) must equal M * P (the same
 * world location the surface moved to). We test that equality directly.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { decode } from '@msgpack/msgpack';
const LYS_PATH='C:\\Users\\tyman\\Desktop\\Lys Conversion\\V3 Puck.lys';
const KEY='DragonFruitFTW';
const XOR=[0x25,0x4a,0x04,0x02,0x5e,0x5f,0x72,0x44,0x58,0x51,0x10,0x76,0x67,0x7a,0x70,0x10,0x57,0x5e,0x42,0x56,0x27,0x44,0x42,0x44,0x41,0x7f,0x64,0x67,0x7d,0x13,0x52,0x01,0x56,0x0b,0x23,0x45];
function xorD(i,m){const mb=new TextEncoder().encode(m);const o=new Uint8Array(i.length);for(let x=0;x<i.length;x++)o[x]=i[x]^mb[x%mb.length];return new TextDecoder().decode(o);}
const APP=xorD(XOR,KEY);
function dec(d,k){const o=new Uint8Array(d.length);const kb=new TextEncoder().encode(k);for(let i=0;i<d.length;i++){const v=d[i]-kb[i%kb.length];o[i]=((v%256)+256)%256;}return o;}
function fh(data){const dc=new TextDecoder();const max=Math.min(data.length,2_000_000);const ext=(s)=>{let d=0,is=false,es=false;for(let i=s;i<max;i++){const c=data[i];if(is){if(es){es=false;continue;}if(c===92){es=true;continue;}if(c===34)is=false;continue;}if(c===34){is=true;continue;}if(c===123){d++;continue;}if(c===125){d--;if(d===0)return{start:s,end:i+1};if(d<0)return null;}}return null;};const mk=new TextEncoder().encode('"mangoFiles"');const ms=[];for(let i=0;i<=max-mk.length;i++){let ok=true;for(let j=0;j<mk.length;j++)if(data[i+j]!==mk[j]){ok=false;break;}if(ok)ms.push(i);}const cs=[];for(const m of ms)for(let i=m;i>=Math.max(0,m-200_000);i--)if(data[i]===123){cs.push(i);break;}for(let i=0;i<max;i++){if(data[i]===123)cs.push(i);if(cs.length>2000)break;}const seen=new Set();for(const s of cs){if(seen.has(s))continue;seen.add(s);const b=ext(s);if(!b)continue;try{const p=JSON.parse(dc.decode(data.subarray(b.start,b.end)));if(p&&typeof p==='object'&&(p.mangoFiles||p.version||p.scene))return b;}catch{}}throw new Error('no header');}
function parseGeometry(buffer){const MIN=20;const view=new DataView(buffer);const dh=view.getUint32(4,true);const off=(dh>=MIN&&dh<=buffer.byteLength)?dh:MIN;const ni=view.getUint32(8,true);const nc=view.getUint32(12,true);const ib=ni*4,cb=nc*4;const idx=new Uint32Array(buffer.slice(off,off+ib));const crd=new Float32Array(buffer.slice(off+ib,off+ib+cb));const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(crd,3));g.setIndex(new THREE.BufferAttribute(idx,1));const f=g.toNonIndexed();f.computeVertexNormals();return f;}
function quatDeg(rot){const d2r=Math.PI/180;const x=(rot?.x||0)*d2r,y=(rot?.y||0)*d2r,z=(rot?.z||0)*d2r;const qx=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),x);const qy=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),y);const qz=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),z);return qz.multiply(qy).multiply(qx);}

const buf=readFileSync(LYS_PATH);const data=new Uint8Array(buf.buffer,buf.byteOffset,buf.byteLength);
const {start,end}=fh(data);const manifest=JSON.parse(new TextDecoder().decode(data.subarray(start,end)));
let ds=end;while(ds<data.length&&data[ds]===0)ds++;
let sb=null;const blobs=new Map();
for(const [f,info] of Object.entries(manifest.mangoFiles||{})){const off=ds+Number(info.offset||0);const sz=Number(info.size||0);if(f.toLowerCase()==='scene.bin')sb=data.subarray(off,off+sz);else if(f.toLowerCase().endsWith('.bin'))blobs.set(f.slice(0,-4),data.subarray(off,off+sz));}
const scene=decode(dec(sb,APP));
const o4=scene.objects.present.byId.o4;
const hash=o4.properties.hash;let blob=blobs.get(hash);if(!blob){let best=null;for(const[,b]of blobs)if(!best||b.byteLength>best.byteLength)best=b;blob=best;}
const geo=parseGeometry(blob.slice().buffer);

const center=o4.formerCenter||o4.center||{x:0,y:0,z:0};
const position=o4.position||{x:0,y:0,z:0};
const scale=o4.scale||{x:1,y:1,z:1};
const rotation=o4.rotation||{x:0,y:0,z:0};
const d2r=Math.PI/180;

// production ghost mesh
const ghostGroup=new THREE.Group();
ghostGroup.position.set(0,0,position.z);
ghostGroup.scale.set(scale.x,scale.y,scale.z);
ghostGroup.rotation.copy(new THREE.Euler((rotation.x||0)*d2r,(rotation.y||0)*d2r,(rotation.z||0)*d2r,'XYZ'));
const mesh=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
mesh.position.set(-center.x,-center.y,-center.z);
ghostGroup.add(mesh);
ghostGroup.updateMatrixWorld(true);

// transformObjectPoint (no center subtract)
const objScale=new THREE.Vector3(scale.x,scale.y,scale.z);
const objQuat=quatDeg(rotation);
const objPre=new THREE.Vector3(0,0,position.z);
const TOP=(v)=>new THREE.Vector3(v.x,v.y,v.z).multiply(objScale).applyQuaternion(objQuat).add(objPre);

const s573=scene.supports.present.byId.s573;
const Praw=new THREE.Vector3(s573.base.x,s573.base.y,s573.base.z);

const M = mesh.matrixWorld.clone();
const viaMesh = Praw.clone().applyMatrix4(M);       // where the surface point moved to in world
const viaTOP  = TOP(s573.base);                      // where the importer puts the contact

console.log('raw contact P:           ', `(${Praw.x.toFixed(3)},${Praw.y.toFixed(3)},${Praw.z.toFixed(3)})`);
console.log('M * P (surface in world):', `(${viaMesh.x.toFixed(3)},${viaMesh.y.toFixed(3)},${viaMesh.z.toFixed(3)})`);
console.log('transformObjectPoint(P): ', `(${viaTOP.x.toFixed(3)},${viaTOP.y.toFixed(3)},${viaTOP.z.toFixed(3)})`);
console.log('delta (TOP - M*P):       ', `(${(viaTOP.x-viaMesh.x).toFixed(3)},${(viaTOP.y-viaMesh.y).toFixed(3)},${(viaTOP.z-viaMesh.z).toFixed(3)})`);
console.log('|delta|:                 ', viaTOP.distanceTo(viaMesh).toFixed(4),'mm');
console.log('');
console.log('o4.center:', JSON.stringify(center));
console.log('NOTE: if delta == center, then transformObjectPoint is MISSING the -center the mesh applies.');
console.log('      if delta == 0, frames already agree and the production-frame probe has another bug.');

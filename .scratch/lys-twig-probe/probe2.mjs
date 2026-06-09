/**
 * LYS anatomy-less contact PROBE v2 (raw-frame, read-only).
 *
 * KEY CORRECTION (user): the importer WORKS and its transform logic is tested.
 * diag-transform.mjs proved the authored LYS base/tip points already sit ON the
 * RAW geometry-blob surface (identity transform → ~0mm). So contacts, mesh, and
 * authored normals all live in ONE frame: the raw blob frame. We measure there.
 * This avoids any hand-rebuilt ghost-mesh transform (which v1 got inconsistent).
 *
 * The normal-divergence ANGLE is frame-invariant as long as points + mesh share a
 * frame (they do), so measuring in raw frame is valid and matches what the importer
 * would see after a (rigid) transform.
 *
 * Measures, per anatomy-less MODEL contact:
 *   - raycast HIT/MISS at the contact
 *   - float-off (authored point → nearest surface)   [should be ~0 for true contacts]
 *   - angle(authored LYS normal, mesh surface normal)  [the whole question]
 *
 * Run: node .scratch/lys-twig-probe/probe2.mjs
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

// parseGeometry — verbatim LysParser policy incl. toNonIndexed()+computeVertexNormals (flat per-face)
function parseGeometry(buffer){
  const MIN=20;const view=new DataView(buffer);
  const dh=view.getUint32(4,true);const off=(dh>=MIN&&dh<=buffer.byteLength)?dh:MIN;
  const ni=view.getUint32(8,true);const nc=view.getUint32(12,true);
  const ib=ni*4,cb=nc*4;
  const idx=new Uint32Array(buffer.slice(off,off+ib));
  const crd=new Float32Array(buffer.slice(off+ib,off+ib+cb));
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.BufferAttribute(crd,3));
  g.setIndex(new THREE.BufferAttribute(idx,1));
  const f=g.toNonIndexed();f.computeVertexNormals();return f;
}

// calculateSmoothedNormal — faithful port of PlacementUtils.ts:21-79
const _nA=new THREE.Vector3(),_nB=new THREE.Vector3(),_nC=new THREE.Vector3();
const _pA=new THREE.Vector3(),_pB=new THREE.Vector3(),_pC=new THREE.Vector3();
const _tri=new THREE.Triangle(),_bary=new THREE.Vector3(),_interp=new THREE.Vector3();
function calculateSmoothedNormal(hit){
  if(!hit.face||!(hit.object instanceof THREE.Mesh)||!hit.object.geometry)return{x:hit.face?.normal.x??0,y:hit.face?.normal.y??0,z:hit.face?.normal.z??1};
  const geom=hit.object.geometry;const na=geom.attributes.normal;
  if(!na)return{x:hit.face.normal.x,y:hit.face.normal.y,z:hit.face.normal.z};
  const pa=geom.attributes.position;const{a,b,c}=hit.face;
  _nA.fromBufferAttribute(na,a);_nB.fromBufferAttribute(na,b);_nC.fromBufferAttribute(na,c);
  _pA.fromBufferAttribute(pa,a);_pB.fromBufferAttribute(pa,b);_pC.fromBufferAttribute(pa,c);
  _pA.applyMatrix4(hit.object.matrixWorld);_pB.applyMatrix4(hit.object.matrixWorld);_pC.applyMatrix4(hit.object.matrixWorld);
  _tri.set(_pA,_pB,_pC);_tri.getBarycoord(hit.point,_bary);
  _interp.set(0,0,0);_interp.addScaledVector(_nA,_bary.x).addScaledVector(_nB,_bary.y).addScaledVector(_nC,_bary.z);
  _interp.normalize();_interp.transformDirection(hit.object.matrixWorld);
  return{x:_interp.x,y:_interp.y,z:_interp.z};
}

// ---- load ----
const buf=readFileSync(LYS_PATH);const data=new Uint8Array(buf.buffer,buf.byteOffset,buf.byteLength);
const {start,end}=fh(data);const manifest=JSON.parse(new TextDecoder().decode(data.subarray(start,end)));
let ds=end;while(ds<data.length&&data[ds]===0)ds++;
let sb=null;const blobs=new Map();
for(const [f,info] of Object.entries(manifest.mangoFiles||{})){const off=ds+Number(info.offset||0);const sz=Number(info.size||0);if(f.toLowerCase()==='scene.bin')sb=data.subarray(off,off+sz);else if(f.toLowerCase().endsWith('.bin'))blobs.set(f.slice(0,-4),data.subarray(off,off+sz));}
const scene=decode(dec(sb,APP));
const objects=scene.objects.present.byId;const o4=objects.o4;
const hash=o4.properties.hash;let blob=blobs.get(hash);if(!blob){let best=null;for(const[,b]of blobs)if(!best||b.byteLength>best.byteLength)best=b;blob=best;}
const geo=parseGeometry(blob.slice().buffer);

// RAW-frame mesh: no transform at all (contacts already live here, proven by diag).
const mesh=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
mesh.updateMatrixWorld(true);
mesh.geometry.computeBoundingSphere();
geo.computeBoundingBox();
const box=geo.boundingBox.clone();
const radius=geo.boundingSphere.radius;
const FAR=radius*2+50;

const V=(o)=>new THREE.Vector3(o.x,o.y,o.z);
const angleDeg=(a,b)=>THREE.MathUtils.radToDeg(a.clone().normalize().angleTo(b.clone().normalize()));
const faceNormal=(hit)=>hit.face?V(hit.face.normal).normalize():null; // raw frame: face.normal already world (identity matrix)

function castThrough(contact,travelDir){
  const d=travelDir.clone().normalize();
  const origin=contact.clone().addScaledVector(d,-FAR);
  const rc=new THREE.Raycaster();rc.set(origin,d);
  const hits=rc.intersectObject(mesh,false);
  if(!hits.length)return null;
  let best=hits[0],bd=best.point.distanceTo(contact);
  for(const h of hits){const dist=h.point.distanceTo(contact);if(dist<bd){best=h;bd=dist;}}
  return best;
}

const supports=scene.supports.present.byId;
const s573=supports.s573,s574=supports.s574;

console.log('=== PROBE v2: RAW-frame contact seating (importer-trusted frame) ===\n');
console.log('raw geometry AABB:',`min(${box.min.x.toFixed(2)},${box.min.y.toFixed(2)},${box.min.z.toFixed(2)}) max(${box.max.x.toFixed(2)},${box.max.y.toFixed(2)},${box.max.z.toFixed(2)})  tris=${geo.attributes.position.count/3}`);

function measure(label,which,support){
  const isBase=which==='base';
  const contact=V(isBase?support.base:support.tip);
  const other=V(isBase?support.tip:support.base);
  const lysNraw=isBase?support.baseNormal:support.tipNormal;
  const lysN=lysNraw?V(lysNraw).normalize():null;
  console.log(`--- ${label} (${which}) ---`);
  console.log(`  contact(${contact.x.toFixed(3)},${contact.y.toFixed(3)},${contact.z.toFixed(3)})  authoredN=${lysN?`(${lysN.x.toFixed(3)},${lysN.y.toFixed(3)},${lysN.z.toFixed(3)})`:'NONE'}`);

  // Primary cast: along the OUTWARD authored normal — originate outside along +N, travel −N into the surface.
  // Secondary: along the shaft (other→contact).
  const cands=[];
  if(lysN)cands.push(['−authoredNormal',lysN.clone().multiplyScalar(-1)]);
  cands.push(['shaft(other→contact)',contact.clone().sub(other).normalize()]);

  for(const[dl,dir] of cands){
    const hit=castThrough(contact,dir);
    if(!hit){console.log(`  [${dl}] MISS`);continue;}
    const floatOff=hit.point.distanceTo(contact);
    const sm=V(calculateSmoothedNormal(hit));
    const fn=faceNormal(hit);
    const seat=floatOff<0.3?'SEATED':(floatOff<1.5?'near':'OFF');
    let line=`  [${dl}] HIT floatOff=${floatOff.toFixed(4)}mm[${seat}]`;
    if(lysN){line+=`  ∠(LYS,smoothed)=${angleDeg(lysN,sm).toFixed(2)}°`;if(fn)line+=`  ∠(LYS,face)=${angleDeg(lysN,fn).toFixed(2)}°`;}
    console.log(line);
  }
  console.log('');
}

console.log('=== TWIG s573 (both ends contact the model) ===');
measure('twig s573','base',s573);
measure('twig s573','tip',s573);

console.log('=== LEAF s574 (tip contacts model; base attaches to twig s573) ===');
measure('leaf s574','tip',s574);
console.log('(s574.base is the attach-to-twig end — expected to float off the mesh; shown for completeness)');
measure('leaf s574','base',s574);

console.log('=== PROBE v2 COMPLETE ===');

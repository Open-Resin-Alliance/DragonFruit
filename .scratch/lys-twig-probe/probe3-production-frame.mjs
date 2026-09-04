/**
 * PROBE v3 — PRODUCTION FRAME verification of the twig fix.
 *
 * Unlike probe2 (raw blob frame), this replicates the EXACT importer pipeline:
 *   - ghost mesh built per useLysSceneImport.ts:212-227 (mesh.position=-center,
 *     ghostGroup at (0,0,pos.z), scale, rotation, updateMatrixWorld)
 *   - contact points via transformObjectPoint (convertLysData.ts:134-140:
 *     scale → quaternion(rot) → +z)
 *   - normals via transformObjectNormal (:142-157)
 * Then runs the SAME raycastSurfaceNormal logic just added to convertLysData.ts
 * and reports, per twig contact:
 *   - raycast HIT/MISS in production frame
 *   - angle(authored transformed normal, raycast surface normal)  [the correction]
 *
 * If this shows HITs with large correction angles matching probe2 (111°, 50°),
 * the fix works in the real importer frame.
 *
 * Run: node .scratch/lys-twig-probe/probe3-production-frame.mjs
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

// calculateSmoothedNormal — faithful port
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

// quaternionFromGlobalEulerDegrees — port of src/utils/rotation.ts (extrinsic XYZ)
function quatFromGlobalEulerDeg(rot){
  const d2r=Math.PI/180;const x=(rot?.x||0)*d2r,y=(rot?.y||0)*d2r,z=(rot?.z||0)*d2r;
  const qx=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),x);
  const qy=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),y);
  const qz=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),z);
  return qz.multiply(qy).multiply(qx);
}

// raycastSurfaceNormal — port of the helper just added to convertLysData.ts
function raycastSurfaceNormal(contactWorld, authoredNormal, mesh){
  const fb={normal:{x:authoredNormal.x,y:authoredNormal.y,z:authoredNormal.z},raycastHit:false};
  if(!mesh||authoredNormal.lengthSq()<=1e-8)return fb;
  const dir=authoredNormal.clone().normalize().multiplyScalar(-1);
  mesh.geometry.computeBoundingSphere();
  const r=mesh.geometry.boundingSphere?.radius??0;
  const standoff=r*2+50;
  const origin=contactWorld.clone().addScaledVector(dir,-standoff);
  const rc=new THREE.Raycaster();rc.set(origin,dir);
  const hits=rc.intersectObject(mesh,false);
  if(!hits.length)return fb;
  let best=hits[0],bd=best.point.distanceTo(contactWorld);
  for(const h of hits){const dist=h.point.distanceTo(contactWorld);if(dist<bd){best=h;bd=dist;}}
  const sm=calculateSmoothedNormal(best);
  const n=new THREE.Vector3(sm.x,sm.y,sm.z);
  if(n.lengthSq()<=1e-8)return fb;
  n.normalize();
  return{normal:{x:n.x,y:n.y,z:n.z},raycastHit:true,floatOff:bd,hitPoint:best.point.clone()};
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

// ---- PRODUCTION ghost mesh (useLysSceneImport.ts:212-227) ----
const center=o4.formerCenter||o4.center||{x:0,y:0,z:0};
const position=o4.position||{x:0,y:0,z:0};
const scale=o4.scale||{x:1,y:1,z:1};
const rotation=o4.rotation||{x:0,y:0,z:0};
const d2r=Math.PI/180;

const ghostGroup=new THREE.Group();
ghostGroup.position.set(0,0,position.z);
ghostGroup.scale.set(scale.x,scale.y,scale.z);
ghostGroup.rotation.copy(new THREE.Euler((rotation.x||0)*d2r,(rotation.y||0)*d2r,(rotation.z||0)*d2r,'XYZ'));
const mesh=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
mesh.position.set(-center.x,-center.y,-center.z);
ghostGroup.add(mesh);
ghostGroup.updateMatrixWorld(true);
mesh.geometry.computeBoundingSphere();

// ---- transformObjectPoint / transformObjectNormal (convertLysData.ts:134-157) ----
const objScale=new THREE.Vector3(scale.x,scale.y,scale.z);
const objQuat=quatFromGlobalEulerDeg(rotation);
const objPre=new THREE.Vector3(0,0,Number.isFinite(position.z)?position.z:0);
const transformObjectPoint=(v)=>{const p=new THREE.Vector3(v.x,v.y,v.z);p.multiply(objScale);p.applyQuaternion(objQuat);p.add(objPre);return p;};
const transformObjectNormal=(v)=>{const n=new THREE.Vector3(v.x,v.y,v.z);const ix=Math.abs(objScale.x)>1e-8?1/objScale.x:0,iy=Math.abs(objScale.y)>1e-8?1/objScale.y:0,iz=Math.abs(objScale.z)>1e-8?1/objScale.z:0;n.set(n.x*ix,n.y*iy,n.z*iz);n.applyQuaternion(objQuat);if(n.lengthSq()>1e-8)n.normalize();return n;};

const angleDeg=(a,b)=>THREE.MathUtils.radToDeg(a.clone().normalize().angleTo(b.clone().normalize()));
const supports=scene.supports.present.byId;const s573=supports.s573;

console.log('=== PROBE v3: PRODUCTION-FRAME twig fix verification ===\n');
const wbox=new THREE.Box3().setFromObject(ghostGroup);
console.log('production ghost-mesh world AABB:',`min(${wbox.min.x.toFixed(2)},${wbox.min.y.toFixed(2)},${wbox.min.z.toFixed(2)}) max(${wbox.max.x.toFixed(2)},${wbox.max.y.toFixed(2)},${wbox.max.z.toFixed(2)})`);
console.log('');

function check(which){
  const isBase=which==='base';
  const ptRaw=isBase?s573.base:s573.tip;
  const nRaw=isBase?s573.baseNormal:s573.tipNormal;
  const contactWorld=transformObjectPoint(ptRaw);
  const authoredN=transformObjectNormal(nRaw); authoredN.normalize();
  const res=raycastSurfaceNormal(contactWorld,authoredN,mesh);
  console.log(`twig s573 disk ${isBase?'A (base)':'B (tip)'}:`);
  console.log(`  contactWorld(${contactWorld.x.toFixed(3)},${contactWorld.y.toFixed(3)},${contactWorld.z.toFixed(3)})`);
  console.log(`  authored transformed normal: (${authoredN.x.toFixed(3)},${authoredN.y.toFixed(3)},${authoredN.z.toFixed(3)})`);
  if(res.raycastHit){
    const rn=new THREE.Vector3(res.normal.x,res.normal.y,res.normal.z);
    console.log(`  RAYCAST HIT  floatOff=${res.floatOff.toFixed(4)}mm  surfaceNormal=(${rn.x.toFixed(3)},${rn.y.toFixed(3)},${rn.z.toFixed(3)})`);
    console.log(`  >>> CORRECTION APPLIED: ∠(authored, raycast) = ${angleDeg(authoredN,rn).toFixed(2)}°  (disk now seats to true face)`);
  } else {
    console.log(`  RAYCAST MISS → falls back to authored normal (no regression)`);
  }
  console.log('');
}
check('base');
check('tip');
console.log('=== expected: HITs with ~111° (base) and ~50° (tip) corrections, matching probe2 raw-frame ===');

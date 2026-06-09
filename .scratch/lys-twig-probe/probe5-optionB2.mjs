/**
 * PROBE v5 — verify Option B2: raycast the GHOST mesh (in scope in convert())
 * using a contact point compensated into the mesh frame.
 *
 * Relationship (proven by diag-frame-reconcile): for the ghost mesh,
 *   meshWorld(P_raw) = mesh.matrixWorld · P_raw
 *   transformObjectPoint(P_raw) = scale→rot→+z   (NO -center)
 *   delta = transformObjectPoint(P) - meshWorld(P) = R·S·center   (= center for o4)
 * So:  meshFrameContact = transformObjectPoint(P) - R·S·center
 * That point lies ON the ghost mesh, so a raycast there hits, and
 * calculateSmoothedNormal returns the WORLD-frame normal directly (it applies
 * mesh.matrixWorld internally). No separate normal mapping needed.
 *
 * We compute R·S·center from the object transform (NOT from P), so this works
 * for the general rotated/scaled case, using only data available in convert().
 *
 * Run: node .scratch/lys-twig-probe/probe5-optionB2.mjs
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
const _nA=new THREE.Vector3(),_nB=new THREE.Vector3(),_nC=new THREE.Vector3(),_pA=new THREE.Vector3(),_pB=new THREE.Vector3(),_pC=new THREE.Vector3(),_tri=new THREE.Triangle(),_bary=new THREE.Vector3(),_interp=new THREE.Vector3();
function smoothedNormal(hit){if(!hit.face||!(hit.object instanceof THREE.Mesh)||!hit.object.geometry)return{x:hit.face?.normal.x??0,y:hit.face?.normal.y??0,z:hit.face?.normal.z??1};const g=hit.object.geometry,na=g.attributes.normal;if(!na)return{x:hit.face.normal.x,y:hit.face.normal.y,z:hit.face.normal.z};const pa=g.attributes.position,{a,b,c}=hit.face;_nA.fromBufferAttribute(na,a);_nB.fromBufferAttribute(na,b);_nC.fromBufferAttribute(na,c);_pA.fromBufferAttribute(pa,a);_pB.fromBufferAttribute(pa,b);_pC.fromBufferAttribute(pa,c);_pA.applyMatrix4(hit.object.matrixWorld);_pB.applyMatrix4(hit.object.matrixWorld);_pC.applyMatrix4(hit.object.matrixWorld);_tri.set(_pA,_pB,_pC);_tri.getBarycoord(hit.point,_bary);_interp.set(0,0,0);_interp.addScaledVector(_nA,_bary.x).addScaledVector(_nB,_bary.y).addScaledVector(_nC,_bary.z);_interp.normalize();_interp.transformDirection(hit.object.matrixWorld);return{x:_interp.x,y:_interp.y,z:_interp.z};}

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

// PRODUCTION ghost mesh
const ghostGroup=new THREE.Group();
ghostGroup.position.set(0,0,position.z);
ghostGroup.scale.set(scale.x,scale.y,scale.z);
ghostGroup.rotation.copy(new THREE.Euler((rotation.x||0)*d2r,(rotation.y||0)*d2r,(rotation.z||0)*d2r,'XYZ'));
const mesh=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
mesh.position.set(-center.x,-center.y,-center.z);
ghostGroup.add(mesh);
ghostGroup.updateMatrixWorld(true);
mesh.geometry.computeBoundingSphere();
const FAR=mesh.geometry.boundingSphere.radius*2+50;

const objScale=new THREE.Vector3(scale.x,scale.y,scale.z);
const objQuat=quatDeg(rotation);
const objPre=new THREE.Vector3(0,0,position.z);
const transformObjectPoint=(v)=>new THREE.Vector3(v.x,v.y,v.z).multiply(objScale).applyQuaternion(objQuat).add(objPre);
const transformObjectNormal=(v)=>{const n=new THREE.Vector3(v.x,v.y,v.z);const ix=Math.abs(objScale.x)>1e-8?1/objScale.x:0,iy=Math.abs(objScale.y)>1e-8?1/objScale.y:0,iz=Math.abs(objScale.z)>1e-8?1/objScale.z:0;n.set(n.x*ix,n.y*iy,n.z*iz);n.applyQuaternion(objQuat);if(n.lengthSq()>1e-8)n.normalize();return n;};

// The center compensation: delta = R·S·center  (how far transformObjectPoint sits
// above the ghost mesh). Compute from object transform only.
const centerShift=new THREE.Vector3(center.x,center.y,center.z).multiply(objScale).applyQuaternion(objQuat);

// Option B2 raycast against the GHOST mesh.
function rayB2(worldContact, worldAuthoredNormal){
  const meshFrameContact=worldContact.clone().sub(centerShift); // now ON the ghost mesh
  const aN=worldAuthoredNormal.clone().normalize();
  const dir=aN.clone().multiplyScalar(-1);
  const origin=meshFrameContact.clone().addScaledVector(dir,-FAR);
  const rc=new THREE.Raycaster();rc.set(origin,dir);
  const hits=rc.intersectObject(mesh,false);
  if(!hits.length)return null;
  let best=hits[0],bd=best.point.distanceTo(meshFrameContact);
  for(const h of hits){const d=h.point.distanceTo(meshFrameContact);if(d<bd){best=h;bd=d;}}
  const sm=smoothedNormal(best); // already world frame (applies mesh.matrixWorld)
  return {floatOff:bd, worldNormal:new THREE.Vector3(sm.x,sm.y,sm.z).normalize()};
}

const angleDeg=(a,b)=>THREE.MathUtils.radToDeg(a.clone().angleTo(b.clone()));
const s573=scene.supports.present.byId.s573;

console.log('=== PROBE v5: Option B2 (ghost-mesh raycast, center-compensated point) ===');
console.log('centerShift (R·S·center):',`(${centerShift.x.toFixed(3)},${centerShift.y.toFixed(3)},${centerShift.z.toFixed(3)})`,'\n');
for(const which of ['base','tip']){
  const isBase=which==='base';
  const worldC=transformObjectPoint(isBase?s573.base:s573.tip);
  const worldN=transformObjectNormal(isBase?s573.baseNormal:s573.tipNormal); worldN.normalize();
  const res=rayB2(worldC,worldN);
  console.log(`twig s573 disk ${isBase?'A (base)':'B (tip)'}:`);
  console.log(`  authored WORLD normal: (${worldN.x.toFixed(3)},${worldN.y.toFixed(3)},${worldN.z.toFixed(3)})`);
  if(!res){console.log('  GHOST-MESH RAYCAST MISS → fallback to authored\n');continue;}
  console.log(`  ghost raycast: floatOff=${res.floatOff.toFixed(4)}mm  surfaceWorldN=(${res.worldNormal.x.toFixed(3)},${res.worldNormal.y.toFixed(3)},${res.worldNormal.z.toFixed(3)})`);
  console.log(`  >>> CORRECTION: ∠(authored, surface) = ${angleDeg(worldN,res.worldNormal).toFixed(2)}°\n`);
}
console.log('=== expected: floatOff ~0mm; corrections 111.08° / 50.46° (matches probe2 & probe4) ===');

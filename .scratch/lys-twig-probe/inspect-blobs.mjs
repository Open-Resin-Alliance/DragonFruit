import { readFileSync } from 'node:fs';
import { decode } from '@msgpack/msgpack';

const LYS_PATH = 'C:\\Users\\tyman\\Desktop\\Lys Conversion\\V3 Puck.lys';
const LYS_KEY_OBFUSCATION = 'DragonFruitFTW';
const LYS_DEFAULT_APP_ID_XOR = [0x25,0x4a,0x04,0x02,0x5e,0x5f,0x72,0x44,0x58,0x51,0x10,0x76,0x67,0x7a,0x70,0x10,0x57,0x5e,0x42,0x56,0x27,0x44,0x42,0x44,0x41,0x7f,0x64,0x67,0x7d,0x13,0x52,0x01,0x56,0x0b,0x23,0x45];
function xorD(input, mask){const m=new TextEncoder().encode(mask);const o=new Uint8Array(input.length);for(let i=0;i<input.length;i++)o[i]=input[i]^m[i%m.length];return new TextDecoder('utf-8').decode(o);}
const APP_ID = xorD(LYS_DEFAULT_APP_ID_XOR, LYS_KEY_OBFUSCATION);
function dec(data,key){const o=new Uint8Array(data.length);const k=new TextEncoder().encode(key);for(let i=0;i<data.length;i++){const v=data[i]-k[i%k.length];o[i]=((v%256)+256)%256;}return o;}
function findHeader(data){const dc=new TextDecoder('utf-8');const max=Math.min(data.length,2_000_000);const ext=(s)=>{let d=0,is=false,es=false;for(let i=s;i<max;i++){const c=data[i];if(is){if(es){es=false;continue;}if(c===92){es=true;continue;}if(c===34)is=false;continue;}if(c===34){is=true;continue;}if(c===123){d++;continue;}if(c===125){d--;if(d===0)return{start:s,end:i+1};if(d<0)return null;}}return null;};const mk=new TextEncoder().encode('"mangoFiles"');const ms=[];for(let i=0;i<=max-mk.length;i++){let ok=true;for(let j=0;j<mk.length;j++)if(data[i+j]!==mk[j]){ok=false;break;}if(ok)ms.push(i);}const cs=[];for(const m of ms)for(let i=m;i>=Math.max(0,m-200_000);i--)if(data[i]===123){cs.push(i);break;}for(let i=0;i<max;i++){if(data[i]===123)cs.push(i);if(cs.length>2000)break;}const seen=new Set();for(const s of cs){if(seen.has(s))continue;seen.add(s);const b=ext(s);if(!b)continue;try{const p=JSON.parse(dc.decode(data.subarray(b.start,b.end)));if(p&&typeof p==='object'&&(p.mangoFiles||p.version||p.scene))return b;}catch{}}throw new Error('no header');}

const buf=readFileSync(LYS_PATH);
const data=new Uint8Array(buf.buffer,buf.byteOffset,buf.byteLength);
const {start,end}=findHeader(data);
const manifest=JSON.parse(new TextDecoder('utf-8').decode(data.subarray(start,end)));
console.log('=== mangoFiles entries ===');
for(const [fname,info] of Object.entries(manifest.mangoFiles||{})){
  console.log(`  ${fname.padEnd(40)} offset=${info.offset} size=${info.size}`);
}

let dataStart=end; while(dataStart<data.length&&data[dataStart]===0)dataStart++;
let sceneBlob=null;
for(const [fname,info] of Object.entries(manifest.mangoFiles||{})){
  if(fname.toLowerCase()==='scene.bin'){const off=dataStart+Number(info.offset||0);sceneBlob=data.subarray(off,off+Number(info.size||0));break;}
}
const scene=decode(dec(sceneBlob,APP_ID));
const objects=scene?.objects?.present?.byId??{};
console.log('\n=== object records (all keys + any geometry/mesh reference fields) ===');
for(const [id,o] of Object.entries(objects)){
  console.log(`object ${id}:`);
  console.log('  keys:', Object.keys(o).sort().join(', '));
  // print likely geometry-reference fields
  for(const k of ['mesh','meshId','geometry','geometryId','file','fileName','fileId','mangoFile','blob','hash','meshFile','data','dataFile','model','modelFile']){
    if(o[k]!==undefined) console.log(`  ${k}:`, JSON.stringify(o[k]));
  }
  // print any string value that looks like a hash (32 hex) or ends in .bin
  for(const [k,v] of Object.entries(o)){
    if(typeof v==='string' && (/^[0-9a-f]{32}$/i.test(v) || v.toLowerCase().endsWith('.bin'))) console.log(`  (hash-like) ${k}: ${v}`);
  }
}

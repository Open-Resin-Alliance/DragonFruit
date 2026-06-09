import { readFileSync } from 'node:fs';
import { decode } from '@msgpack/msgpack';
const LYS_PATH = 'C:\\Users\\tyman\\Desktop\\Lys Conversion\\V3 Puck.lys';
const KEY='DragonFruitFTW';
const XOR=[0x25,0x4a,0x04,0x02,0x5e,0x5f,0x72,0x44,0x58,0x51,0x10,0x76,0x67,0x7a,0x70,0x10,0x57,0x5e,0x42,0x56,0x27,0x44,0x42,0x44,0x41,0x7f,0x64,0x67,0x7d,0x13,0x52,0x01,0x56,0x0b,0x23,0x45];
function xorD(i,m){const mb=new TextEncoder().encode(m);const o=new Uint8Array(i.length);for(let x=0;x<i.length;x++)o[x]=i[x]^mb[x%mb.length];return new TextDecoder().decode(o);}
const APP=xorD(XOR,KEY);
function dec(d,k){const o=new Uint8Array(d.length);const kb=new TextEncoder().encode(k);for(let i=0;i<d.length;i++){const v=d[i]-kb[i%kb.length];o[i]=((v%256)+256)%256;}return o;}
function fh(data){const dc=new TextDecoder();const max=Math.min(data.length,2_000_000);const ext=(s)=>{let d=0,is=false,es=false;for(let i=s;i<max;i++){const c=data[i];if(is){if(es){es=false;continue;}if(c===92){es=true;continue;}if(c===34)is=false;continue;}if(c===34){is=true;continue;}if(c===123){d++;continue;}if(c===125){d--;if(d===0)return{start:s,end:i+1};if(d<0)return null;}}return null;};const mk=new TextEncoder().encode('"mangoFiles"');const ms=[];for(let i=0;i<=max-mk.length;i++){let ok=true;for(let j=0;j<mk.length;j++)if(data[i+j]!==mk[j]){ok=false;break;}if(ok)ms.push(i);}const cs=[];for(const m of ms)for(let i=m;i>=Math.max(0,m-200_000);i--)if(data[i]===123){cs.push(i);break;}for(let i=0;i<max;i++){if(data[i]===123)cs.push(i);if(cs.length>2000)break;}const seen=new Set();for(const s of cs){if(seen.has(s))continue;seen.add(s);const b=ext(s);if(!b)continue;try{const p=JSON.parse(dc.decode(data.subarray(b.start,b.end)));if(p&&typeof p==='object'&&(p.mangoFiles||p.version||p.scene))return b;}catch{}}throw new Error('no header');}
const buf=readFileSync(LYS_PATH);const data=new Uint8Array(buf.buffer,buf.byteOffset,buf.byteLength);
const {start,end}=fh(data);const manifest=JSON.parse(new TextDecoder().decode(data.subarray(start,end)));
let ds=end;while(ds<data.length&&data[ds]===0)ds++;
let sb=null;for(const [f,info] of Object.entries(manifest.mangoFiles||{}))if(f.toLowerCase()==='scene.bin'){const off=ds+Number(info.offset||0);sb=data.subarray(off,off+Number(info.size||0));break;}
const scene=decode(dec(sb,APP));
const o4=scene.objects.present.byId.o4;
const blobName='a65e638a8734f113c7d899322bf63347';
console.log('library:', JSON.stringify(o4.library));
console.log('properties:', JSON.stringify(o4.properties));
console.log('stats:', JSON.stringify(o4.stats));
console.log('dimension:', JSON.stringify(o4.dimension));
console.log('plateId:', JSON.stringify(o4.plateId));
console.log('loaded:', JSON.stringify(o4.loaded));
console.log('initialized:', JSON.stringify(o4.initialized));
// search whole object JSON for the blob hash
const js=JSON.stringify(o4);
console.log('\nobject JSON contains blob hash "'+blobName+'":', js.includes(blobName));
console.log('object JSON length:', js.length);

#!/usr/bin/env npx tsx
/**
 * Reproduce island scan from IPC debug dump (TypeScript side).
 *
 * Reads the same positions.bin + params.json dumped by the Rust IPC,
 * runs the TS island scan pipeline, and outputs per-layer stats for comparison.
 *
 * Usage: npx tsx scripts/island-ipc-debug.ts /tmp/dragonfruit-island-debug/
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Reuse the full TS pipeline from island-stl-bench.ts ──
// (importing via relative path to avoid bundler issues)

// Types
type RleRow = Int32Array;
type RleMask = { rows: RleRow[]; width: number; height: number };
type RleLabelRow = Int32Array;
type RleLabels = { rows: RleLabelRow[]; width: number; height: number };
type ComponentInfo = { id: number; label: number; area_px: number; size: number; centroidSumX: number; centroidSumY: number };
type Island = {
  id: number; firstLayer: number; lastLayer: number; status: 'active' | 'complete';
  totalAreaMm2: number; perLayerAreaMm2: Map<number, number>; parentId?: number;
  childIds: number[]; volumeMm3?: number; maxAreaMm2?: number; maxAreaLayer?: number;
  isMergedPlaceholder?: boolean; centroidSumX: number; centroidSumY: number;
  centroidSumZ: number; centroidCount: number;
  centroid?: { x: number; y: number; z: number };
  lastLayerCentroid?: { x: number; y: number; z: number };
};

// ── RLE functions ──
function rleEncode(data: Uint8Array, w: number, h: number): RleMask {
  const rows: RleRow[] = new Array(h);
  for (let y = 0; y < h; y++) {
    const spans: number[] = []; let rs = -1; const ro = y * w;
    for (let x = 0; x < w; x++) {
      if (data[ro+x]) { if (rs===-1) rs=x; } else { if (rs!==-1) { spans.push(rs,x-rs); rs=-1; } }
    }
    if (rs!==-1) spans.push(rs,w-rs);
    rows[y] = new Int32Array(spans);
  }
  return { rows, width: w, height: h };
}
function rlePixelCount(mask: RleMask): number {
  let total = 0;
  for (const r of mask.rows) for (let i = 0; i < r.length; i += 2) total += r[i + 1];
  return total;
}
function rleIntersectDilated(a: RleMask, b: RleMask, buffer: number): RleMask {
  const { width: w, height: h } = a; const rr: RleRow[] = new Array(h);
  for (let y = 0; y < h; y++) {
    const ar = a.rows[y]; if (!ar.length) { rr[y] = new Int32Array(0); continue; }
    const brs: RleRow[] = [];
    for (let by = Math.max(0,y-buffer); by <= Math.min(h-1,y+buffer); by++) if (b.rows[by].length) brs.push(b.rows[by]);
    if (!brs.length) { rr[y] = new Int32Array(0); continue; }
    const bi: {s:number;e:number}[] = [];
    for (const br of brs) for (let i=0;i<br.length;i+=2) bi.push({s:Math.max(0,br[i]-buffer),e:Math.min(w,br[i]+br[i+1]+buffer)});
    bi.sort((a,b)=>a.s-b.s);
    const mb: {s:number;e:number}[] = [];
    if (bi.length) { let c=bi[0]; for (let i=1;i<bi.length;i++) { if (bi[i].s<=c.e) c.e=Math.max(c.e,bi[i].e); else { mb.push(c); c=bi[i]; } } mb.push(c); }
    const rs: number[] = []; let bI=0;
    for (let i=0;i<ar.length;i+=2) {
      const as_=ar[i],ae=as_+ar[i+1];
      while(bI<mb.length&&mb[bI].e<=as_) bI++;
      let t=bI;
      while(t<mb.length&&mb[t].s<ae) { const s=Math.max(as_,mb[t].s),e=Math.min(ae,mb[t].e);
        if(s<e){if(rs.length&&rs[rs.length-2]+rs[rs.length-1]===s)rs[rs.length-1]+=e-s;else rs.push(s,e-s);}t++;}
    }
    rr[y] = new Int32Array(rs);
  }
  return { rows: rr, width: w, height: h };
}
function rleSubtract(a: RleMask, b: RleMask): RleMask {
  const { width: w, height: h } = a; const rr: RleRow[] = new Array(h);
  for (let y=0;y<h;y++) {
    const ar=a.rows[y],br=b.rows[y];
    if(!ar.length){rr[y]=new Int32Array(0);continue;}if(!br.length){rr[y]=ar;continue;}
    const rs:number[]=[]; let bI=0;
    for(let i=0;i<ar.length;i+=2){let cs=ar[i];const ce=cs+ar[i+1];
      while(bI<br.length&&br[bI]+br[bI+1]<=cs)bI+=2;let t=bI;
      while(t<br.length&&br[t]<ce){const bs=br[t],be=bs+br[t+1];if(bs>cs)rs.push(cs,bs-cs);cs=Math.max(cs,be);t+=2;}
      if(cs<ce)rs.push(cs,ce-cs);}
    rr[y]=new Int32Array(rs);
  }
  return{rows:rr,width:w,height:h};
}
function rleLabelComponents(mask: RleMask, connectivity: 4|8=4): {labels:RleLabels;components:ComponentInfo[]} {
  const{rows,width:w,height:h}=mask;const lr:RleLabelRow[]=new Array(h);
  const p=[0],a=[0],sx=[0],sy=[0];let nid=1;
  function find(i:number):number{if(p[i]===i)return i;p[i]=find(p[i]);return p[i];}
  function union(i:number,j:number){const ri=find(i),rj=find(j);if(ri!==rj){p[rj]=ri;a[ri]+=a[rj];sx[ri]+=sx[rj];sy[ri]+=sy[rj];a[rj]=0;sx[rj]=0;sy[rj]=0;}}
  for(let y=0;y<h;y++){const row=rows[y],pr=y>0?lr[y-1]:null,cl:number[]=[];
    for(let i=0;i<row.length;i+=2){const s=row[i],l=row[i+1],e=s+l;
      const id=nid++;p[id]=id;a[id]=l;sx[id]=l*(s+(e-1))/2;sy[id]=l*y;cl.push(s,l,id);
      if(pr){const exp=connectivity===8?1:0,ss=s-exp,se=e+exp;
        for(let j=0;j<pr.length;j+=3){const ps=pr[j],pe=ps+pr[j+1],pid=pr[j+2];
          if(Math.max(ss,ps)<Math.min(se,pe))union(id,pid);if(ps>=se)break;}}}
    lr[y]=new Int32Array(cl);}
  const comps:ComponentInfo[]=[],im=new Map<number,number>();let fid=1;
  for(let y=0;y<h;y++){const row=lr[y];for(let i=0;i<row.length;i+=3){const root=find(row[i+2]);
    let f=im.get(root);if(f===undefined){f=fid++;im.set(root,f);comps.push({id:f,label:f,area_px:a[root],size:a[root],centroidSumX:sx[root],centroidSumY:sy[root]});}row[i+2]=f;}}
  return{labels:{rows:lr,width:w,height:h},components:comps};
}
function scanLayer(cur: RleMask, prev: RleMask|null, opts: {px_mm:number;support_buffer_mm:number;connectivity:4|8}) {
  let cands: RleMask;
  if(!prev) cands=cur;
  else { const buf=Math.max(0,Math.round(opts.support_buffer_mm/opts.px_mm)); cands=rleSubtract(cur,rleIntersectDilated(cur,prev,buf)); }
  const{labels,components}=rleLabelComponents(cands,opts.connectivity);
  return{labels,components,solidMask:cur};
}

// ── IslandTracker (compact, same as other scripts) ──
class IslandTracker {
  private islands = new Map<number,Island>(); private nextId=1; private px_mm:number;
  private minOverlapPx:number; private overlapNeighborhoodPx:number;
  private pendingMerges: any[] = []; private readonly MERGE_EVAL_WINDOW=30;
  constructor(px_mm:number,opts?:{minOverlapPx?:number;overlapNeighborhoodPx?:number}){
    this.px_mm=px_mm;this.minOverlapPx=Math.max(1,opts?.minOverlapPx??1);this.overlapNeighborhoodPx=Math.max(0,opts?.overlapNeighborhoodPx??1);}
  processLayer(li:number,cl:RleLabels,cc:ComponentInfo[],pil:RleLabels|null,sm:RleMask):RleLabels{
    const{width:w,height:h}=cl;const ilr:Int32Array[]=new Array(h);
    if(!pil){const m=new Map<number,number>();for(const c of cc){const a=c.area_px*this.px_mm*this.px_mm;m.set(c.id,this.createIsland(li,a,c));}
      for(let y=0;y<h;y++){const r=cl.rows[y],nr:number[]=[];for(let i=0;i<r.length;i+=3){const id=m.get(r[i+2])||0;if(id>0)nr.push(r[i],r[i+1],id);}ilr[y]=new Int32Array(nr);}
    } else {
      const{labels:sl,components:sc}=rleLabelComponents(sm,4);const m=new Map<number,number>();
      for(const comp of sc){const ov=this.findOverlaps(comp.id,sl,pil);
        const prev=new Set<number>();for(const[id,cnt]of ov)if(cnt>=this.minOverlapPx)prev.add(id);
        const active=new Set<number>();for(const id of prev){const isl=this.islands.get(id);if(isl&&isl.status==='active')active.add(id);}
        const rp=(sid:number):number=>{let c=sid;const v=new Set<number>();while(true){if(v.has(c))break;v.add(c);const i=this.islands.get(c);if(!i||i.parentId===undefined)break;c=i.parentId;}return c;};
        const a=comp.area_px*this.px_mm*this.px_mm;let aid:number;
        if(active.size===0){if(prev.size>0){aid=rp(prev.values().next().value as number);this.updateIsland(aid,li,a,comp);}else aid=this.createIsland(li,a,comp);}
        else if(active.size===1){aid=active.values().next().value as number;this.updateIsland(aid,li,a,comp);}
        else{const rs=new Set<number>();for(const id of active)rs.add(rp(id));aid=this.mergeIslands(li,rs,pil,a,comp);}
        m.set(comp.id,aid);this.trackMergeOverlaps(li,comp.id,sl,pil);}
      for(let y=0;y<h;y++){const r=sl.rows[y],nr:number[]=[];for(let i=0;i<r.length;i+=3){const id=m.get(r[i+2])||0;if(id>0)nr.push(r[i],r[i+1],id);}ilr[y]=new Int32Array(nr);}
    }
    this.evalMerges(li);return{rows:ilr,width:w,height:h};}
  private findOverlaps(cid:number,sl:RleLabels,pil:RleLabels):Map<number,number>{
    const c=new Map<number,number>();const{height:h}=sl;
    for(let y=0;y<h;y++){const sr=sl.rows[y];if(!sr.length)continue;
      for(let i=0;i<sr.length;i+=3){if(sr[i+2]!==cid)continue;
        const s=sr[i],e=s+sr[i+1],ss=s-this.overlapNeighborhoodPx,se=e+this.overlapNeighborhoodPx;
        const ys=Math.max(0,y-this.overlapNeighborhoodPx),ye=Math.min(h-1,y+this.overlapNeighborhoodPx);
        for(let py=ys;py<=ye;py++){const pr=pil.rows[py];if(!pr.length)continue;
          for(let j=0;j<pr.length;j+=3){const ps=pr[j],pe=ps+pr[j+1],pid=pr[j+2];
            const os=Math.max(ss,ps),oe=Math.min(se,pe);if(os<oe&&pid>0)c.set(pid,(c.get(pid)??0)+(oe-os));if(ps>=se)break;}}}}
    return c;}
  private trackMergeOverlaps(_li:number,cid:number,sl:RleLabels,_pil:RleLabels):void{
    if(!this.pendingMerges.length)return;for(const p of this.pendingMerges){
      const ov=this.findOverlaps(cid,sl,p.preMergeLabels);for(const[id,cnt]of ov)if(p.overlapCounts.has(id))p.overlapCounts.set(id,(p.overlapCounts.get(id)??0)+cnt);}}
  private createIsland(li:number,a:number,c?:ComponentInfo):number{const id=this.nextId++;
    this.islands.set(id,{id,firstLayer:li,lastLayer:li,status:'active',totalAreaMm2:a,perLayerAreaMm2:new Map([[li,a]]),childIds:[],maxAreaMm2:a,maxAreaLayer:li,
      centroidSumX:c?.centroidSumX??0,centroidSumY:c?.centroidSumY??0,centroidSumZ:c?c.size*li:0,centroidCount:c?c.size:0,
      lastLayerCentroid:c&&c.size>0?{x:c.centroidSumX/c.size,y:c.centroidSumY/c.size,z:li}:undefined});return id;}
  private updateIsland(id:number,li:number,a:number,c?:ComponentInfo):void{const isl=this.islands.get(id);if(!isl)return;
    isl.lastLayer=li;isl.totalAreaMm2+=a;isl.perLayerAreaMm2.set(li,a);if(!isl.maxAreaMm2||a>isl.maxAreaMm2){isl.maxAreaMm2=a;isl.maxAreaLayer=li;}
    if(c){isl.centroidSumX+=c.centroidSumX;isl.centroidSumY+=c.centroidSumY;isl.centroidSumZ+=c.size*li;isl.centroidCount+=c.size;
      if(c.size>0)isl.lastLayerCentroid={x:c.centroidSumX/c.size,y:c.centroidSumY/c.size,z:li};}}
  private mergeIslands(li:number,ids:Set<number>,pil:RleLabels,a:number,c?:ComponentInfo):number{
    const pre:RleLabels={width:pil.width,height:pil.height,rows:pil.rows.map(r=>new Int32Array(r))};
    for(const id of ids){const isl=this.islands.get(id);if(isl){isl.status='complete';isl.lastLayer=li-1;}}
    const mid=this.createIsland(li,a,c);const mi=this.islands.get(mid)!;mi.isMergedPlaceholder=true;
    const oc=new Map<number,number>();for(const id of ids)oc.set(id,0);
    this.pendingMerges.push({mergeLayer:li,candidateIds:Array.from(ids),mergedIslandId:mid,overlapCounts:oc,preMergeLabels:pre});return mid;}
  private evalMerges(cl:number):void{const tf:number[]=[];
    for(let i=0;i<this.pendingMerges.length;i++){const p=this.pendingMerges[i];
      if(cl-p.mergeLayer>=this.MERGE_EVAL_WINDOW){let pid=0,mx=-1;
        for(const[id,cnt]of p.overlapCounts)if(cnt>mx){mx=cnt;pid=id;}
        for(const cid of p.candidateIds)if(cid!==pid){const ch=this.islands.get(cid);if(ch)ch.parentId=pid;}
        const mi=this.islands.get(p.mergedIslandId);if(mi)mi.parentId=pid;
        const par=this.islands.get(pid);if(par&&mi){
          for(const cid of p.candidateIds)if(cid!==pid&&!par.childIds.includes(cid))par.childIds.push(cid);
          if(!par.childIds.includes(p.mergedIslandId))par.childIds.push(p.mergedIslandId);
          par.lastLayer=mi.lastLayer;par.status=mi.status;
          for(const[l,a]of mi.perLayerAreaMm2){par.perLayerAreaMm2.set(l,a);par.totalAreaMm2+=a;if(!par.maxAreaMm2||a>par.maxAreaMm2){par.maxAreaMm2=a;par.maxAreaLayer=l;}}
          if(mi.centroidCount>0){par.centroidSumX+=mi.centroidSumX;par.centroidSumY+=mi.centroidSumY;par.centroidSumZ+=mi.centroidSumZ;par.centroidCount+=mi.centroidCount;}
          if(mi.lastLayerCentroid)par.lastLayerCentroid={...mi.lastLayerCentroid};}tf.push(i);}}
    for(let i=tf.length-1;i>=0;i--)this.pendingMerges.splice(tf[i],1);}
  getIslands():Island[]{const islands=Array.from(this.islands.values());
    for(const isl of islands)if(isl.centroidCount>0)isl.centroid={x:isl.centroidSumX/isl.centroidCount,y:isl.centroidSumY/isl.centroidCount,z:isl.centroidSumZ/isl.centroidCount};
    return islands;}
}

// ── Rasterizer (same coord convention as Rust shared module) ──
type Triangle = { ax:number;ay:number;az:number; bx:number;by:number;bz:number; cx:number;cy:number;cz:number; dirX:number;dirY:number; zMin:number;zMax:number };
type Segment = { x1:number; y1:number; dxDy:number; yMin:number; yMax:number; wind:number };

function parseTriangles(buf: Buffer): Triangle[] {
  const count = buf.length / (9 * 4); // 9 f32 per triangle
  const tris: Triangle[] = [];
  for (let i = 0; i < count; i++) {
    const off = i * 36;
    const ax=buf.readFloatLE(off),ay=buf.readFloatLE(off+4),az=buf.readFloatLE(off+8);
    const bx=buf.readFloatLE(off+12),by=buf.readFloatLE(off+16),bz=buf.readFloatLE(off+20);
    const cx=buf.readFloatLE(off+24),cy=buf.readFloatLE(off+28),cz=buf.readFloatLE(off+32);
    const ux=bx-ax,uy=by-ay,uz=bz-az,vx=cx-ax,vy=cy-ay,vz=cz-az;
    const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz;
    tris.push({ax,ay,az,bx,by,bz,cx,cy,cz,dirX:ny,dirY:-nx,zMin:Math.min(az,bz,cz),zMax:Math.max(az,bz,cz)});
  }
  return tris;
}

function buildSegments(tris: Triangle[], z: number, originX: number, originY: number, pxMm: number): Segment[] {
  const segs: Segment[] = [];
  for (const tri of tris) {
    if (z < tri.zMin || z > tri.zMax) continue;
    const pts: [number,number][] = [];
    for (const [a,b] of [
      [{x:tri.ax,y:tri.ay,z:tri.az},{x:tri.bx,y:tri.by,z:tri.bz}],
      [{x:tri.bx,y:tri.by,z:tri.bz},{x:tri.cx,y:tri.cy,z:tri.cz}],
      [{x:tri.cx,y:tri.cy,z:tri.cz},{x:tri.ax,y:tri.ay,z:tri.az}],
    ]) {
      const dz1=a.z-z,dz2=b.z-z;
      if(!((dz1<=0&&dz2>0)||(dz2<=0&&dz1>0)))continue;
      const denom=b.z-a.z;if(Math.abs(denom)<1e-8)continue;
      const t=(z-a.z)/denom;
      const ix=a.x+(b.x-a.x)*t,iy=a.y+(b.y-a.y)*t;
      if(!pts.some(p=>Math.abs(ix-p[0])<=1e-5&&Math.abs(iy-p[1])<=1e-5)&&pts.length<3) pts.push([ix,iy]);
    }
    if(pts.length<2)continue;
    let[p0,p1]=[pts[0],pts[1]];
    if(Math.abs(tri.dirX)>1e-10||Math.abs(tri.dirY)>1e-10){
      if((p1[0]-p0[0])*tri.dirX+(p1[1]-p0[1])*tri.dirY<0)[p0,p1]=[p1,p0];
    }
    const x1=(p0[0]-originX)/pxMm,y1=(-p0[1]-originY)/pxMm;
    const x2=(p1[0]-originX)/pxMm,y2=(-p1[1]-originY)/pxMm;
    const dy=y2-y1;if(Math.abs(dy)<1e-8)continue;
    segs.push({x1,y1,dxDy:(x2-x1)/dy,yMin:Math.min(y1,y2),yMax:Math.max(y1,y2),wind:dy>0?1:-1});
  }
  return segs;
}

function rasterizeLayer(segs: Segment[], w: number, h: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const py = y + 0.5;
    const crossings: [number,number][] = [];
    for (const s of segs) { if (py<s.yMin||py>=s.yMax) continue; crossings.push([s.x1+(py-s.y1)*s.dxDy,s.wind]); }
    crossings.sort((a,b)=>a[0]-b[0]);
    let winding=0,ci=0;const ro=y*w;
    for(let x=0;x<w;x++){const px=x+0.5;while(ci<crossings.length&&crossings[ci][0]<=px){winding+=crossings[ci][1];ci++;}if(winding!==0)mask[ro+x]=1;}
  }
  return mask;
}

// ── Main ──
const dumpDir = process.argv[2] || '/tmp/dragonfruit-island-debug';

console.log('Island IPC Debug — TypeScript reproduction');
console.log('==========================================\n');
console.log(`Dump dir: ${dumpDir}\n`);

const paramsJson = fs.readFileSync(path.join(dumpDir, 'params.json'), 'utf8');
const params = JSON.parse(paramsJson);
const posBuf = fs.readFileSync(path.join(dumpDir, 'positions.bin'));
const triangles = parseTriangles(posBuf);

console.log('Params:');
console.log(`  px_mm: ${params.px_mm}`);
console.log(`  support_buffer_mm: ${params.support_buffer_mm}`);
console.log(`  connectivity: ${params.connectivity}`);
console.log(`  min_island_area_mm2: ${params.min_island_area_mm2}`);
console.log(`  min_overlap_px: ${params.min_overlap_px}`);
console.log(`  overlap_neighborhood_px: ${params.overlap_neighborhood_px}`);
console.log(`  layer_height_mm: ${params.layer_height_mm}`);
console.log(`  bbox: (${params.bbox_min_x.toFixed(4)}, ${params.bbox_min_y.toFixed(4)}, ${params.bbox_min_z.toFixed(4)}) - (${params.bbox_max_x.toFixed(4)}, ${params.bbox_max_y.toFixed(4)}, ${params.bbox_max_z.toFixed(4)})`);
console.log(`  triangles: ${triangles.length}\n`);

// Match Rust rasterize_for_island_scan exactly
const originX = params.bbox_min_x;
const originY = -params.bbox_max_y; // mask Y = -world Y
const gridWidth = Math.ceil((params.bbox_max_x - params.bbox_min_x) / params.px_mm);
const gridHeight = Math.ceil((params.bbox_max_y - params.bbox_min_y) / params.px_mm);
const modelHeight = params.bbox_max_z - params.bbox_min_z;
const numLayers = Math.ceil(modelHeight / params.layer_height_mm);

console.log('Rasterizing...');
const t0 = performance.now();
const masks: RleMask[] = [];
const layerPx: number[] = [];
for (let l = 0; l < numLayers; l++) {
  const z = params.bbox_min_z + (l + 1) * params.layer_height_mm + 1e-6;
  const segs = buildSegments(triangles, z, originX, originY, params.px_mm);
  const dense = rasterizeLayer(segs, gridWidth, gridHeight);
  const mask = rleEncode(dense, gridWidth, gridHeight);
  masks.push(mask);
  layerPx.push(rlePixelCount(mask));
}
const rasterMs = performance.now() - t0;
const totalPx = layerPx.reduce((a,b)=>a+b, 0);

console.log(`  Grid: ${gridWidth}x${gridHeight}`);
console.log(`  Layers: ${numLayers}`);
console.log(`  Origin: (${originX.toFixed(6)}, ${originY.toFixed(6)})`);
console.log(`  Total solid pixels: ${totalPx}`);
console.log(`  Rasterize: ${rasterMs.toFixed(1)}ms`);

for (let i = 0; i < Math.min(3, numLayers); i++) console.log(`  Layer ${i}: ${layerPx[i]} px`);
for (let i = Math.max(0, numLayers-3); i < numLayers; i++) console.log(`  Layer ${i}: ${layerPx[i]} px`);

// Island scan
console.log('\nRunning island scan...');
const opts = { px_mm: params.px_mm, support_buffer_mm: params.support_buffer_mm, connectivity: (params.connectivity || 4) as 4|8 };

const lrs: ReturnType<typeof scanLayer>[] = [];
for (let i = 0; i < numLayers; i++) lrs.push(scanLayer(masks[i], i > 0 ? masks[i-1] : null, opts));

const tracker = new IslandTracker(params.px_mm, {
  minOverlapPx: params.min_overlap_px || 1,
  overlapNeighborhoodPx: params.overlap_neighborhood_px || 1,
});
const ilpl: RleLabels[] = [];
for (let l = 0; l < numLayers; l++) {
  const il = tracker.processLayer(l, lrs[l].labels, lrs[l].components, l > 0 ? ilpl[l-1] : null, lrs[l].solidMask);
  ilpl.push(il);
}
const islands = tracker.getIslands();
for (const isl of islands) { let v=0; for (const a of isl.perLayerAreaMm2.values()) v+=a*params.layer_height_mm; isl.volumeMm3=v; }
const filtered = islands.filter(i => !i.isMergedPlaceholder && (i.maxAreaMm2??0) >= (params.min_island_area_mm2 || 0));

console.log(`  Islands (all): ${islands.length}`);
console.log(`  Islands (filtered): ${filtered.length}`);

// Write debug output
const outDir = path.join(dumpDir, 'ts-debug');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'summary.txt'),
  `triangles: ${triangles.length}\ngrid: ${gridWidth}x${gridHeight}\nlayers: ${numLayers}\nsolid_px: ${totalPx}\nislands: ${filtered.length}\nparams: ${paramsJson.trim()}\n`);
fs.writeFileSync(path.join(outDir, 'layer_pixels.txt'), layerPx.map((px,i) => `${i}: ${px}`).join('\n'));

console.log(`\nDebug output: ${outDir}`);
console.log('\nTo compare: diff', path.join(dumpDir, 'rust-debug/layer_pixels.txt'), path.join(dumpDir, 'ts-debug/layer_pixels.txt'));

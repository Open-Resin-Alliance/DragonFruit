import * as THREE from 'three';
import {
  DragonfruitImportFormat,
  Branch,
  Joint,
  Knot,
  Segment,
  Vec3,
} from '../../../supports/types';
import type { SupportBraceBuildResult } from '../../../supports/SupportTypes/SupportBrace/types';
import { getFinalSocketPosition } from '../../../supports/SupportPrimitives/ContactCone';
import { findClosestSegment } from '../../../supports/SupportPrimitives/Joint/jointUtils';
import {
  calculateKnotPositionOnSegmentFromT,
} from '../../../supports/SupportPrimitives/Knot/knotUtils';
import {
  HostEntry,
  LycheeObject,
  LycheeSupport,
  LycheeSupportSettings,
  LycheeVector,
} from './types';

export function extractParentIds(s: any): string[] {
  const candidate = s?.parentId ?? s?.parentIds ?? s?.parents ?? s?.parent ?? s?.hostId ?? s?.hostIds;
  if (Array.isArray(candidate)) {
    return candidate
      .map((v) => (typeof v === 'string' ? v : String(v ?? '')))
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }

  if (typeof candidate === 'string') {
    const v = candidate.trim();
    return v.length > 0 ? [v] : [];
  }

  if (typeof candidate === 'number') {
    return [String(candidate)];
  }

  return [];
}

export function inferParentIds(s: any): string[] {
  const explicit = extractParentIds(s);
  if (explicit.length > 0) return explicit;

  const inferred: string[] = [];
  const parentBaseId = typeof s?.parentBaseId === 'string' ? s.parentBaseId.trim() : '';
  const parentTipId = typeof s?.parentTipId === 'string' ? s.parentTipId.trim() : '';

  if (parentBaseId.length > 0) inferred.push(parentBaseId);
  if (parentTipId.length > 0 && !inferred.includes(parentTipId)) inferred.push(parentTipId);

  return inferred;
}

export function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function isMiniSupport(s: LycheeSupport): boolean {
  return isTruthyFlag((s as any)?.mini);
}

export function pickContactTipSettings(s: LycheeSupport): LycheeSupportSettings['tip'] | LycheeSupportSettings['baseTip'] | undefined {
  return s.settings?.tip ?? s.settings?.baseTip;
}

export function inferLeafTipEndpoint(
  tipPoint: THREE.Vector3,
  basePoint: THREE.Vector3,
  sourceTipPoint: THREE.Vector3,
): 'base' | 'tip' {
  const distToBaseSq = tipPoint.distanceToSquared(basePoint);
  const distToTipSq = tipPoint.distanceToSquared(sourceTipPoint);
  return distToTipSq <= distToBaseSq ? 'tip' : 'base';
}

export function pickLeafEndpointDiameter(
  s: LycheeSupport,
  endpoint: 'base' | 'tip',
  fallback: number,
): number {
  const endpointSettings = endpoint === 'tip' ? s.settings?.tip : s.settings?.baseTip;
  const pointDiameter = endpointSettings?.pointDiameter;
  if (Number.isFinite(pointDiameter as number) && (pointDiameter as number) > 0) {
    return pointDiameter as number;
  }

  const bodyDiameter = endpointSettings?.diameter;
  if (Number.isFinite(bodyDiameter as number) && (bodyDiameter as number) > 0) {
    return bodyDiameter as number;
  }

  if (endpoint === 'base') {
    const joinDiameter = s.settings?.base?.joinDiameter;
    if (Number.isFinite(joinDiameter as number) && (joinDiameter as number) > 0) {
      return joinDiameter as number;
    }
  }

  return fallback;
}

export function hasValidNormal(v?: LycheeVector): boolean {
  if (!v) return false;
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return false;
  return (v.x * v.x + v.y * v.y + v.z * v.z) > 1e-8;
}

function getSupportEndpointDistanceMm(s: LycheeSupport): number | null {
  if (!s.base || !s.tip) return null;
  const dx = s.tip.x - s.base.x;
  const dy = s.tip.y - s.base.y;
  const dz = s.tip.z - s.base.z;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return Number.isFinite(length) ? length : null;
}

export function isTwigCandidate(
  s: LycheeSupport,
  parentIds: string[],
  stickVsTwigCutoffMm: number,
): boolean {
  if (parentIds.length !== 0) return false;

  const supportType = (s as any)?.type;
  if (Number.isFinite(supportType) && supportType !== 1) return false;

  if (!hasValidNormal(s.baseNormal) || !hasValidNormal(s.tipNormal)) {
    return false;
  }

  const baseZ = s.base?.z;
  if (!Number.isFinite(baseZ) || Math.abs(baseZ) <= 0.2) {
    return false;
  }

  if (!Number.isFinite(stickVsTwigCutoffMm) || stickVsTwigCutoffMm <= 0) {
    return false;
  }

  const endpointDistance = getSupportEndpointDistanceMm(s);
  if (!Number.isFinite(endpointDistance as number)) {
    return false;
  }

  return (endpointDistance as number) <= stickVsTwigCutoffMm + 1e-6;
}

export function isStickCandidate(
  s: LycheeSupport,
  parentIds: string[],
  stickVsTwigCutoffMm?: number,
): boolean {
  if (parentIds.length !== 0) return false;
  if (isMiniSupport(s)) return false;

  const supportType = (s as any)?.type;
  if (Number.isFinite(supportType) && supportType !== 1) return false;

  if (!hasValidNormal(s.baseNormal) || !hasValidNormal(s.tipNormal)) {
    return false;
  }

  const baseZ = s.base?.z;
  if (!Number.isFinite(baseZ) || Math.abs(baseZ) <= 0.2) {
    return false;
  }

  if (Number.isFinite(stickVsTwigCutoffMm as number) && (stickVsTwigCutoffMm as number) > 0) {
    const endpointDistance = getSupportEndpointDistanceMm(s);
    if (Number.isFinite(endpointDistance as number) && (endpointDistance as number) <= (stickVsTwigCutoffMm as number) + 1e-6) {
      return false;
    }
  }

  return true;
}

export function pickStickEndpointTipSettings(
  s: LycheeSupport,
  endpoint: 'base' | 'tip',
): LycheeSupportSettings['tip'] | LycheeSupportSettings['baseTip'] | undefined {
  if (endpoint === 'base') {
    return s.settings?.baseTip ?? s.settings?.tip;
  }
  return s.settings?.tip ?? s.settings?.baseTip;
}

export function pickFallbackObjectId(objects: Record<string, LycheeObject>): string | null {
  if (objects['o15']) return 'o15';

  for (const [objectId, objectData] of Object.entries(objects)) {
    if (Array.isArray(objectData.supportsBase) && objectData.supportsBase.length > 0) {
      return objectId;
    }
  }

  const firstObjectId = Object.keys(objects)[0];
  return firstObjectId || null;
}

export function normalizeObjectId(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

export function resolveSupportOwnerId(
  supportId: string,
  support: LycheeSupport,
  objects: Record<string, LycheeObject>,
  fallbackObjectId: string,
): string {
  const tipObjectIdRaw = normalizeObjectId(support.objectIdTip);
  const baseObjectIdRaw = normalizeObjectId(support.objectIdBase);

  const tipObjectExists = !!(tipObjectIdRaw && objects[tipObjectIdRaw]);
  const baseObjectExists = !!(baseObjectIdRaw && objects[baseObjectIdRaw]);

  if (tipObjectExists && baseObjectExists && tipObjectIdRaw !== baseObjectIdRaw) {
    console.warn(
      `[LysConverter] Support ${supportId} has mixed ownership (tip=${tipObjectIdRaw}, base=${baseObjectIdRaw}). Using objectIdTip.`
    );
  }

  if (tipObjectExists && tipObjectIdRaw) return tipObjectIdRaw;
  if (baseObjectExists && baseObjectIdRaw) return baseObjectIdRaw;

  if ((tipObjectIdRaw && !tipObjectExists) || (baseObjectIdRaw && !baseObjectExists)) {
    console.warn(
      `[LysConverter] Support ${supportId} references unknown object ownership (tip=${String(tipObjectIdRaw)}, base=${String(baseObjectIdRaw)}). Falling back to ${fallbackObjectId}.`
    );
  }

  return fallbackObjectId;
}

export function applyWorldXYPlacementToSlice(
  data: DragonfruitImportFormat & { supportBraces?: SupportBraceBuildResult[] },
  start: { roots: number; trunks: number; branches: number; leaves: number; twigs: number; sticks: number; knots: number; supportBraces: number },
  offsetX: number,
  offsetY: number,
): void {
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return;
  if (Math.abs(offsetX) < 1e-8 && Math.abs(offsetY) < 1e-8) return;

  const shiftedJointIds = new Set<string>();

  const shiftPos = (pos?: { x: number; y: number }) => {
    if (!pos) return;
    pos.x += offsetX;
    pos.y += offsetY;
  };

  const shiftJoint = (joint?: Joint) => {
    if (!joint?.pos) return;
    if (shiftedJointIds.has(joint.id)) return;
    joint.pos.x += offsetX;
    joint.pos.y += offsetY;
    shiftedJointIds.add(joint.id);
  };

  for (let i = start.roots; i < data.roots.length; i++) {
    shiftPos(data.roots[i].transform?.pos);
  }

  for (let i = start.trunks; i < data.trunks.length; i++) {
    const trunk = data.trunks[i];
    for (const seg of trunk.segments) {
      shiftJoint(seg.bottomJoint);
      shiftJoint(seg.topJoint);
      if (seg.type === 'bezier') {
        shiftPos(seg.controlPoint1 as { x: number; y: number } | undefined);
        shiftPos(seg.controlPoint2 as { x: number; y: number } | undefined);
      }
    }
    shiftPos(trunk.contactCone?.pos);
  }

  for (let i = start.branches; i < data.branches.length; i++) {
    const branch = data.branches[i];
    for (const seg of branch.segments) {
      shiftJoint(seg.bottomJoint);
      shiftJoint(seg.topJoint);
      if (seg.type === 'bezier') {
        shiftPos(seg.controlPoint1 as { x: number; y: number } | undefined);
        shiftPos(seg.controlPoint2 as { x: number; y: number } | undefined);
      }
    }
    shiftPos(branch.contactCone?.pos);
  }

  for (let i = start.leaves; i < data.leaves.length; i++) {
    shiftPos(data.leaves[i].contactCone?.pos);
  }

  for (let i = start.twigs; i < (data.twigs?.length || 0); i++) {
    const twig = data.twigs![i];
    for (const seg of twig.segments) {
      shiftJoint(seg.bottomJoint);
      shiftJoint(seg.topJoint);
      if (seg.type === 'bezier') {
        shiftPos(seg.controlPoint1 as { x: number; y: number } | undefined);
        shiftPos(seg.controlPoint2 as { x: number; y: number } | undefined);
      }
    }
    shiftPos(twig.contactDiskA?.pos);
    shiftPos(twig.contactDiskB?.pos);
  }

  for (let i = start.sticks; i < (data.sticks?.length || 0); i++) {
    const stick = data.sticks![i];
    for (const seg of stick.segments) {
      shiftJoint(seg.bottomJoint);
      shiftJoint(seg.topJoint);
      if (seg.type === 'bezier') {
        shiftPos(seg.controlPoint1 as { x: number; y: number } | undefined);
        shiftPos(seg.controlPoint2 as { x: number; y: number } | undefined);
      }
    }
    shiftPos(stick.contactConeA?.pos);
    shiftPos(stick.contactConeB?.pos);
  }

  for (let i = start.knots; i < data.knots.length; i++) {
    shiftPos(data.knots[i].pos);
  }

  for (let i = start.supportBraces; i < (data.supportBraces?.length || 0); i++) {
    const build = data.supportBraces![i];

    shiftPos(build.root?.transform?.pos);
    shiftPos(build.hostKnot?.pos);

    for (const seg of build.supportBrace?.segments || []) {
      shiftJoint(seg.bottomJoint);
      shiftJoint(seg.topJoint);
      if (seg.type === 'bezier') {
        shiftPos(seg.controlPoint1 as { x: number; y: number } | undefined);
        shiftPos(seg.controlPoint2 as { x: number; y: number } | undefined);
      }
    }
  }
}

export function projectPointToBranch(
  branch: Branch,
  parentKnot: Knot,
  point: THREE.Vector3
): { t: number; pointOnLine: Vec3; segmentId: string } | null {
  let currentStart = new THREE.Vector3(parentKnot.pos.x, parentKnot.pos.y, parentKnot.pos.z);

  let minDist = Infinity;
  let bestT = 0;
  const bestPoint = new THREE.Vector3();
  let bestSegmentId: string | null = null;

  for (const seg of branch.segments) {
    let endPoint: THREE.Vector3;

    if (seg.topJoint) {
      endPoint = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
    } else if (branch.contactCone) {
      const socketPos = getFinalSocketPosition(branch.contactCone);
      endPoint = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
    } else {
      endPoint = currentStart.clone().add(new THREE.Vector3(0, 0, 5));
    }

    const line = new THREE.Line3(currentStart, endPoint);
    const closest = new THREE.Vector3();
    line.closestPointToPoint(point, true, closest);

    const dist = point.distanceTo(closest);
    const segLen = currentStart.distanceTo(endPoint);
    const t = segLen > 0.000001 ? currentStart.distanceTo(closest) / segLen : 0;

    if (dist < minDist) {
      minDist = dist;
      bestT = t;
      bestPoint.copy(closest);
      bestSegmentId = seg.id;
    }

    currentStart = endPoint;
  }

  if (!Number.isFinite(minDist) || !bestSegmentId) return null;

  return {
    t: bestT,
    pointOnLine: { x: bestPoint.x, y: bestPoint.y, z: bestPoint.z },
    segmentId: bestSegmentId,
  };
}

function projectPointToSupportBraceHost(
  host: Extract<HostEntry, { kind: 'supportBrace' }>,
  point: THREE.Vector3
): { t: number; pointOnLine: Vec3; segmentId: string } | null {
  const rootTopZ = host.root.transform.pos.z + host.root.diskHeight + host.root.coneHeight;
  let currentStart = new THREE.Vector3(host.root.transform.pos.x, host.root.transform.pos.y, rootTopZ);

  let minDist = Infinity;
  let bestT = 0;
  const bestPoint = new THREE.Vector3();
  let bestSegmentId: string | null = null;

  const hostKnotPos = new THREE.Vector3(host.hostKnot.pos.x, host.hostKnot.pos.y, host.hostKnot.pos.z);

  for (const seg of host.supportBrace.segments) {
    const endPoint = seg.topJoint
      ? new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z)
      : hostKnotPos;

    const line = new THREE.Line3(currentStart, endPoint);
    const closest = new THREE.Vector3();
    line.closestPointToPoint(point, true, closest);

    const dist = point.distanceTo(closest);
    const segLen = currentStart.distanceTo(endPoint);
    const t = segLen > 0.000001 ? currentStart.distanceTo(closest) / segLen : 0;

    if (dist < minDist) {
      minDist = dist;
      bestT = t;
      bestPoint.copy(closest);
      bestSegmentId = seg.id;
    }

    currentStart = endPoint;
  }

  if (!Number.isFinite(minDist) || !bestSegmentId) return null;

  return {
    t: bestT,
    pointOnLine: { x: bestPoint.x, y: bestPoint.y, z: bestPoint.z },
    segmentId: bestSegmentId,
  };
}

export function projectPointToHost(host: HostEntry, point: THREE.Vector3): { t: number; pointOnLine: Vec3; parentShaftId: string } | null {
  if (host.kind === 'trunk') {
    const projection = findClosestSegment(host.trunk, host.root, { x: point.x, y: point.y, z: point.z });
    if (!projection) return null;
    return {
      t: projection.t,
      pointOnLine: projection.pointOnLine,
      parentShaftId: projection.segment.id,
    };
  }

  if (host.kind === 'branch') {
    const projection = projectPointToBranch(host.branch, host.parentKnot, point);
    if (!projection) return null;

    return {
      t: projection.t,
      pointOnLine: projection.pointOnLine,
      parentShaftId: projection.segmentId,
    };
  }

  const projection = projectPointToSupportBraceHost(host, point);
  if (!projection) return null;

  return {
    t: projection.t,
    pointOnLine: projection.pointOnLine,
    parentShaftId: projection.segmentId,
  };
}

function projectPointToSegment(
  segment: Segment,
  start: Vec3,
  end: Vec3,
  point: THREE.Vector3,
): { t: number; pointOnLine: Vec3 } {
  const pointVec = new THREE.Vector3(point.x, point.y, point.z);

  let t = 0;
  if (segment.type !== 'bezier') {
    const startVec = new THREE.Vector3(start.x, start.y, start.z);
    const endVec = new THREE.Vector3(end.x, end.y, end.z);
    const segVec = endVec.clone().sub(startVec);
    const segLenSq = segVec.lengthSq();
    if (segLenSq > 1e-8) {
      t = THREE.MathUtils.clamp(pointVec.clone().sub(startVec).dot(segVec) / segLenSq, 0, 1);
    }
  } else {
    let bestT = 0;
    let bestDistSq = Number.POSITIVE_INFINITY;
    const samples = 64;
    for (let i = 0; i <= samples; i++) {
      const sampleT = i / samples;
      const samplePos = calculateKnotPositionOnSegmentFromT(start, end, segment, sampleT);
      const dx = samplePos.x - pointVec.x;
      const dy = samplePos.y - pointVec.y;
      const dz = samplePos.z - pointVec.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestT = sampleT;
      }
    }
    t = bestT;
  }

  const pointOnLine = calculateKnotPositionOnSegmentFromT(start, end, segment, t);
  return { t, pointOnLine };
}

function projectPointToHostPreferredSide(
  host: HostEntry,
  point: THREE.Vector3,
  preferredSide: 'base' | 'tip',
): { t: number; pointOnLine: Vec3; parentShaftId: string } | null {
  if (host.kind === 'trunk') {
    const segments = host.trunk.segments;
    if (segments.length === 0) return null;

    const targetIndex = preferredSide === 'base' ? 0 : segments.length - 1;
    const segment = segments[targetIndex];
    if (!segment) return null;

    const rootTop: Vec3 = {
      x: host.root.transform.pos.x,
      y: host.root.transform.pos.y,
      z: host.root.transform.pos.z + host.root.diskHeight + host.root.coneHeight,
    };

    const prevSegment = targetIndex > 0 ? segments[targetIndex - 1] : null;
    const prevEnd = prevSegment?.topJoint?.pos
      ?? (host.trunk.contactCone ? getFinalSocketPosition(host.trunk.contactCone) : rootTop);

    const start: Vec3 = targetIndex === 0 ? rootTop : { x: prevEnd.x, y: prevEnd.y, z: prevEnd.z };
    const endPos = segment.topJoint?.pos
      ?? (host.trunk.contactCone ? getFinalSocketPosition(host.trunk.contactCone) : start);
    const end: Vec3 = { x: endPos.x, y: endPos.y, z: endPos.z };

    const projected = projectPointToSegment(segment, start, end, point);
    return { ...projected, parentShaftId: segment.id };
  }

  if (host.kind === 'branch') {
    const segments = host.branch.segments;
    if (segments.length === 0) return null;

    const targetIndex = preferredSide === 'base' ? 0 : segments.length - 1;
    const segment = segments[targetIndex];
    if (!segment) return null;

    const prevSegment = targetIndex > 0 ? segments[targetIndex - 1] : null;
    const prevEnd = prevSegment?.topJoint?.pos
      ?? (host.branch.contactCone ? getFinalSocketPosition(host.branch.contactCone) : host.parentKnot.pos);

    const start: Vec3 = targetIndex === 0
      ? { x: host.parentKnot.pos.x, y: host.parentKnot.pos.y, z: host.parentKnot.pos.z }
      : { x: prevEnd.x, y: prevEnd.y, z: prevEnd.z };

    const endPos = segment.topJoint?.pos
      ?? (host.branch.contactCone ? getFinalSocketPosition(host.branch.contactCone) : start);
    const end: Vec3 = { x: endPos.x, y: endPos.y, z: endPos.z };

    const projected = projectPointToSegment(segment, start, end, point);
    return { ...projected, parentShaftId: segment.id };
  }

  const segments = host.supportBrace.segments;
  if (segments.length === 0) return null;

  const targetIndex = preferredSide === 'base' ? 0 : segments.length - 1;
  const segment = segments[targetIndex];
  if (!segment) return null;

  const rootTop: Vec3 = {
    x: host.root.transform.pos.x,
    y: host.root.transform.pos.y,
    z: host.root.transform.pos.z + host.root.diskHeight + host.root.coneHeight,
  };

  const prevSegment = targetIndex > 0 ? segments[targetIndex - 1] : null;
  const prevEnd = prevSegment?.topJoint?.pos ?? host.hostKnot.pos;

  const start: Vec3 = targetIndex === 0
    ? rootTop
    : { x: prevEnd.x, y: prevEnd.y, z: prevEnd.z };

  const endPos = segment.topJoint?.pos ?? host.hostKnot.pos;
  const end: Vec3 = { x: endPos.x, y: endPos.y, z: endPos.z };

  const projected = projectPointToSegment(segment, start, end, point);
  return { ...projected, parentShaftId: segment.id };
}

export function pickAttachAndTipForSingleParent(
  host: HostEntry,
  pA: THREE.Vector3,
  pB: THREE.Vector3,
): {
  attachProjection: { t: number; pointOnLine: Vec3; parentShaftId: string };
  attachPoint: THREE.Vector3;
  tipPoint: THREE.Vector3;
  usedExplicitParentHint: boolean;
} | null {
  const projA = projectPointToHost(host, pA);
  const projB = projectPointToHost(host, pB);

  if (!projA && !projB) return null;

  const distA = projA
    ? pA.distanceTo(new THREE.Vector3(projA.pointOnLine.x, projA.pointOnLine.y, projA.pointOnLine.z))
    : Number.POSITIVE_INFINITY;
  const distB = projB
    ? pB.distanceTo(new THREE.Vector3(projB.pointOnLine.x, projB.pointOnLine.y, projB.pointOnLine.z))
    : Number.POSITIVE_INFINITY;

  if (distA <= distB && projA) {
    return { attachProjection: projA, attachPoint: pA, tipPoint: pB, usedExplicitParentHint: false };
  }

  if (projB) {
    return { attachProjection: projB, attachPoint: pB, tipPoint: pA, usedExplicitParentHint: false };
  }

  return null;
}

export function pickAttachAndTipFromParentHints(
  s: LycheeSupport,
  parentId: string,
  host: HostEntry,
  pA: THREE.Vector3,
  pB: THREE.Vector3,
): {
  attachProjection: { t: number; pointOnLine: Vec3; parentShaftId: string };
  attachPoint: THREE.Vector3;
  tipPoint: THREE.Vector3;
  usedExplicitParentHint: boolean;
} | null {
  const parentBaseId = typeof s.parentBaseId === 'string' ? s.parentBaseId : null;
  const parentTipId = typeof s.parentTipId === 'string' ? s.parentTipId : null;

  if (parentBaseId === parentId && parentTipId !== parentId) {
    const proj = projectPointToHostPreferredSide(host, pA, 'base') ?? projectPointToHost(host, pA);
    if (proj) return { attachProjection: proj, attachPoint: pA, tipPoint: pB, usedExplicitParentHint: true };
  }

  if (parentTipId === parentId && parentBaseId !== parentId) {
    const proj = projectPointToHostPreferredSide(host, pB, 'tip') ?? projectPointToHost(host, pB);
    if (proj) return { attachProjection: proj, attachPoint: pB, tipPoint: pA, usedExplicitParentHint: true };
  }

  return pickAttachAndTipForSingleParent(host, pA, pB);
}

export function pickBracePairing(
  hostA: HostEntry,
  hostB: HostEntry,
  pA: THREE.Vector3,
  pB: THREE.Vector3,
): {
  projA: { t: number; pointOnLine: Vec3; parentShaftId: string };
  projB: { t: number; pointOnLine: Vec3; parentShaftId: string };
} | null {
  const directA = projectPointToHost(hostA, pA);
  const directB = projectPointToHost(hostB, pB);

  const swappedA = projectPointToHost(hostA, pB);
  const swappedB = projectPointToHost(hostB, pA);

  const directError = (directA && directB)
    ? pA.distanceTo(new THREE.Vector3(directA.pointOnLine.x, directA.pointOnLine.y, directA.pointOnLine.z))
      + pB.distanceTo(new THREE.Vector3(directB.pointOnLine.x, directB.pointOnLine.y, directB.pointOnLine.z))
    : Number.POSITIVE_INFINITY;

  const swappedError = (swappedA && swappedB)
    ? pB.distanceTo(new THREE.Vector3(swappedA.pointOnLine.x, swappedA.pointOnLine.y, swappedA.pointOnLine.z))
      + pA.distanceTo(new THREE.Vector3(swappedB.pointOnLine.x, swappedB.pointOnLine.y, swappedB.pointOnLine.z))
    : Number.POSITIVE_INFINITY;

  if (!Number.isFinite(directError) && !Number.isFinite(swappedError)) {
    return null;
  }

  if (directError <= swappedError && directA && directB) {
    return { projA: directA, projB: directB };
  }

  if (swappedA && swappedB) {
    return { projA: swappedA, projB: swappedB };
  }

  return null;
}

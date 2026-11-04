/**
 * Resin volume of the supports and the raft, for the resin estimate shown before
 * slicing. The model's own volume is estimated separately in the background; this
 * adds what the support state and raft settings would print on top of it.
 *
 * Pure over its inputs, so it runs the same in the app and in tests.
 */

import * as THREE from 'three';
import { contactEndpointsFor, SUPPORT_TYPES, type SupportCollectionKey, type SupportTypeId } from '@/supports/supportTypeRegistry';
import { resolveSegmentEndpoints, type ShaftEntity } from '@/supports/SupportPrimitives/Knot/segmentEndpoints';
import { computeRaftFootprintPolygons, raftBandTopMm } from '@/supports/Rafts/Crenelated/geometry/computeRaftFootprint';
import { collectModelPlateFootprint, type PlateFootprintSource } from '@/supports/Rafts/Crenelated/geometry/modelPlateFootprint';
import { isUntrimmedFootprint } from '@/supports/Rafts/Crenelated/geometry/generateRaftFromFootprint';
import { polygonSetAreaMm2 } from '@/supports/Rafts/Crenelated/geometry/polygonSet2d';
import { computeRaftOuterBoundary } from '@/supports/Rafts/Crenelated/geometry/computeRaftOuterBoundary';
import type { RaftSettings, SupportBaseCircle } from '@/supports/Rafts/Crenelated/RaftTypes';
import { calculateDiskThickness } from '@/supports/SupportPrimitives/ContactDisk/contactDiskUtils';
import { getBezierPointAtT } from '@/supports/Curves/BezierUtils';
import type { Segment, SupportCollections } from '@/supports/types';

export interface SupportAndRaftResinInput {
  supportState: SupportCollections;
  raftSettings: RaftSettings;
  /** Models whose supports and raft count (visible and inside the build volume). */
  visibleModelIds: ReadonlySet<string>;
  /** Visible models on the plate; the raft is trimmed where they stand. */
  plateModels: readonly PlateFootprintSource[];
}

/** Support plus raft resin in ml; 0 when nothing in `visibleModelIds` has supports. */
export function computeSupportAndRaftResinMl({
  supportState,
  raftSettings,
  visibleModelIds,
  plateModels,
}: SupportAndRaftResinInput): number {
  if (visibleModelIds.size === 0) return 0;

  const mm3ToMl = (mm3: number) => Math.max(0, mm3) / 1000;
  const circleArea = (radiusMm: number) => Math.PI * radiusMm * radiusMm;
  const sphereVolumeMm3 = (radiusMm: number) => (4 / 3) * Math.PI * radiusMm * radiusMm * radiusMm;
  const cylinderVolumeMm3 = (radiusMm: number, heightMm: number) => circleArea(radiusMm) * Math.max(0, heightMm);
  const frustumVolumeMm3 = (r1: number, r2: number, heightMm: number) => {
    const h = Math.max(0, heightMm);
    return (Math.PI * h / 3) * ((r1 * r1) + (r1 * r2) + (r2 * r2));
  };
  const distanceMm = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));
  };
  const sampleBezierLengthMm = (
    p0: { x: number; y: number; z: number },
    p1: { x: number; y: number; z: number },
    p2: { x: number; y: number; z: number },
    p3: { x: number; y: number; z: number },
    samples: number,
  ) => {
    let length = 0;
    let prev = p0;
    const steps = Math.max(4, samples);
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const next = getBezierPointAtT(p0, p1, p2, p3, t);
      length += distanceMm(prev, next);
      prev = next;
    }
    return length;
  };

  const contactConeVolumeMl = (cone: {
    profile: {
      contactDiameterMm: number;
      bodyDiameterMm: number;
      lengthMm: number;
      type?: 'disk' | 'sphere';
    };
    normal: { x: number; y: number; z: number };
    surfaceNormal?: { x: number; y: number; z: number };
    diskLengthOverride?: number;
  }) => {
    const contactRadius = Math.max(0.001, cone.profile.contactDiameterMm / 2);
    const bodyRadius = Math.max(0.001, cone.profile.bodyDiameterMm / 2);
    const coneLen = Math.max(0, cone.profile.lengthMm);
    const coneMm3 = frustumVolumeMm3(contactRadius, bodyRadius, coneLen);

    let diskMm3 = 0;
    if (cone.profile.type === 'disk') {
      const surfaceNormal = cone.surfaceNormal ?? cone.normal;
      const diskProfile = {
        type: 'disk' as const,
        diskThicknessMm: Math.max(0.01, Number((cone.profile as { diskThicknessMm?: number }).diskThicknessMm ?? 0.1)),
        maxStandoffMm: Math.max(0.01, Number((cone.profile as { maxStandoffMm?: number }).maxStandoffMm ?? 0.35)),
        standoffAngleThreshold: Number((cone.profile as { standoffAngleThreshold?: number }).standoffAngleThreshold ?? (Math.PI / 4)),
      };
      const diskThickness = cone.diskLengthOverride ?? calculateDiskThickness(surfaceNormal, cone.normal, diskProfile);
      diskMm3 = cylinderVolumeMm3(contactRadius, Math.max(0, diskThickness));
    }

    return mm3ToMl(coneMm3 + diskMm3);
  };

  const contactDiskVolumeMl = (disk: {
    contactDiameterMm: number;
    profile: {
      type?: 'disk';
      standoffAngleThreshold?: number;
      diskThicknessMm?: number;
      maxStandoffMm?: number;
    };
    surfaceNormal: { x: number; y: number; z: number };
    coneAxis: { x: number; y: number; z: number };
    diskLengthOverride?: number;
  }) => {
    const radius = Math.max(0.001, disk.contactDiameterMm / 2);
    const diskProfile = {
      type: 'disk' as const,
      diskThicknessMm: Math.max(0.01, Number(disk.profile.diskThicknessMm ?? 0.1)),
      maxStandoffMm: Math.max(0.01, Number(disk.profile.maxStandoffMm ?? 0.35)),
      standoffAngleThreshold: Number(disk.profile.standoffAngleThreshold ?? (Math.PI / 4)),
    };
    const thickness = disk.diskLengthOverride ?? calculateDiskThickness(disk.surfaceNormal, disk.coneAxis, diskProfile);
    return mm3ToMl(cylinderVolumeMm3(radius, Math.max(0, thickness)));
  };

  const segmentVolumeMl = (
    segment: {
      diameter: number;
      type?: 'straight' | 'bezier';
      controlPoint1?: { x: number; y: number; z: number };
      controlPoint2?: { x: number; y: number; z: number };
      resolution?: number;
    },
    start: { x: number; y: number; z: number },
    end: { x: number; y: number; z: number },
  ) => {
    const radius = Math.max(0.001, segment.diameter / 2);
    const length = segment.type === 'bezier' && segment.controlPoint1 && segment.controlPoint2
      ? sampleBezierLengthMm(start, segment.controlPoint1, segment.controlPoint2, end, segment.resolution ?? 16)
      : distanceMm(start, end);
    return mm3ToMl(cylinderVolumeMm3(radius, length));
  };

  const polygonAreaMm2 = (profile: THREE.Vector2[]) => {
    if (profile.length < 3) return 0;
    let sum = 0;
    for (let i = 0; i < profile.length; i += 1) {
      const a = profile[i];
      const b = profile[(i + 1) % profile.length];
      sum += (a.x * b.y) - (b.x * a.y);
    }
    return Math.abs(sum) * 0.5;
  };
  const polygonPerimeterMm = (profile: THREE.Vector2[]) => {
    if (profile.length < 2) return 0;
    let sum = 0;
    for (let i = 0; i < profile.length; i += 1) {
      const a = profile[i];
      const b = profile[(i + 1) % profile.length];
      sum += a.distanceTo(b);
    }
    return sum;
  };

  const topDiameterByRootId = new Map<string, number>();
  for (const trunk of Object.values(supportState.trunks)) {
    const firstDiameter = trunk.baseDiameterMm ?? trunk.segments[0]?.diameter;
    if (firstDiameter && firstDiameter > 0) {
      topDiameterByRootId.set(trunk.rootId, firstDiameter);
    }
  }
  for (const kickstand of Object.values(supportState.kickstands)) {
    const firstDiameter = kickstand.profile.terminalStartDiameterMm
      || kickstand.segments[0]?.diameter
      || kickstand.profile.bodyDiameterMm;
    if (firstDiameter && firstDiameter > 0) {
      topDiameterByRootId.set(kickstand.rootId, firstDiameter);
    }
  }

  let supportMl = 0;

  const addRootVolume = (root: { id: string; modelId: string; diameter: number; diskHeight: number; coneHeight: number }) => {
    if (!visibleModelIds.has(root.modelId)) return;

    const rootRadius = Math.max(0.001, root.diameter / 2);
    const topDiameter = topDiameterByRootId.get(root.id) ?? Math.max(0.1, root.diameter * 0.35);
    const topRadius = Math.max(0.001, topDiameter / 2);

    const effectiveDiskHeight = Math.max(0, root.diskHeight);
    const coneHeight = Math.max(0, root.coneHeight);

    const diskMm3 = cylinderVolumeMm3(rootRadius, effectiveDiskHeight);
    const coneMm3 = frustumVolumeMm3(rootRadius, topRadius, coneHeight);
    const capSphereMm3 = coneHeight > 0 ? sphereVolumeMm3(topRadius) : 0;
    supportMl += mm3ToMl(diskMm3 + coneMm3 + capSphereMm3);
  };

  // One pass: kickstand roots are a view of state.roots, so walking both
  // counted every kickstand root twice.
  for (const root of Object.values(supportState.roots)) {
    addRootVolume(root);
  }

  // Every type with segments or contacts, by its declared segments and
  // contacts. A brace has neither (its shaft is a curve between two knots),
  // so the guard below skips it and it is summed on its own below.
  for (const descriptor of SUPPORT_TYPES) {
    if (!descriptor.hasSegments && descriptor.contactFields.length === 0) continue;

    const collection = supportState[descriptor.location.key as SupportCollectionKey] as unknown as Record<string, {
      id: string; typeId?: SupportTypeId; modelId: string; segments?: Segment[]; rootId?: string; parentKnotId?: string; hostKnotId?: string;
    }>;

    for (const entity of Object.values(collection ?? {})) {
      if (!visibleModelIds.has(entity.modelId)) continue;

      const hosts = {
        root: descriptor.ownsRoot ? supportState.roots[entity.rootId ?? ''] : undefined,
        hostKnot: supportState.knots[entity.parentKnotId ?? entity.hostKnotId ?? ''],
      };

      const segments = entity.segments ?? [];
      for (let i = 0; i < segments.length; i += 1) {
        const endpoints = resolveSegmentEndpoints(entity as ShaftEntity, segments[i], i, hosts);
        if (!endpoints) continue;
        supportMl += segmentVolumeMl(segments[i], endpoints.start, endpoints.end);
      }

      for (const { kind, field } of contactEndpointsFor(descriptor.id)) {
        const contact = (entity as unknown as Record<string, unknown>)[field];
        if (!contact) continue;
        supportMl += kind === 'disk'
          ? contactDiskVolumeMl(contact as Parameters<typeof contactDiskVolumeMl>[0])
          : contactConeVolumeMl(contact as Parameters<typeof contactConeVolumeMl>[0]);
      }
    }
  }

  for (const brace of Object.values(supportState.braces)) {
    if (!visibleModelIds.has(brace.modelId)) continue;
    const startKnot = supportState.knots[brace.startKnotId];
    const endKnot = supportState.knots[brace.endKnotId];
    if (!startKnot || !endKnot) continue;

    const length = brace.curve?.type === 'bezier'
      ? sampleBezierLengthMm(startKnot.pos, brace.curve.controlPoint1, brace.curve.controlPoint2, endKnot.pos, brace.curve.resolution ?? 16)
      : distanceMm(startKnot.pos, endKnot.pos);
    supportMl += mm3ToMl(cylinderVolumeMm3(Math.max(0.001, brace.profile.diameter / 2), length));
  }

  let raftMl = 0;
  if (raftSettings.bottomMode !== 'off') {
    const rootsByModel = new Map<string, SupportBaseCircle[]>();
    for (const root of Object.values(supportState.roots)) {
      if (!visibleModelIds.has(root.modelId)) continue;
      if (!rootsByModel.has(root.modelId)) rootsByModel.set(root.modelId, []);
      rootsByModel.get(root.modelId)!.push({
        x: root.transform.pos.x,
        y: root.transform.pos.y,
        r: root.diameter / 2,
      });
    }

    // The raft is trimmed where a model stands on the plate, so the estimate
    // measures the same footprint the viewport and the slicer build.
    const clearance = collectModelPlateFootprint(
      plateModels,
      raftBandTopMm(raftSettings),
    );

    for (const circles of rootsByModel.values()) {
      if (circles.length === 0) continue;

      const thickness = raftSettings.bottomMode === 'line' ? raftSettings.lineHeightMm : raftSettings.thickness;

      const footprint = computeRaftFootprintPolygons({
        circles,
        raft: raftSettings,
        clearance,
      });
      if (footprint.length === 0) continue;

      const untrimmed = isUntrimmedFootprint(footprint);
      const baseProfile = untrimmed ? footprint[0].outer : [];
      const areaMm2 = untrimmed ? polygonAreaMm2(baseProfile) : polygonSetAreaMm2(footprint);
      const perimeterMm = untrimmed
        ? polygonPerimeterMm(baseProfile)
        : footprint.reduce((total, poly) => total + polygonPerimeterMm(poly.outer), 0);

      const baseMm3 = raftSettings.bottomMode === 'line'
        ? (perimeterMm * Math.max(0, raftSettings.lineWidthMm) * Math.max(0, raftSettings.lineHeightMm))
        : (areaMm2 * Math.max(0, raftSettings.thickness));

      let wallMm3 = 0;
      if (raftSettings.wallEnabled && raftSettings.wallHeight > 0 && raftSettings.wallThickness > 0) {
        const outerProfile = untrimmed ? computeRaftOuterBoundary(baseProfile, raftSettings) : [];
        const wallPerimeterMm = untrimmed && outerProfile.length >= 3
          ? polygonPerimeterMm(outerProfile)
          : perimeterMm;
        wallMm3 = wallPerimeterMm * Math.max(0, raftSettings.wallThickness) * Math.max(0, raftSettings.wallHeight);
      }

      raftMl += mm3ToMl(baseMm3 + wallMm3);
    }
  }

  return supportMl + raftMl;
}

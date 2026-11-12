/**
 * Resin volume of the supports and the raft, for the resin estimate shown before
 * slicing. The model's own volume is estimated separately in the background; this
 * adds what the support state and raft settings would print on top of it.
 *
 * The figures mirror the geometry the slicer receives (`buildSupportAndRaftWorldTriangles`
 * in `features/slicing/rasterLayerZipExport.ts`): the same root profile, the same
 * joint spheres, the same brace diameter derived from its host knots, and — for the
 * raft — the very meshes the exporter emits, measured instead of approximated. What
 * it cannot know before a slice is the anti-aliasing tip shrink and the material's
 * tip penetration, so the cones are measured at their authored size.
 *
 * Pure over its inputs, so it runs the same in the app and in tests.
 */

import { contactEndpointsFor, SUPPORT_TYPES, type SupportCollectionKey } from '@/supports/supportTypeRegistry';
import { resolveSegmentEndpoints, type ShaftEntity } from '@/supports/SupportPrimitives/Knot/segmentEndpoints';
import { raftBandTopMm } from '@/supports/Rafts/Crenelated/geometry/computeRaftFootprint';
import { collectModelPlateFootprint, type PlateFootprintSource } from '@/supports/Rafts/Crenelated/geometry/modelPlateFootprint';
import { buildRaftMeshesForCircles } from '@/supports/Rafts/Crenelated/geometry/buildRaftMeshesForCircles';
import type { RaftSettings, SupportBaseCircle } from '@/supports/Rafts/Crenelated/RaftTypes';
import { calculateDiskThickness } from '@/supports/SupportPrimitives/ContactDisk/contactDiskUtils';
import { getBezierPointAtT } from '@/supports/Curves/BezierUtils';
import { JOINT_DIAMETER_OFFSET_MM } from '@/supports/constants';
import type { Segment, SupportCollections } from '@/supports/types';
import { geometryVolumeMm3 } from './modelResinVolume';

export interface SupportAndRaftResinInput {
  supportState: SupportCollections;
  raftSettings: RaftSettings;
  /** Models whose supports and raft count (visible and inside the build volume). */
  visibleModelIds: ReadonlySet<string>;
  /** Visible models on the plate; the raft is trimmed where they stand. */
  plateModels: readonly PlateFootprintSource[];
}

/**
 * The slice geometry shrinks every joint sphere by this much: the knot's own
 * diameter is a display size, and the sphere is emitted smaller so the shaft ends
 * do not bulge out of it.
 */
const JOINT_BLEND_MM = JOINT_DIAMETER_OFFSET_MM * 0.75;

/** Radii below this are clamped by the primitive builders, so measure the clamped size. */
const MIN_PRIMITIVE_RADIUS_MM = 0.05;

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

    // A cone whose profile carries a disk prints that disk as its socket offset,
    // so the offset volume belongs to this primitive and not to a second entity.
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

  /**
   * A contact disk prints as a cylinder plus a sphere cap at its tip, so the cap
   * belongs in its resin. The cylinder is measured at its authored thickness; the
   * material's tip penetration is an output setting the estimate cannot know.
   */
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
    return mm3ToMl(cylinderVolumeMm3(radius, Math.max(0, thickness)) + sphereVolumeMm3(radius));
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

  // One sphere per joint, however many types share it: the exporter dedupes them
  // the same way, so a joint between two supports is printed once.
  const seenJointIds = new Set<string>();
  const addJointVolumeMl = (joint: { id: string; diameter: number } | undefined | null) => {
    if (!joint || seenJointIds.has(joint.id)) return 0;
    seenJointIds.add(joint.id);
    return mm3ToMl(sphereVolumeMm3(Math.max(0.001, joint.diameter - JOINT_BLEND_MM) / 2));
  };

  // The cone's top radius comes from the shaft standing on it, not from the root's
  // own fields; without a shaft the exporter tapers it to 45 % of the root radius.
  const topRadiusByRootId = new Map<string, number>();
  const rememberRootShaft = (rootId: string, firstDiameter: number | undefined) => {
    if (typeof firstDiameter === 'number' && Number.isFinite(firstDiameter) && firstDiameter > 0) {
      topRadiusByRootId.set(rootId, Math.max(MIN_PRIMITIVE_RADIUS_MM, firstDiameter / 2));
    }
  };
  for (const trunk of Object.values(supportState.trunks)) {
    rememberRootShaft(trunk.rootId, trunk.segments[0]?.diameter);
  }
  for (const kickstand of Object.values(supportState.kickstands)) {
    rememberRootShaft(kickstand.rootId, kickstand.segments[0]?.diameter);
  }

  let supportMl = 0;

  // A root prints as a disk and a cone. There is no cap sphere: the tip is the
  // cone's top face, and counting a ball there overstated every support.
  const addRootVolume = (root: { id: string; modelId: string; diameter: number; diskHeight: number; coneHeight: number }) => {
    if (!visibleModelIds.has(root.modelId)) return;

    const rootRadius = Math.max(MIN_PRIMITIVE_RADIUS_MM, root.diameter / 2);
    const topRadius = topRadiusByRootId.get(root.id) ?? Math.max(MIN_PRIMITIVE_RADIUS_MM, rootRadius * 0.45);

    const diskMm3 = cylinderVolumeMm3(rootRadius, Math.max(0.01, root.diskHeight));
    const coneMm3 = frustumVolumeMm3(rootRadius, topRadius, Math.max(0.01, root.coneHeight));
    supportMl += mm3ToMl(diskMm3 + coneMm3);
  };

  for (const root of Object.values(supportState.roots)) {
    addRootVolume(root);
  }

  type EntityRecord = {
    modelId: string;
    segments?: Segment[];
    rootId?: string;
    parentKnotId?: string;
    hostKnotId?: string;
    rootPos?: { x: number; y: number; z: number };
    rootHeight?: number;
    rootBaseDiameter?: number;
    rootTopDiameter?: number;
    joint?: { id: string; diameter: number };
    profile?: { diameter?: number };
    curve?: {
      type?: 'straight' | 'bezier';
      controlPoint1?: { x: number; y: number; z: number };
      controlPoint2?: { x: number; y: number; z: number };
      resolution?: number;
    };
  };

  for (const descriptor of SUPPORT_TYPES) {
    const collection = supportState[descriptor.location.key as SupportCollectionKey] as unknown as
      Record<string, EntityRecord>;

    // The knot this type hangs from, when it hangs from one. The exporter resolves
    // it by the registry's declared edge, so the estimate does too.
    const knotEdges = descriptor.edges.filter((edge) => edge.to === 'knots');

    for (const entity of Object.values(collection ?? {})) {
      if (!visibleModelIds.has(entity.modelId)) continue;

      const root = descriptor.ownsRoot ? supportState.roots[entity.rootId ?? ''] ?? null : null;
      const knotAt = (position: number) => {
        const edge = knotEdges[position];
        return edge ? supportState.knots[entity[edge.field as keyof EntityRecord] as string] ?? null : null;
      };
      const hostKnot = knotAt(0);

      // An unplaced support prints nothing, which is what the exporter decides here.
      if (descriptor.lower.kind === 'plateRoot' && !root) continue;
      if (descriptor.lower.kind === 'knot' && !hostKnot) continue;

      if (descriptor.lower.kind === 'inlineRoot' && entity.rootPos) {
        const height = Math.max(0.01, entity.rootHeight ?? 0);
        const baseRadius = Math.max(MIN_PRIMITIVE_RADIUS_MM, (entity.rootBaseDiameter ?? 0) / 2);
        const topRadius = Math.max(MIN_PRIMITIVE_RADIUS_MM, (entity.rootTopDiameter ?? 0) / 2);
        supportMl += mm3ToMl(frustumVolumeMm3(baseRadius, topRadius, height));
        supportMl += addJointVolumeMl(entity.joint);
      }

      const hosts = {
        root: descriptor.ownsRoot ? supportState.roots[entity.rootId ?? ''] : undefined,
        hostKnot: supportState.knots[entity.parentKnotId ?? entity.hostKnotId ?? ''],
      };

      const segments = entity.segments ?? [];
      for (let i = 0; i < segments.length; i += 1) {
        const endpoints = resolveSegmentEndpoints(entity as unknown as ShaftEntity, segments[i], i, hosts);
        if (!endpoints) continue;
        supportMl += segmentVolumeMl(segments[i], endpoints.start, endpoints.end);
        supportMl += addJointVolumeMl(segments[i].bottomJoint);
        supportMl += addJointVolumeMl(segments[i].topJoint);
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

  // A brace's printed diameter is derived from the knots it joins, not from its
  // profile: profile.diameter is the display width.
  for (const brace of Object.values(supportState.braces)) {
    if (!visibleModelIds.has(brace.modelId)) continue;
    const startKnot = supportState.knots[brace.startKnotId];
    const endKnot = supportState.knots[brace.endKnotId];
    if (!startKnot || !endKnot) continue;

    const profileDiameter = Math.max(0.001, brace.profile?.diameter ?? 1);
    const startHostDiameter = Math.max(MIN_PRIMITIVE_RADIUS_MM, (startKnot.diameter ?? (profileDiameter + 0.1)) - 0.1);
    const endHostDiameter = Math.max(MIN_PRIMITIVE_RADIUS_MM, (endKnot.diameter ?? (profileDiameter + 0.1)) - 0.1);

    const length = brace.curve?.type === 'bezier'
      ? sampleBezierLengthMm(startKnot.pos, brace.curve.controlPoint1!, brace.curve.controlPoint2!, endKnot.pos, brace.curve.resolution ?? 16)
      : distanceMm(startKnot.pos, endKnot.pos);
    supportMl += mm3ToMl(cylinderVolumeMm3(
      Math.max(0.001, (startHostDiameter + endHostDiameter) * 0.5 / 2),
      length,
    ));
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

    let raftMm3 = 0;
    for (const circles of rootsByModel.values()) {
      if (circles.length === 0) continue;
      // The exporter's own meshes, measured: this is where the chamfer, the
      // crenelated wall and the line-mode beam network stop being approximations.
      for (const mesh of buildRaftMeshesForCircles({ circles, raft: raftSettings, clearance })) {
        raftMm3 += geometryVolumeMm3(mesh.geometry);
        mesh.geometry.dispose();
      }
    }
    raftMl = mm3ToMl(raftMm3);
  }

  return supportMl + raftMl;
}

export interface PlateAndSceneSupportResinInput {
  supportState: SupportCollections;
  raftSettings: RaftSettings;
  /** Every model that counts, on every plate: visible and inside its build volume. */
  resinModelIds: ReadonlySet<string>;
  /** The models on the plate being worked on: layer count, time and resin are its own. */
  activePlateModelIds: ReadonlySet<string>;
  /** Visible models on the active plate; the raft is trimmed where they stand. */
  activePlateModels: readonly PlateFootprintSource[];
  /** Every visible model in the scene, for the scene-wide raft clearance. */
  sceneModels: readonly PlateFootprintSource[];
}

/**
 * Support and raft resin for the plate being worked on, and for the whole scene.
 *
 * The per-plate figure intersects the two id sets itself: a plate's resin is the
 * supports and raft of the models standing on it, and a caller that handed the
 * scene-wide set to the per-plate sum made a plate report its neighbour's raft.
 */
export function computePlateAndSceneSupportResinMl({
  supportState,
  raftSettings,
  resinModelIds,
  activePlateModelIds,
  activePlateModels,
  sceneModels,
}: PlateAndSceneSupportResinInput): { activePlate: number; scene: number } {
  const activePlateResinModelIds = new Set([...resinModelIds].filter((id) => activePlateModelIds.has(id)));
  return {
    activePlate: computeSupportAndRaftResinMl({
      supportState,
      raftSettings,
      visibleModelIds: activePlateResinModelIds,
      plateModels: activePlateModels,
    }),
    scene: computeSupportAndRaftResinMl({
      supportState,
      raftSettings,
      visibleModelIds: resinModelIds,
      plateModels: sceneModels,
    }),
  };
}

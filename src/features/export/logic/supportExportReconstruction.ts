import * as THREE from 'three';
import { bezierToLineSegments } from '@/supports/Curves/BezierUtils';
import { getModelIdForSupportEntityId } from '@/supports/state';
import { exportGroupName, getSupportTypeDescriptor, SUPPORT_TYPES, type SupportTypeDescriptor, type SupportTypeId } from '@/supports/supportTypeRegistry';
import { getFinalSocketPosition } from '@/supports/SupportPrimitives/ContactCone';
import { calculateDiskThickness } from '@/supports/SupportPrimitives/ContactDisk/contactDiskUtils';
import { getRaftSettingsForModel } from '@/supports/Rafts/Crenelated/RaftState';
import type { Kickstand, KickstandBuildResult } from '@/supports/SupportTypes/Kickstand/types';
import type {
  Anchor,
  Brace,
  Branch,
  DragonfruitImportFormat,
  Knot,
  Leaf,
  Roots,
  Segment,
  Stick,
  SupportState,
  Trunk,
  Twig,
  Vec3,
} from '@/supports/types';
import { SupportGeometryGenerator } from './SupportGeometryGenerator';
import { getActiveMaterialProfile, getActivePrinterProfile } from '@/features/profiles/profileStore';
import { calculateTipOffset } from '@/supports/rendering/calculateTipOffset';

function getGlobalPenetrationMm(): number {
  const material = getActiveMaterialProfile();
  const printer = getActivePrinterProfile();
  if (material && printer) {
    const pxX = printer.pixelSize?.x ? printer.pixelSize.x / 1000 : (printer.buildVolumeMm?.width ?? 143) / (printer.display?.resolutionX ?? 2560);
    const pxY = printer.pixelSize?.y ? printer.pixelSize.y / 1000 : (printer.buildVolumeMm?.depth ?? 89) / (printer.display?.resolutionY ?? 1620);
    return calculateTipOffset(material.antiAliasingSettings, material.layerHeightMm, pxX, pxY);
  }
  return 0;
}

export interface ScopedSupportPayload {
  roots: Roots[];
  trunks: SupportState['trunks'][string][];
  branches: Branch[];
  leaves: Leaf[];
  twigs: Twig[];
  sticks: Stick[];
  braces: Brace[];
  anchors: Anchor[];
  knots: Knot[];
  kickstands: Kickstand[];
}

function hasAllowedModelId(allowedModelIds: ReadonlySet<string>, modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && allowedModelIds.has(modelId);
}

function firstAllowedModelId(
  allowedModelIds: ReadonlySet<string>,
  ...candidateIds: Array<string | null | undefined>
): string | null {
  for (const candidateId of candidateIds) {
    if (hasAllowedModelId(allowedModelIds, candidateId)) {
      return candidateId!;
    }
  }

  return null;
}

/** Resolves an entity id to its owning modelId. */
type ModelIdResolver = (id: string | null | undefined) => string | null;

/**
 * An O(1) `entityId -> modelId` resolver, backed by reverse indices built once
 * rather than scanning the graph per call. Index order mirrors
 * {@link getModelIdForSupportEntityId} so ambiguous ids resolve the same way.
 */
function createScopedModelIdResolver(
  supportState: SupportState,
): ModelIdResolver {
  // Ids reachable in the canonical resolver only via linear scans: segment and
  // joint ids, brace start/end knots, and kickstand host knots + segments.
  const scanModelId = new Map<string, string | null>();
  const registerScan = (id: string | null | undefined, modelId: string | null): void => {
    if (id && !scanModelId.has(id)) scanModelId.set(id, modelId);
  };
  const registerSegments = (segments: Segment[], modelId: string | null): void => {
    for (const segment of segments) {
      registerScan(segment.id, modelId);
      registerScan(segment.topJoint?.id, modelId);
      registerScan(segment.bottomJoint?.id, modelId);
    }
  };

  // Every type's shafts and the knots it hangs from, by declaration.
  for (const descriptor of SUPPORT_TYPES) {
    const collection = supportState[descriptor.location.key] as unknown as Record<string, Record<string, unknown>>;

    for (const entity of Object.values(collection ?? {})) {
      const modelId = (entity.modelId as string | undefined) ?? null;

      if (descriptor.hasSegments) {
        registerSegments(entity.segments as Segment[], modelId);
      }
      for (const edge of descriptor.edges) {
        if (edge.to !== 'knots' || edge.ownership !== 'hostedBy') continue;
        const knotId = entity[edge.field];
        if (typeof knotId === 'string') registerScan(knotId, modelId);
      }
    }
  }

  // Knot fallbacks: a knot inherits from a branch/leaf that names it as parent.
  const branchByParentKnot = new Map<string, string | null>();
  for (const branch of Object.values(supportState.branches)) {
    if (!branchByParentKnot.has(branch.parentKnotId)) branchByParentKnot.set(branch.parentKnotId, branch.modelId ?? null);
  }
  const leafByParentKnot = new Map<string, string | null>();
  for (const leaf of Object.values(supportState.leaves)) {
    if (!leafByParentKnot.has(leaf.parentKnotId)) leafByParentKnot.set(leaf.parentKnotId, leaf.modelId ?? null);
  }

  const resolve: ModelIdResolver = (id) => {
    if (!id) return null;

    if (id.startsWith('braceSegment:')) {
      return supportState.braces[id.slice('braceSegment:'.length)]?.modelId ?? null;
    }

    if (supportState.roots[id]) return supportState.roots[id].modelId ?? null;
    for (const descriptor of SUPPORT_TYPES) {
      const entity = (supportState[descriptor.location.key] as unknown as Record<string, { modelId?: string }>)[id];
      if (entity) return entity.modelId ?? null;
    }

    if (scanModelId.has(id)) return scanModelId.get(id) ?? null;

    const knot = supportState.knots[id];
    if (knot) {
      if (knot.parentShaftId) {
        const byParent = resolve(knot.parentShaftId);
        if (byParent) return byParent;
      }
      if (branchByParentKnot.has(id)) return branchByParentKnot.get(id) ?? null;
      if (leafByParentKnot.has(id)) return leafByParentKnot.get(id) ?? null;
    }

    return null;
  };

  return resolve;
}

function resolveBranchModelId(branch: Branch, allowedModelIds: ReadonlySet<string>, resolveModelId: ModelIdResolver): string | null {
  return firstAllowedModelId(
    allowedModelIds,
    branch.modelId,
    resolveModelId(branch.parentKnotId),
  );
}

function resolveLeafModelId(leaf: Leaf, allowedModelIds: ReadonlySet<string>, resolveModelId: ModelIdResolver): string | null {
  return firstAllowedModelId(
    allowedModelIds,
    leaf.modelId,
    resolveModelId(leaf.parentKnotId),
  );
}

function resolveBraceModelId(brace: Brace, allowedModelIds: ReadonlySet<string>, resolveModelId: ModelIdResolver): string | null {
  return firstAllowedModelId(
    allowedModelIds,
    brace.modelId,
    resolveModelId(brace.startKnotId),
    resolveModelId(brace.endKnotId),
  );
}

function resolveKickstandModelId(kickstand: Kickstand, allowedModelIds: ReadonlySet<string>, resolveModelId: ModelIdResolver): string | null {
  return firstAllowedModelId(
    allowedModelIds,
    kickstand.modelId,
    resolveModelId(kickstand.rootId),
    resolveModelId(kickstand.hostKnotId),
    resolveModelId(kickstand.hostSegmentId),
  );
}

function buildTwigDiskTipCenter(disk: Twig['contactDiskA']): Vec3 {
  const thickness = disk.diskLengthOverride ?? calculateDiskThickness(disk.surfaceNormal, disk.coneAxis, disk.profile);
  return {
    x: disk.pos.x + (disk.surfaceNormal.x * thickness),
    y: disk.pos.y + (disk.surfaceNormal.y * thickness),
    z: disk.pos.z + (disk.surfaceNormal.z * thickness),
  };
}

function addModelMetadata(object: THREE.Object3D, modelId: string | null | undefined) {
  object.userData = {
    ...object.userData,
    modelId: modelId ?? null,
  };
}

function appendConeGeometry(group: THREE.Group, cone: Leaf['contactCone']) {
  const pen = getGlobalPenetrationMm();
  const coneGroup = SupportGeometryGenerator.generateConeMesh(cone, pen);
  group.add(coneGroup);

  const diskGroup = SupportGeometryGenerator.generateContactDiskMesh(cone, pen);
  if (diskGroup.children.length > 0) {
    group.add(diskGroup);
  }
}

function appendStraightOrBezierShafts(
  group: THREE.Group,
  segment: Segment,
  start: Vec3,
  end: Vec3,
) {
  const meshes = SupportGeometryGenerator.generateSegmentShaftMeshes(
    segment,
    new THREE.Vector3(start.x, start.y, start.z),
    new THREE.Vector3(end.x, end.y, end.z),
  );
  for (const mesh of meshes) {
    group.add(mesh);
  }
}

/**
 * Build one type's export groups, each paired with the id of the entity it was
 * built from. Each closes over its own row type, so the table can be indexed by
 * type id without widening the rows to a union. A null group skips that entity:
 * a broken link drops one support rather than failing the export.
 *
 * The caller names each group from the registry, so no builder spells out its
 * own `Trunk_` / `Kickstand_` prefix.
 */
type BuiltGroup = { id: string; group: THREE.Group | null };
type GroupBuilder = () => readonly BuiltGroup[];

function buildTrunkGroup(trunk: Trunk, root: Roots, modelId: string | null | undefined): THREE.Group {
  const group = SupportGeometryGenerator.generateSupportGroup(
    {
      id: trunk.id,
      roots: root,
      segments: trunk.segments,
      contactCone: trunk.contactCone,
    },
    modelId ? getRaftSettingsForModel(modelId) : undefined,
  );
  addModelMetadata(group, modelId);
  return group;
}

function buildBranchGroup(branch: Branch, parentKnot: Knot, modelId: string | null | undefined): THREE.Group {
  const group = SupportGeometryGenerator.generateSupportGroup({
    id: branch.id,
    startPos: parentKnot.pos,
    segments: branch.segments,
    contactCone: branch.contactCone,
  });
  addModelMetadata(group, modelId);
  return group;
}

function buildAnchorGroup(anchor: Anchor, modelId: string | null | undefined): THREE.Group {
  const group = new THREE.Group();
  addModelMetadata(group, modelId);

  const rootHeight = Math.max(0.001, anchor.rootHeight);
  const rootMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(
      Math.max(0.001, anchor.rootTopDiameter / 2),
      Math.max(0.001, anchor.rootBaseDiameter / 2),
      rootHeight,
      20,
    ),
  );
  rootMesh.position.set(anchor.rootPos.x, anchor.rootPos.y, anchor.rootPos.z + (rootHeight / 2));
  rootMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1));
  group.add(rootMesh);

  group.add(SupportGeometryGenerator.generateJointMesh(anchor.joint));

  let currentStart: Vec3 = anchor.joint.pos;
  anchor.segments.forEach((segment) => {
    const end = segment.topJoint
      ? segment.topJoint.pos
      : anchor.contactCone
        ? getFinalSocketPosition(anchor.contactCone)
        : currentStart;

    appendStraightOrBezierShafts(group, segment, currentStart, end);

    if (segment.topJoint) {
      group.add(SupportGeometryGenerator.generateJointMesh(segment.topJoint));
    }

    currentStart = end;
  });

  appendConeGeometry(group, anchor.contactCone);
  return group;
}

function buildBraceGroup(
  brace: Brace,
  startKnot: Knot,
  endKnot: Knot,
  modelId: string | null | undefined,
): THREE.Group {
  const group = new THREE.Group();
  addModelMetadata(group, modelId);

  const diameter = Math.max(
    0.001,
    brace.profile?.diameter
      ?? Math.max(
        0.001,
        ((startKnot.diameter ?? 1.2) + (endKnot.diameter ?? 1.2)) * 0.5,
      ),
  );

  if (brace.curve?.type === 'bezier') {
    const points = bezierToLineSegments(
      startKnot.pos,
      brace.curve.controlPoint1,
      brace.curve.controlPoint2,
      endKnot.pos,
      brace.curve.resolution,
    );
    for (let i = 0; i < points.length - 1; i += 1) {
      const shaft = SupportGeometryGenerator.generateShaftMesh(
        new THREE.Vector3(points[i].x, points[i].y, points[i].z),
        new THREE.Vector3(points[i + 1].x, points[i + 1].y, points[i + 1].z),
        diameter,
      );
      if (shaft) group.add(shaft);
    }
    return group;
  }

  const shaft = SupportGeometryGenerator.generateShaftMesh(
    new THREE.Vector3(startKnot.pos.x, startKnot.pos.y, startKnot.pos.z),
    new THREE.Vector3(endKnot.pos.x, endKnot.pos.y, endKnot.pos.z),
    diameter,
  );
  if (shaft) group.add(shaft);

  return group;
}

function buildLeafGroup(leaf: Leaf, modelId: string | null | undefined): THREE.Group {
  const group = new THREE.Group();
  addModelMetadata(group, modelId);
  appendConeGeometry(group, leaf.contactCone);
  return group;
}

function buildStickGroup(stick: Stick, modelId: string | null | undefined): THREE.Group {
  const startPos = getFinalSocketPosition(stick.contactConeA);
  const group = SupportGeometryGenerator.generateSupportGroup(
    {
      id: stick.id,
      startPos,
      segments: stick.segments,
      contactCone: stick.contactConeB,
    },
  );
  addModelMetadata(group, modelId);
  appendConeGeometry(group, stick.contactConeA);
  return group;
}

function buildTwigGroup(twig: Twig, modelId: string | null | undefined): THREE.Group {
  const startPos = buildTwigDiskTipCenter(twig.contactDiskA);
  const endPos = buildTwigDiskTipCenter(twig.contactDiskB);
  const group = new THREE.Group();
  addModelMetadata(group, modelId);

  const seenJointIds = new Set<string>();
  let currentStart = startPos;

  twig.segments.forEach((segment, index) => {
    if (segment.bottomJoint && !seenJointIds.has(segment.bottomJoint.id)) {
      seenJointIds.add(segment.bottomJoint.id);
      group.add(SupportGeometryGenerator.generateJointMesh(segment.bottomJoint));
    }

    const isLast = index === twig.segments.length - 1;
    const end = segment.topJoint
      ? segment.topJoint.pos
      : isLast
        ? endPos
        : currentStart;

    appendStraightOrBezierShafts(group, segment, segment.bottomJoint?.pos ?? currentStart, end);

    if (segment.topJoint && !seenJointIds.has(segment.topJoint.id)) {
      seenJointIds.add(segment.topJoint.id);
      group.add(SupportGeometryGenerator.generateJointMesh(segment.topJoint));
    }

    currentStart = end;
  });

  const pen = getGlobalPenetrationMm();
  const diskA = SupportGeometryGenerator.generateContactDiskMesh({
    pos: twig.contactDiskA.pos,
    normal: twig.contactDiskA.coneAxis,
    surfaceNormal: twig.contactDiskA.surfaceNormal,
    diskLengthOverride: twig.contactDiskA.diskLengthOverride,
    profile: twig.contactDiskA.profile,
    contactDiameterMm: twig.contactDiskA.contactDiameterMm,
  }, pen);
  const diskB = SupportGeometryGenerator.generateContactDiskMesh({
    pos: twig.contactDiskB.pos,
    normal: twig.contactDiskB.coneAxis,
    surfaceNormal: twig.contactDiskB.surfaceNormal,
    diskLengthOverride: twig.contactDiskB.diskLengthOverride,
    profile: twig.contactDiskB.profile,
    contactDiameterMm: twig.contactDiskB.contactDiameterMm,
  }, pen);
  if (diskA.children.length > 0) group.add(diskA);
  if (diskB.children.length > 0) group.add(diskB);
  return group;
}

function buildKickstandGroup(
  kickstand: Kickstand,
  root: Roots,
  hostKnot: Knot,
  modelId: string | null | undefined,
): THREE.Group {
  const group = new THREE.Group();
  addModelMetadata(group, modelId);

  const raftSettings = modelId ? getRaftSettingsForModel(modelId) : undefined;
  const rootGroup = SupportGeometryGenerator.generateRootsMesh(
    root,
    kickstand.segments[0]?.diameter ?? kickstand.profile.bodyDiameterMm,
    raftSettings,
  );
  group.add(rootGroup);

  const effectiveDiskHeight = Math.max(0.001, root.diskHeight);
  const verticalOffset = 0;
  let currentStart: Vec3 = {
    x: root.transform.pos.x,
    y: root.transform.pos.y,
    z: root.transform.pos.z + verticalOffset + effectiveDiskHeight + Math.max(0, root.coneHeight),
  };

  kickstand.segments.forEach((segment, index) => {
    const isLast = index === kickstand.segments.length - 1;
    const end = segment.topJoint
      ? segment.topJoint.pos
      : isLast
        ? hostKnot.pos
        : currentStart;

    appendStraightOrBezierShafts(group, segment, currentStart, end);

    if (segment.topJoint) {
      group.add(SupportGeometryGenerator.generateJointMesh(segment.topJoint));
    }

    currentStart = end;
  });

  return group;
}

export function extractScopedSupportPayload(
  supportState: SupportState,
  modelIds: Iterable<string>,
): ScopedSupportPayload {
  const allowedModelIds = new Set(Array.from(modelIds).filter((modelId) => modelId.trim().length > 0));

  // Reverse-indexed resolver: O(1) per lookup after an O(N) build, versus the
  // canonical getModelIdForSupportEntityId which linear-scans the whole graph
  // per call. Called once per branch/leaf/brace/kickstand/knot below, so the
  // linear-scan form made this O(N²) — the multi-second autosave freeze.
  const resolveModelId = createScopedModelIdResolver(supportState);

  /**
   * Whether an entity belongs to a requested model.
   *
   * Its own `modelId` first, then the ids it links through -- a branch borrows
   * its parent knot's model, a kickstand its root's, its host knot's or its
   * host segment's. Those fall-backs are the type's declared `edges`, in
   * declared order. `roots` is excluded: following it would pull in a trunk
   * whose root carries a model the trunk does not.
   */
  const belongsToScope = (descriptor: SupportTypeDescriptor, entity: Record<string, unknown>): boolean => {
    const linked = descriptor.edges
      .filter((edge) => edge.to !== 'roots')
      .map((edge) => {
        const linkedId = entity[edge.field];
        return typeof linkedId === 'string' ? resolveModelId(linkedId) : null;
      });

    return firstAllowedModelId(
      allowedModelIds,
      entity.modelId as string | undefined,
      ...linked,
    ) !== null;
  };

  const scoped = <T>(typeId: SupportTypeId): T[] => {
    const descriptor = getSupportTypeDescriptor(typeId);
    const collection = (supportState as unknown as Record<string, unknown>)[descriptor.location.key] as Record<string, Record<string, unknown>> | undefined;
    return Object.values(collection ?? {}).filter((entity) => belongsToScope(descriptor, entity)) as T[];
  };

  const roots = Object.values(supportState.roots)
    .filter((item) => hasAllowedModelId(allowedModelIds, item.modelId));
  const trunks = scoped<Trunk>('trunk');
  const branches = scoped<Branch>('branch');
  const leaves = scoped<Leaf>('leaf');
  const twigs = scoped<Twig>('twig');
  const sticks = scoped<Stick>('stick');
  const braces = scoped<Brace>('brace');
  const anchors = scoped<Anchor>('anchor');
  const kickstands = scoped<Kickstand>('kickstand');

  /** The same scoped lists, by type id, for the declaration-driven walks below. */
  const scopedEntities: Record<SupportTypeId, unknown[]> = {
    trunk: trunks, branch: branches, leaf: leaves, twig: twigs,
    stick: sticks, brace: braces, anchor: anchors, kickstand: kickstands,
  };

  /** Every scoped entity, with the descriptor that says what it is. */
  const scopedByType: Array<{ descriptor: SupportTypeDescriptor; entities: Record<string, unknown>[] }> =
    SUPPORT_TYPES.map((descriptor) => ({
      descriptor,
      entities: scopedEntities[descriptor.id] as unknown as Record<string, unknown>[],
    }));

  // Shafts carried by the scope: real segments, or a prefixed id for a type
  // that has none.
  const includedSegmentIds = new Set<string>();
  for (const { descriptor, entities } of scopedByType) {
    for (const entity of entities) {
      if (descriptor.segmentSelectionPrefix) {
        includedSegmentIds.add(`${descriptor.segmentSelectionPrefix}${entity.id as string}`);
        continue;
      }
      for (const segment of (entity.segments as Segment[] | undefined) ?? []) {
        includedSegmentIds.add(segment.id);
      }
    }
  }

  // Knots the scope hangs from, by declared `hostedBy knots` edges.
  const referencedKnotIds = new Set<string>();
  for (const { descriptor, entities } of scopedByType) {
    const knotFields = descriptor.edges
      .filter((edge) => edge.to === 'knots' && edge.ownership === 'hostedBy')
      .map((edge) => edge.field);
    if (knotFields.length === 0) continue;

    for (const entity of entities) {
      for (const field of knotFields) {
        const knotId = entity[field];
        if (typeof knotId === 'string') referencedKnotIds.add(knotId);
      }
    }
  }

  const leafIds = new Set(leaves.map((item) => item.id));
  const braceIds = new Set(braces.map((item) => item.id));

  const knots = Object.values(supportState.knots)
    .filter((item) => {
      if (referencedKnotIds.has(item.id)) return true;
      if (includedSegmentIds.has(item.parentShaftId)) return true;
      if (item.parentShaftId.startsWith('leafCone:')) {
        return leafIds.has(item.parentShaftId.slice('leafCone:'.length));
      }
      if (item.parentShaftId.startsWith('braceSegment:')) {
        return braceIds.has(item.parentShaftId.slice('braceSegment:'.length));
      }
      return hasAllowedModelId(allowedModelIds, resolveModelId(item.id));
    });

  return {
    roots,
    trunks,
    branches,
    leaves,
    twigs,
    sticks,
    braces,
    anchors,
    knots,
    kickstands,
  };
}

export function buildScopedSupportExportDocument(
  supportState: SupportState,
  modelIds: Iterable<string>,
  source = 'dragonfruit-voxl',
): DragonfruitImportFormat {
  const payload = extractScopedSupportPayload(supportState, modelIds);
  // A kickstand serialises as a bundle (`serialisedAsBundle`), so the document
  // nests its root and host knot rather than referencing them by id.
  const rootsById = new Map(payload.roots.map((item) => [item.id, item]));
  const knotsById = new Map(payload.knots.map((item) => [item.id, item]));

  const kickstandBuilds: KickstandBuildResult[] = payload.kickstands
    .map((kickstand) => {
      const root = rootsById.get(kickstand.rootId);
      const hostKnot = knotsById.get(kickstand.hostKnotId);
      if (!root || !hostKnot) return null;
      return { root, hostKnot, kickstand };
    })
    .filter((item): item is KickstandBuildResult => item !== null);

  return {
    version: 1,
    meta: {
      source,
      objectCenter: { x: 0, y: 0, z: 0 },
      updatedAt: Date.now(),
    },
    roots: payload.roots,
    trunks: payload.trunks,
    branches: payload.branches,
    leaves: payload.leaves,
    twigs: payload.twigs,
    sticks: payload.sticks,
    braces: payload.braces,
    anchors: payload.anchors,
    knots: payload.knots,
    kickstands: kickstandBuilds,
  };
}

export function buildScopedSupportGeometryGroup(
  supportState: SupportState,
  modelIds: Iterable<string>,
): THREE.Group {
  const payload = extractScopedSupportPayload(supportState, modelIds);
  const group = new THREE.Group();
  group.name = 'ScopedSupportExport';

  const rootsById = supportState.roots;
  const knotsById = supportState.knots;

  /** One builder per type, over the rows the payload carries for it. */
  const groupBuilders: Record<SupportTypeId, GroupBuilder> = {
    trunk: () => payload.trunks.map((trunk) => {
      const root = rootsById[trunk.rootId];
      if (!root) return { id: trunk.id, group: null };
      return { id: trunk.id, group: buildTrunkGroup(trunk, root, trunk.modelId ?? root.modelId ?? null) };
    }),
    branch: () => payload.branches.map((branch) => {
      const parentKnot = knotsById[branch.parentKnotId];
      if (!parentKnot) return { id: branch.id, group: null };
      const modelId = branch.modelId ?? getModelIdForSupportEntityId(branch.parentKnotId);
      return { id: branch.id, group: buildBranchGroup(branch, parentKnot, modelId) };
    }),
    leaf: () => payload.leaves.map((leaf) => ({
      id: leaf.id,
      group: buildLeafGroup(leaf, leaf.modelId ?? getModelIdForSupportEntityId(leaf.parentKnotId)),
    })),
    twig: () => payload.twigs.map((twig) => ({ id: twig.id, group: buildTwigGroup(twig, twig.modelId) })),
    stick: () => payload.sticks.map((stick) => ({ id: stick.id, group: buildStickGroup(stick, stick.modelId) })),
    brace: () => payload.braces.map((brace) => {
      const startKnot = knotsById[brace.startKnotId];
      const endKnot = knotsById[brace.endKnotId];
      if (!startKnot || !endKnot) return { id: brace.id, group: null };
      const modelId = brace.modelId
        ?? getModelIdForSupportEntityId(brace.startKnotId)
        ?? getModelIdForSupportEntityId(brace.endKnotId);
      return { id: brace.id, group: buildBraceGroup(brace, startKnot, endKnot, modelId) };
    }),
    anchor: () => payload.anchors.map((anchor) => ({
      id: anchor.id,
      group: buildAnchorGroup(anchor, anchor.modelId),
    })),
    kickstand: () => payload.kickstands.map((kickstand) => {
      const root = supportState.roots[kickstand.rootId];
      const hostKnot = supportState.knots[kickstand.hostKnotId];
      if (!root || !hostKnot) return { id: kickstand.id, group: null };
      const modelId = kickstand.modelId
        ?? root.modelId
        ?? getModelIdForSupportEntityId(kickstand.hostKnotId)
        ?? getModelIdForSupportEntityId(kickstand.hostSegmentId);
      return { id: kickstand.id, group: buildKickstandGroup(kickstand, root, hostKnot, modelId) };
    }),
  };

  // Registry order, so the exported group is stable as types are added.
  for (const descriptor of SUPPORT_TYPES) {
    for (const built of groupBuilders[descriptor.id]()) {
      if (!built.group) continue;
      built.group.name = exportGroupName(descriptor.id, built.id);
      group.add(built.group);
    }
  }

  group.updateMatrixWorld(true);
  return group;
}

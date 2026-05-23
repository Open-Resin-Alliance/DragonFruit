import * as THREE from 'three';
import { bezierToLineSegments } from '@/supports/Curves/BezierUtils';
import { getModelIdForSupportEntityId } from '@/supports/state';
import { getFinalSocketPosition } from '@/supports/SupportPrimitives/ContactCone';
import { calculateDiskThickness } from '@/supports/SupportPrimitives/ContactDisk/contactDiskUtils';
import { getRaftSettingsForModel } from '@/supports/Rafts/Crenelated/RaftState';
import type { Kickstand, KickstandBuildResult, KickstandState } from '@/supports/SupportTypes/Kickstand/types';
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
  Twig,
  Vec3,
} from '@/supports/types';
import { SupportGeometryGenerator } from './SupportGeometryGenerator';

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
  kickstandRoots: Roots[];
  kickstandKnots: Knot[];
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

function resolveBranchModelId(branch: Branch, allowedModelIds: ReadonlySet<string>): string | null {
  return firstAllowedModelId(
    allowedModelIds,
    branch.modelId,
    getModelIdForSupportEntityId(branch.parentKnotId),
  );
}

function resolveLeafModelId(leaf: Leaf, allowedModelIds: ReadonlySet<string>): string | null {
  return firstAllowedModelId(
    allowedModelIds,
    leaf.modelId,
    getModelIdForSupportEntityId(leaf.parentKnotId),
  );
}

function resolveBraceModelId(brace: Brace, allowedModelIds: ReadonlySet<string>): string | null {
  return firstAllowedModelId(
    allowedModelIds,
    brace.modelId,
    getModelIdForSupportEntityId(brace.startKnotId),
    getModelIdForSupportEntityId(brace.endKnotId),
  );
}

function resolveKickstandModelId(kickstand: Kickstand, allowedModelIds: ReadonlySet<string>): string | null {
  return firstAllowedModelId(
    allowedModelIds,
    kickstand.modelId,
    getModelIdForSupportEntityId(kickstand.rootId),
    getModelIdForSupportEntityId(kickstand.hostKnotId),
    getModelIdForSupportEntityId(kickstand.hostSegmentId),
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
  const coneGroup = SupportGeometryGenerator.generateConeMesh(cone);
  group.add(coneGroup);

  const diskGroup = SupportGeometryGenerator.generateContactDiskMesh(cone);
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
  if (segment.type === 'bezier') {
    const points = bezierToLineSegments(
      start,
      segment.controlPoint1,
      segment.controlPoint2,
      end,
      segment.resolution,
    );
    for (let i = 0; i < points.length - 1; i += 1) {
      const shaft = SupportGeometryGenerator.generateShaftMesh(
        new THREE.Vector3(points[i].x, points[i].y, points[i].z),
        new THREE.Vector3(points[i + 1].x, points[i + 1].y, points[i + 1].z),
        segment.diameter,
      );
      if (shaft) group.add(shaft);
    }
    return;
  }

  const shaft = SupportGeometryGenerator.generateShaftMesh(
    new THREE.Vector3(start.x, start.y, start.z),
    new THREE.Vector3(end.x, end.y, end.z),
    segment.diameter,
  );
  if (shaft) group.add(shaft);
}

function buildAnchorGroup(anchor: Anchor, modelId: string | null | undefined): THREE.Group {
  const group = new THREE.Group();
  group.name = `Anchor_${anchor.id}`;
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
  group.name = `Brace_${brace.id}`;
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
  group.name = `Leaf_${leaf.id}`;
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
  group.name = `Stick_${stick.id}`;
  addModelMetadata(group, modelId);
  appendConeGeometry(group, stick.contactConeA);
  return group;
}

function buildTwigGroup(twig: Twig, modelId: string | null | undefined): THREE.Group {
  const startPos = buildTwigDiskTipCenter(twig.contactDiskA);
  const endPos = buildTwigDiskTipCenter(twig.contactDiskB);
  const group = new THREE.Group();
  group.name = `Twig_${twig.id}`;
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

  const diskA = SupportGeometryGenerator.generateContactDiskMesh({
    pos: twig.contactDiskA.pos,
    normal: twig.contactDiskA.coneAxis,
    surfaceNormal: twig.contactDiskA.surfaceNormal,
    diskLengthOverride: twig.contactDiskA.diskLengthOverride,
    profile: twig.contactDiskA.profile,
  });
  const diskB = SupportGeometryGenerator.generateContactDiskMesh({
    pos: twig.contactDiskB.pos,
    normal: twig.contactDiskB.coneAxis,
    surfaceNormal: twig.contactDiskB.surfaceNormal,
    diskLengthOverride: twig.contactDiskB.diskLengthOverride,
    profile: twig.contactDiskB.profile,
  });
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
  group.name = `Kickstand_${kickstand.id}`;
  addModelMetadata(group, modelId);

  const raftSettings = modelId ? getRaftSettingsForModel(modelId) : undefined;
  const rootGroup = SupportGeometryGenerator.generateRootsMesh(
    root,
    kickstand.segments[0]?.diameter ?? kickstand.profile.bodyDiameterMm,
    raftSettings,
  );
  group.add(rootGroup);

  const hasSolidBottom = raftSettings?.bottomMode === 'solid';
  const raftThickness = raftSettings?.thickness ?? 0;
  const effectiveDiskHeight = hasSolidBottom ? 0.05 : Math.max(0.001, root.diskHeight);
  const verticalOffset = hasSolidBottom ? Math.max(raftThickness - effectiveDiskHeight, 0) : 0;
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
  kickstandState: KickstandState,
  modelIds: Iterable<string>,
): ScopedSupportPayload {
  const allowedModelIds = new Set(Array.from(modelIds).filter((modelId) => modelId.trim().length > 0));

  const roots = Object.values(supportState.roots)
    .filter((item) => hasAllowedModelId(allowedModelIds, item.modelId));
  const trunks = Object.values(supportState.trunks)
    .filter((item) => hasAllowedModelId(allowedModelIds, item.modelId));
  const branches = Object.values(supportState.branches)
    .filter((item) => resolveBranchModelId(item, allowedModelIds) !== null);
  const leaves = Object.values(supportState.leaves)
    .filter((item) => resolveLeafModelId(item, allowedModelIds) !== null);
  const twigs = Object.values(supportState.twigs)
    .filter((item) => hasAllowedModelId(allowedModelIds, item.modelId));
  const sticks = Object.values(supportState.sticks)
    .filter((item) => hasAllowedModelId(allowedModelIds, item.modelId));
  const braces = Object.values(supportState.braces)
    .filter((item) => resolveBraceModelId(item, allowedModelIds) !== null);
  const anchors = Object.values(supportState.anchors)
    .filter((item) => hasAllowedModelId(allowedModelIds, item.modelId));
  const kickstands = Object.values(kickstandState.kickstands)
    .filter((item) => resolveKickstandModelId(item, allowedModelIds) !== null);

  const kickstandRootIds = new Set(kickstands.map((item) => item.rootId));
  const kickstandKnotIds = new Set(kickstands.map((item) => item.hostKnotId));
  const kickstandRoots = Object.values(kickstandState.roots)
    .filter((item) => kickstandRootIds.has(item.id));
  const kickstandKnots = Object.values(kickstandState.knots)
    .filter((item) => kickstandKnotIds.has(item.id));

  const includedSegmentIds = new Set<string>();
  trunks.forEach((item) => item.segments.forEach((segment) => includedSegmentIds.add(segment.id)));
  branches.forEach((item) => item.segments.forEach((segment) => includedSegmentIds.add(segment.id)));
  twigs.forEach((item) => item.segments.forEach((segment) => includedSegmentIds.add(segment.id)));
  sticks.forEach((item) => item.segments.forEach((segment) => includedSegmentIds.add(segment.id)));
  braces.forEach((item) => includedSegmentIds.add(`braceSegment:${item.id}`));
  kickstands.forEach((item) => item.segments.forEach((segment) => includedSegmentIds.add(segment.id)));

  const referencedKnotIds = new Set<string>();
  branches.forEach((item) => referencedKnotIds.add(item.parentKnotId));
  leaves.forEach((item) => referencedKnotIds.add(item.parentKnotId));
  braces.forEach((item) => {
    referencedKnotIds.add(item.startKnotId);
    referencedKnotIds.add(item.endKnotId);
  });

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
      return hasAllowedModelId(allowedModelIds, getModelIdForSupportEntityId(item.id));
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
    kickstandRoots,
    kickstandKnots,
    kickstands,
  };
}

export function buildScopedSupportExportDocument(
  supportState: SupportState,
  kickstandState: KickstandState,
  modelIds: Iterable<string>,
  source = 'dragonfruit-voxl',
): DragonfruitImportFormat {
  const payload = extractScopedSupportPayload(supportState, kickstandState, modelIds);
  const kickstandRootsById = new Map(payload.kickstandRoots.map((item) => [item.id, item]));
  const kickstandKnotsById = new Map(payload.kickstandKnots.map((item) => [item.id, item]));

  const kickstandBuilds: KickstandBuildResult[] = payload.kickstands
    .map((kickstand) => {
      const root = kickstandRootsById.get(kickstand.rootId);
      const hostKnot = kickstandKnotsById.get(kickstand.hostKnotId);
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
  kickstandState: KickstandState,
  modelIds: Iterable<string>,
): THREE.Group {
  const payload = extractScopedSupportPayload(supportState, kickstandState, modelIds);
  const group = new THREE.Group();
  group.name = 'ScopedSupportExport';

  const rootsById = supportState.roots;
  const knotsById = supportState.knots;
  const kickstandRootsById = kickstandState.roots;
  const kickstandKnotsById = kickstandState.knots;

  payload.trunks.forEach((trunk) => {
    const root = rootsById[trunk.rootId];
    if (!root) return;
    const modelId = trunk.modelId ?? root.modelId ?? null;
    const trunkGroup = SupportGeometryGenerator.generateSupportGroup(
      {
        id: trunk.id,
        roots: root,
        segments: trunk.segments,
        contactCone: trunk.contactCone,
      },
      modelId ? getRaftSettingsForModel(modelId) : undefined,
    );
    trunkGroup.name = `Trunk_${trunk.id}`;
    addModelMetadata(trunkGroup, modelId);
    group.add(trunkGroup);
  });

  payload.branches.forEach((branch) => {
    const parentKnot = knotsById[branch.parentKnotId];
    if (!parentKnot) return;
    const modelId = branch.modelId ?? getModelIdForSupportEntityId(branch.parentKnotId);
    const branchGroup = SupportGeometryGenerator.generateSupportGroup({
      id: branch.id,
      startPos: parentKnot.pos,
      segments: branch.segments,
      contactCone: branch.contactCone,
    });
    branchGroup.name = `Branch_${branch.id}`;
    addModelMetadata(branchGroup, modelId);
    group.add(branchGroup);
  });

  payload.leaves.forEach((leaf) => {
    const modelId = leaf.modelId ?? getModelIdForSupportEntityId(leaf.parentKnotId);
    group.add(buildLeafGroup(leaf, modelId));
  });

  payload.twigs.forEach((twig) => {
    group.add(buildTwigGroup(twig, twig.modelId));
  });

  payload.sticks.forEach((stick) => {
    group.add(buildStickGroup(stick, stick.modelId));
  });

  payload.braces.forEach((brace) => {
    const startKnot = knotsById[brace.startKnotId];
    const endKnot = knotsById[brace.endKnotId];
    if (!startKnot || !endKnot) return;
    const modelId = brace.modelId
      ?? getModelIdForSupportEntityId(brace.startKnotId)
      ?? getModelIdForSupportEntityId(brace.endKnotId);
    group.add(buildBraceGroup(brace, startKnot, endKnot, modelId));
  });

  payload.kickstands.forEach((kickstand) => {
    const root = kickstandRootsById[kickstand.rootId];
    const hostKnot = kickstandKnotsById[kickstand.hostKnotId];
    if (!root || !hostKnot) return;
    const modelId = kickstand.modelId
      ?? root.modelId
      ?? getModelIdForSupportEntityId(kickstand.hostKnotId)
      ?? getModelIdForSupportEntityId(kickstand.hostSegmentId);
    group.add(buildKickstandGroup(kickstand, root, hostKnot, modelId));
  });

  payload.anchors.forEach((anchor) => {
    group.add(buildAnchorGroup(anchor, anchor.modelId));
  });

  group.updateMatrixWorld(true);
  return group;
}

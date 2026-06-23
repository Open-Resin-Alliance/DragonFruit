import type {
  Brace,
  Branch,
  DragonfruitImportFormat,
  Joint,
  Knot,
  Roots,
  Segment,
  Trunk,
  Vec3,
} from '@/supports/types';
import type { ContactCone } from '@/supports/SupportPrimitives/ContactCone/types';
import type {
  ReconstructionAttachmentCandidate,
  ReconstructionAxialCandidate,
  ReconstructionContactCandidate,
  ReconstructionEndpointCandidate,
  ReconstructionRootCandidate,
  ReconstructionTopologyCandidate,
  SupportReconstructionResult,
} from './nativeSupportReconstruction';

export type NativeTopologyRejection = {
  topologyId: string;
  axialCandidateId: string;
  code: string;
  message: string;
};

export type NativeSupportPreview = {
  payload: DragonfruitImportFormat;
  rejected: NativeTopologyRejection[];
  validationErrors: string[];
};

type IdFactory = (prefix: string) => string;

type BuildOptions = {
  modelId: string;
  objectCenter: Vec3;
  idFactory?: IdFactory;
};

const MIN_TRANSITION_MM = 0.05;

function defaultIdFactory(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Math.random().toString(36).slice(2)}`;
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function length(vector: Vec3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normalize(vector: Vec3): Vec3 | null {
  const magnitude = length(vector);
  if (magnitude < 1e-9) return null;
  return { x: vector.x / magnitude, y: vector.y / magnitude, z: vector.z / magnitude };
}

function zAxisQuaternion(direction: Vec3) {
  const unit = normalize(direction) ?? { x: 0, y: 0, z: 1 };
  const dot = Math.max(-1, Math.min(1, unit.z));
  if (dot < -0.999999) return { x: 1, y: 0, z: 0, w: 0 };
  const scale = Math.sqrt((1 + dot) * 2);
  return { x: -unit.y / scale, y: unit.x / scale, z: 0, w: scale / 2 };
}

function endpointFor(
  topology: ReconstructionTopologyCandidate,
  endpointId: string,
  endpoints: Map<string, ReconstructionEndpointCandidate>,
  reject: (code: string, message: string) => void,
): ReconstructionEndpointCandidate | null {
  const endpoint = endpoints.get(endpointId);
  if (!endpoint || endpoint.axialCandidateId !== topology.axialCandidateId) {
    reject('invalid_endpoint_reference', `Endpoint ${endpointId} does not belong to this shaft.`);
    return null;
  }
  return endpoint;
}

function shaftPoint(candidate: ReconstructionAxialCandidate, side: 'start' | 'end'): Vec3 {
  return side === 'start' ? candidate.shaftStart : candidate.shaftEnd;
}

function transitionLength(candidate: ReconstructionAxialCandidate, side: 'start' | 'end'): number {
  return side === 'start' ? candidate.startTransitionLengthMm : candidate.endTransitionLengthMm;
}

function buildContactCone(
  contact: ReconstructionContactCandidate,
  endpoint: ReconstructionEndpointCandidate,
  candidate: ReconstructionAxialCandidate,
  joint: Joint,
  id: string,
): ContactCone | null {
  const socket = shaftPoint(candidate, endpoint.side);
  const axis = normalize(subtract(socket, contact.position));
  const coneLength = length(subtract(socket, contact.position));
  if (!axis || coneLength < MIN_TRANSITION_MM) return null;
  return {
    id,
    pos: contact.position,
    normal: axis,
    surfaceNormal: contact.surfaceNormal,
    diskLengthOverride: 0,
    profile: {
      type: 'disk',
      contactDiameterMm: contact.diameterMm,
      bodyDiameterMm: candidate.meanRadiusMm * 2,
      lengthMm: coneLength,
      penetrationMm: 0.05,
      diskThicknessMm: Math.min(0.1, coneLength * 0.2),
      maxStandoffMm: 0.25,
      standoffAngleThreshold: Math.PI / 4,
    },
    socketJointId: joint.id,
  };
}

function isFiniteVec3(vector: Vec3): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function validatePositive(value: number | undefined, path: string, errors: string[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    errors.push(`${path} must be a positive finite number.`);
  }
}

export function validateNativeSupportPayload(payload: DragonfruitImportFormat, modelId: string): string[] {
  const errors: string[] = [];
  const rootIds = new Set(payload.roots.map((root) => root.id));
  const knotIds = new Set(payload.knots.map((knot) => knot.id));
  const segmentIds = new Set<string>();
  const jointIds = new Set<string>();

  const addSegments = (owner: string, segments: Segment[]) => {
    if (segments.length === 0) errors.push(`${owner} must contain at least one segment.`);
    for (const segment of segments) {
      if (segmentIds.has(segment.id)) errors.push(`Segment ${segment.id} is duplicated.`);
      segmentIds.add(segment.id);
      validatePositive(segment.diameter, `Segment ${segment.id} diameter`, errors);
      if (segment.topJoint) {
        if (jointIds.has(segment.topJoint.id)) errors.push(`Joint ${segment.topJoint.id} is duplicated.`);
        jointIds.add(segment.topJoint.id);
        validatePositive(segment.topJoint.diameter, `Joint ${segment.topJoint.id} diameter`, errors);
        if (!isFiniteVec3(segment.topJoint.pos)) errors.push(`Joint ${segment.topJoint.id} position is non-finite.`);
      }
      if (segment.bottomJoint) {
        if (jointIds.has(segment.bottomJoint.id)) errors.push(`Joint ${segment.bottomJoint.id} is duplicated.`);
        jointIds.add(segment.bottomJoint.id);
        validatePositive(segment.bottomJoint.diameter, `Joint ${segment.bottomJoint.id} diameter`, errors);
        if (!isFiniteVec3(segment.bottomJoint.pos)) errors.push(`Joint ${segment.bottomJoint.id} position is non-finite.`);
      }
    }
  };

  const validateContactCone = (owner: string, cone: ContactCone | undefined) => {
    if (!cone) return;
    if (!isFiniteVec3(cone.pos) || !isFiniteVec3(cone.normal)) {
      errors.push(`${owner} contact cone ${cone.id} contains non-finite geometry.`);
    }
    validatePositive(cone.profile.contactDiameterMm, `${owner} contact cone ${cone.id} contact diameter`, errors);
    validatePositive(cone.profile.bodyDiameterMm, `${owner} contact cone ${cone.id} body diameter`, errors);
    validatePositive(cone.profile.lengthMm, `${owner} contact cone ${cone.id} length`, errors);
    if (!cone.socketJointId || !jointIds.has(cone.socketJointId)) {
      errors.push(`${owner} contact cone ${cone.id} references missing socket joint ${String(cone.socketJointId)}.`);
    }
  };

  for (const root of payload.roots) {
    if (root.modelId !== modelId) errors.push(`Root ${root.id} has inconsistent modelId.`);
    if (!isFiniteVec3(root.transform.pos)) errors.push(`Root ${root.id} position is non-finite.`);
    validatePositive(root.diameter, `Root ${root.id} diameter`, errors);
    validatePositive(root.diskHeight, `Root ${root.id} disk height`, errors);
    validatePositive(root.coneHeight, `Root ${root.id} cone height`, errors);
  }

  for (const trunk of payload.trunks) {
    if (trunk.modelId !== modelId) errors.push(`Trunk ${trunk.id} has inconsistent modelId.`);
    if (!rootIds.has(trunk.rootId)) errors.push(`Trunk ${trunk.id} references missing root ${trunk.rootId}.`);
    addSegments(`Trunk ${trunk.id}`, trunk.segments);
  }

  for (const branch of payload.branches) {
    if (branch.modelId !== modelId) errors.push(`Branch ${branch.id} has inconsistent modelId.`);
    if (!knotIds.has(branch.parentKnotId)) errors.push(`Branch ${branch.id} references missing knot ${branch.parentKnotId}.`);
    addSegments(`Branch ${branch.id}`, branch.segments);
  }

  for (const brace of payload.braces) {
    if (brace.modelId !== modelId) errors.push(`Brace ${brace.id} has inconsistent modelId.`);
    if (!knotIds.has(brace.startKnotId)) errors.push(`Brace ${brace.id} references missing start knot ${brace.startKnotId}.`);
    if (!knotIds.has(brace.endKnotId)) errors.push(`Brace ${brace.id} references missing end knot ${brace.endKnotId}.`);
    validatePositive(brace.profile.diameter, `Brace ${brace.id} diameter`, errors);
  }

  for (const knot of payload.knots) {
    if (!segmentIds.has(knot.parentShaftId)) errors.push(`Knot ${knot.id} references missing host segment ${knot.parentShaftId}.`);
    if (!isFiniteVec3(knot.pos)) errors.push(`Knot ${knot.id} position is non-finite.`);
    validatePositive(knot.diameter, `Knot ${knot.id} diameter`, errors);
    if (!Number.isFinite(knot.t) || knot.t < 0 || knot.t > 1) errors.push(`Knot ${knot.id} t must be within 0..1.`);
  }

  for (const trunk of payload.trunks) validateContactCone(`Trunk ${trunk.id}`, trunk.contactCone);
  for (const branch of payload.branches) validateContactCone(`Branch ${branch.id}`, branch.contactCone);
  for (const leaf of payload.leaves) validateContactCone(`Leaf ${leaf.id}`, leaf.contactCone);

  return errors;
}

export function buildNativeSupportPreview(
  result: SupportReconstructionResult,
  options: BuildOptions,
): NativeSupportPreview {
  const id = options.idFactory ?? defaultIdFactory;
  const payload: DragonfruitImportFormat = {
    version: 1,
    meta: { source: 'baked-support-reconstruction', objectCenter: options.objectCenter },
    roots: [], trunks: [], branches: [], leaves: [], braces: [], knots: [],
  };
  const rejected: NativeTopologyRejection[] = [];
  const rejectedTopologyIds = new Set<string>();
  const reject = (topology: ReconstructionTopologyCandidate, code: string, message: string) => {
    if (rejectedTopologyIds.has(topology.id)) return;
    rejectedTopologyIds.add(topology.id);
    rejected.push({
      topologyId: topology.id,
      axialCandidateId: topology.axialCandidateId,
      code,
      message,
    });
  };

  const axials = new Map(result.graph.axialCandidates.map((entry) => [entry.id, entry]));
  const endpoints = new Map(result.graph.endpoints.map((entry) => [entry.id, entry]));
  const roots = new Map(result.graph.roots.map((entry) => [entry.id, entry]));
  const contacts = new Map(result.graph.contacts.map((entry) => [entry.id, entry]));
  const attachments = new Map(result.graph.attachments.map((entry) => [entry.id, entry]));
  const topologies = new Map(result.graph.topologyCandidates.map((entry) => [entry.axialCandidateId, entry]));
  const nativeIds = new Map<string, { entityId: string; segmentId: string }>();

  for (const topology of result.graph.topologyCandidates) {
    if (topology.kind === 'trunk' || topology.kind === 'branch') {
      nativeIds.set(topology.axialCandidateId, {
        entityId: id(topology.kind),
        segmentId: id('segment'),
      });
    }
    const axial = axials.get(topology.axialCandidateId);
    if (!axial || !axial.accepted) reject(topology, 'invalid_axial_candidate', 'The fitted shaft is missing or was not accepted.');
    if (topology.kind === 'unresolved') reject(topology, 'unresolved_topology', 'The endpoint pattern has no native topology mapping.');
  }

  // Preflight anatomy before resolving cross-shaft dependencies so no generated
  // entity can reference a host that will later disappear during conversion.
  for (const topology of result.graph.topologyCandidates) {
    if (rejectedTopologyIds.has(topology.id)) continue;
    const axial = axials.get(topology.axialCandidateId)!;
    if (topology.kind === 'trunk') {
      const root = topology.rootIds.length === 1 ? roots.get(topology.rootIds[0]) : undefined;
      const rootEndpoint = root ? endpoints.get(root.endpointId) : undefined;
      if (!root || !rootEndpoint || rootEndpoint.axialCandidateId !== topology.axialCandidateId) {
        reject(topology, 'invalid_trunk_anatomy', 'A trunk requires one valid root endpoint.');
      } else if (transitionLength(axial, rootEndpoint.side) < MIN_TRANSITION_MM) {
        reject(topology, 'missing_root_transition', 'The fitted root transition is too short to create native root anatomy.');
      } else if (topology.contactIds.length > 1) {
        reject(topology, 'invalid_trunk_anatomy', 'A trunk may have at most one contact.');
      }
    } else if (topology.kind === 'branch' && (topology.attachmentIds.length !== 1 || topology.contactIds.length !== 1)) {
      reject(topology, 'invalid_branch_anatomy', 'A branch requires one host attachment and one model contact.');
    } else if (topology.kind === 'brace' && topology.attachmentIds.length !== 2) {
      reject(topology, 'invalid_brace_anatomy', 'A brace requires exactly two host attachments.');
    }
    for (const contactId of topology.contactIds) {
      const contact = contacts.get(contactId);
      const endpoint = contact ? endpoints.get(contact.endpointId) : undefined;
      if (!contact || !endpoint || endpoint.axialCandidateId !== topology.axialCandidateId) {
        reject(topology, 'invalid_contact_reference', `Contact ${contactId} does not belong to this shaft.`);
      } else if (length(subtract(shaftPoint(axial, endpoint.side), contact.position)) < MIN_TRANSITION_MM) {
        reject(topology, 'missing_contact_transition', 'The fitted contact transition is too short to create a native contact cone.');
      }
    }
  }

  // Reject dependency cycles and attachments whose host cannot own a native Knot.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (axialId: string): boolean => {
    if (visiting.has(axialId)) return true;
    if (visited.has(axialId)) return false;
    visiting.add(axialId);
    const topology = topologies.get(axialId);
    for (const attachmentId of topology?.attachmentIds ?? []) {
      const attachment = attachments.get(attachmentId);
      if (attachment && visit(attachment.hostAxialCandidateId)) {
        if (topology) reject(topology, 'cyclic_attachment_graph', 'Attachment dependencies contain a cycle.');
        visiting.delete(axialId);
        visited.add(axialId);
        return true;
      }
    }
    visiting.delete(axialId);
    visited.add(axialId);
    return false;
  };
  for (const axialId of topologies.keys()) visit(axialId);

  let changed = true;
  while (changed) {
    changed = false;
    for (const topology of result.graph.topologyCandidates) {
      if (rejectedTopologyIds.has(topology.id)) continue;
      for (const attachmentId of topology.attachmentIds) {
        const attachment = attachments.get(attachmentId);
        const hostTopology = attachment ? topologies.get(attachment.hostAxialCandidateId) : undefined;
        if (!attachment || !hostTopology || !nativeIds.has(attachment.hostAxialCandidateId)) {
          reject(topology, 'invalid_attachment_host', `Attachment ${attachmentId} has no native host shaft.`);
          changed = true;
          break;
        }
        if (rejectedTopologyIds.has(hostTopology.id)) {
          reject(topology, 'rejected_attachment_host', `Attachment ${attachmentId} targets a rejected host shaft.`);
          changed = true;
          break;
        }
      }
    }
  }

  const makeKnot = (attachment: ReconstructionAttachmentCandidate): Knot => {
    const host = nativeIds.get(attachment.hostAxialCandidateId)!;
    const hostAxial = axials.get(attachment.hostAxialCandidateId)!;
    return {
      id: id('knot'),
      parentShaftId: host.segmentId,
      t: Math.max(0, Math.min(1, attachment.hostT)),
      pos: attachment.position,
      diameter: hostAxial.meanRadiusMm * 2 + 0.1,
      normalizationHint: 'preserve',
    };
  };

  for (const topology of result.graph.topologyCandidates) {
    if (rejectedTopologyIds.has(topology.id)) continue;
    const axial = axials.get(topology.axialCandidateId)!;
    const ids = nativeIds.get(topology.axialCandidateId);
    const localReject = (code: string, message: string) => reject(topology, code, message);

    if (topology.kind === 'trunk') {
      if (!ids || topology.rootIds.length !== 1 || topology.contactIds.length > 1) {
        reject(topology, 'invalid_trunk_anatomy', 'A trunk requires one root and at most one contact.');
        continue;
      }
      const root = roots.get(topology.rootIds[0]) as ReconstructionRootCandidate | undefined;
      const rootEndpoint = root ? endpointFor(topology, root.endpointId, endpoints, localReject) : null;
      if (!root || !rootEndpoint) continue;
      const rootTransition = transitionLength(axial, rootEndpoint.side);
      const rootShaftPoint = shaftPoint(axial, rootEndpoint.side);
      if (rootTransition < MIN_TRANSITION_MM) {
        reject(topology, 'missing_root_transition', 'The fitted root transition is too short to create native root anatomy.');
        continue;
      }
      const diskHeight = Math.min(0.2, rootTransition * 0.2);
      const nativeRoot: Roots = {
        id: id('root'), modelId: options.modelId,
        transform: { pos: root.position, rot: zAxisQuaternion(subtract(rootShaftPoint, root.position)) },
        diameter: root.diameterMm,
        diskHeight,
        coneHeight: rootTransition - diskHeight,
      };
      const terminalSide = rootEndpoint.side === 'start' ? 'end' : 'start';
      const terminalJoint: Joint = {
        id: id('joint'), pos: shaftPoint(axial, terminalSide), diameter: axial.meanRadiusMm * 2,
      };
      const segment: Segment = { id: ids.segmentId, diameter: axial.meanRadiusMm * 2, topJoint: terminalJoint };
      const nativeTrunk: Trunk = {
        id: ids.entityId, modelId: options.modelId, rootId: nativeRoot.id,
        baseDiameterMm: axial.meanRadiusMm * 2, segments: [segment],
      };
      if (topology.contactIds.length === 1) {
        const contact = contacts.get(topology.contactIds[0]);
        const contactEndpoint = contact ? endpointFor(topology, contact.endpointId, endpoints, localReject) : null;
        const cone = contact && contactEndpoint
          ? buildContactCone(contact, contactEndpoint, axial, terminalJoint, id('contact'))
          : null;
        if (!cone) {
          reject(topology, 'missing_contact_transition', 'The fitted contact transition is too short to create a native contact cone.');
          continue;
        }
        nativeTrunk.contactCone = cone;
      }
      payload.roots.push(nativeRoot);
      payload.trunks.push(nativeTrunk);
    } else if (topology.kind === 'branch') {
      if (!ids || topology.attachmentIds.length !== 1 || topology.contactIds.length !== 1) {
        reject(topology, 'invalid_branch_anatomy', 'A branch requires one host attachment and one model contact.');
        continue;
      }
      const attachment = attachments.get(topology.attachmentIds[0]);
      const contact = contacts.get(topology.contactIds[0]);
      const contactEndpoint = contact ? endpointFor(topology, contact.endpointId, endpoints, localReject) : null;
      if (!attachment || !contact || !contactEndpoint) continue;
      const joint: Joint = { id: id('joint'), pos: shaftPoint(axial, contactEndpoint.side), diameter: axial.meanRadiusMm * 2 };
      const cone = buildContactCone(contact, contactEndpoint, axial, joint, id('contact'));
      if (!cone) {
        reject(topology, 'missing_contact_transition', 'The fitted contact transition is too short to create a native contact cone.');
        continue;
      }
      const knot = makeKnot(attachment);
      const branch: Branch = {
        id: ids.entityId, modelId: options.modelId, parentKnotId: knot.id,
        segments: [{ id: ids.segmentId, diameter: axial.meanRadiusMm * 2, topJoint: joint }],
        contactCone: cone,
      };
      payload.knots.push(knot);
      payload.branches.push(branch);
    } else if (topology.kind === 'brace') {
      if (topology.attachmentIds.length !== 2) {
        reject(topology, 'invalid_brace_anatomy', 'A brace requires exactly two host attachments.');
        continue;
      }
      const first = attachments.get(topology.attachmentIds[0]);
      const second = attachments.get(topology.attachmentIds[1]);
      if (!first || !second) {
        reject(topology, 'invalid_attachment_reference', 'A brace attachment is missing.');
        continue;
      }
      const start = makeKnot(first);
      const end = makeKnot(second);
      const brace: Brace = {
        id: id('brace'), modelId: options.modelId,
        startKnotId: start.id, endKnotId: end.id,
        profile: { diameter: axial.meanRadiusMm * 2 },
      };
      payload.knots.push(start, end);
      payload.braces.push(brace);
    }
  }

  return { payload, rejected, validationErrors: validateNativeSupportPayload(payload, options.modelId) };
}

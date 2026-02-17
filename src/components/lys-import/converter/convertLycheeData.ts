import * as THREE from 'three';
import { v4 as uuidv4 } from 'uuid';
import {
  DragonfruitImportFormat,
  Roots,
  Trunk,
  Branch,
  Leaf,
  Twig,
  Stick,
  Brace,
  Knot,
  Segment,
  Joint,
  Vec3,
} from '../../../supports/types';
import { SupportSettings } from '../../../supports/Settings';
import { getJointDiameter } from '../../../supports/constants';
import {
  applyWorldXYPlacementToSlice,
  inferLeafTipEndpoint,
  inferParentIds,
  isMiniSupport,
  isStickCandidate,
  isTwigCandidate,
  pickAttachAndTipFromParentHints,
  pickBracePairing,
  pickContactTipSettings,
  pickFallbackObjectId,
  pickLeafEndpointDiameter,
  pickStickEndpointTipSettings,
  projectPointToHost,
  resolveSupportOwnerId,
} from './helpers';
import { createContactAssembly } from './contactAssembly';
import { HostEntry, LycheeData, LycheeSupport } from './types';

export function convertLycheeData(data: LycheeData, settings: SupportSettings, mesh?: THREE.Mesh): DragonfruitImportFormat {
  const result: DragonfruitImportFormat = {
    version: 1,
    meta: {
      source: 'lychee_conversion',
      objectCenter: { x: 0, y: 0, z: 0 },
      updatedAt: Date.now(),
    },
    roots: [],
    trunks: [],
    branches: [],
    leaves: [],
    twigs: [],
    sticks: [],
    braces: [],
    knots: [],
  };

  if (!data.objects?.present?.byId || !data.supports?.present?.byId) {
    console.error('[LysConverter] Missing objects or supports data');
    return result;
  }

  const objects = data.objects.present.byId;
  const supports = data.supports.present.byId;
  const fallbackObjectId = pickFallbackObjectId(objects);
  if (!fallbackObjectId) {
    console.warn('[LysConverter] No object found in scene data');
    return result;
  }
  const supportsByObjectId = new Map<string, { id: string; s: LycheeSupport }[]>();

  for (const [supportId, support] of Object.entries(supports)) {
    if (!support.base || !support.tip) continue;

    const ownerObjectId = resolveSupportOwnerId(supportId, support, objects, fallbackObjectId);
    const list = supportsByObjectId.get(ownerObjectId);
    if (list) {
      list.push({ id: supportId, s: support });
    } else {
      supportsByObjectId.set(ownerObjectId, [{ id: supportId, s: support }]);
    }
  }

  if (supportsByObjectId.size === 0) {
    console.warn('[LysConverter] No supports with usable geometry found');
    return result;
  }

  let didSetMetaCenter = false;

  for (const [objectId, supportsForObject] of supportsByObjectId) {
    const targetObj = objects[objectId];
    if (!targetObj) {
      console.warn(`[LysConverter] Object ${objectId} was selected for support ownership but does not exist. Skipping.`);
      continue;
    }

    const pivot = targetObj.formerCenter || targetObj.center || { x: 0, y: 0, z: 0 };
    if (!didSetMetaCenter) {
      result.meta.objectCenter = pivot;
      didSetMetaCenter = true;
    }

    const pos = targetObj.position || { x: 0, y: 0, z: 0 };
    const scale = targetObj.scale || { x: 1, y: 1, z: 1 };
    const rot = targetObj.rotation || { x: 0, y: 0, z: 0 };
    const deg2rad = Math.PI / 180;

    const objectQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      (rot.x || 0) * deg2rad,
      (rot.y || 0) * deg2rad,
      (rot.z || 0) * deg2rad,
      'XYZ'
    ));

    const objectLiftZ = Number.isFinite(pos.z) ? pos.z : 0;
    const objectPreSupportPos = new THREE.Vector3(0, 0, objectLiftZ);
    const objectScale = new THREE.Vector3(scale.x, scale.y, scale.z);

    const transformObjectPoint = (v: { x: number; y: number; z: number }): THREE.Vector3 => {
      const p = new THREE.Vector3(v.x, v.y, v.z);
      p.multiply(objectScale);
      p.applyQuaternion(objectQuaternion);
      p.add(objectPreSupportPos);
      return p;
    };

    const transformObjectNormal = (v: { x: number; y: number; z: number }): THREE.Vector3 => {
      const n = new THREE.Vector3(v.x, v.y, v.z);

      const invScaleX = Math.abs(objectScale.x) > 1e-8 ? 1 / objectScale.x : 0;
      const invScaleY = Math.abs(objectScale.y) > 1e-8 ? 1 / objectScale.y : 0;
      const invScaleZ = Math.abs(objectScale.z) > 1e-8 ? 1 / objectScale.z : 0;

      n.set(n.x * invScaleX, n.y * invScaleY, n.z * invScaleZ);
      n.applyQuaternion(objectQuaternion);

      if (n.lengthSq() > 1e-8) {
        n.normalize();
      }

      return n;
    };

    const transformRootBasePoint = (v: { x: number; y: number; z: number }): THREE.Vector3 => {
      const p = new THREE.Vector3(v.x, v.y, 0);
      p.x *= objectScale.x;
      p.y *= objectScale.y;
      return p;
    };

    const rootDefaults = settings.roots;
    const tipDefaults = settings.tip;
    const shaftDefaults = settings.shaft;
    const stickVsTwigCutoffMm = Number.isFinite(settings.meshToMesh?.stickVsTwigCutoffMm)
      ? settings.meshToMesh.stickVsTwigCutoffMm
      : 5;

    const hostsByLycheeId = new Map<string, HostEntry>();

    const twigCandidates: { id: string; s: LycheeSupport }[] = [];
    const stickCandidates: { id: string; s: LycheeSupport }[] = [];
    const rootCandidates: { id: string; s: LycheeSupport }[] = [];
    const branchCandidates: { id: string; s: LycheeSupport; parentIds: string[] }[] = [];
    const braceCandidates: { id: string; s: LycheeSupport; parentIds: string[] }[] = [];

    for (const { id, s } of supportsForObject) {
      const parentIds = inferParentIds(s);

      if (parentIds.length === 0) {
        if (isTwigCandidate(s, parentIds, stickVsTwigCutoffMm)) {
          twigCandidates.push({ id, s });
        } else if (isStickCandidate(s, parentIds, stickVsTwigCutoffMm)) {
          stickCandidates.push({ id, s });
        } else {
          rootCandidates.push({ id, s });
        }
      } else if (parentIds.length === 1) {
        branchCandidates.push({ id, s, parentIds });
      } else if (parentIds.length >= 2) {
        braceCandidates.push({ id, s, parentIds });
      }
    }

    const sliceStart = {
      roots: result.roots.length,
      trunks: result.trunks.length,
      branches: result.branches.length,
      leaves: result.leaves.length,
      twigs: result.twigs?.length || 0,
      sticks: result.sticks?.length || 0,
      knots: result.knots.length,
    };

    const pickTwigContactDiameter = (endpointSettings: any): number => {
      const pointDiameter = endpointSettings?.pointDiameter;
      if (Number.isFinite(pointDiameter) && pointDiameter > 0) return pointDiameter;

      const diameter = endpointSettings?.diameter;
      if (Number.isFinite(diameter) && diameter > 0) return diameter;

      return tipDefaults.contactDiameterMm;
    };

    for (const { s } of twigCandidates) {
      if (!s.base || !s.tip) continue;

      const baseWorld = transformObjectPoint(s.base);
      const tipWorld = transformObjectPoint(s.tip);

      const transformedBaseNormal = s.baseNormal ? transformObjectNormal(s.baseNormal) : null;
      const transformedTipNormal = s.tipNormal ? transformObjectNormal(s.tipNormal) : null;

      if (!transformedBaseNormal || transformedBaseNormal.lengthSq() <= 1e-8
        || !transformedTipNormal || transformedTipNormal.lengthSq() <= 1e-8) {
        continue;
      }

      transformedBaseNormal.normalize();
      transformedTipNormal.normalize();

      const axisA = tipWorld.clone().sub(baseWorld);
      if (axisA.lengthSq() <= 1e-8) continue;
      axisA.normalize();
      const axisB = axisA.clone().multiplyScalar(-1);

      const baseEndpointSettings = pickStickEndpointTipSettings(s, 'base');
      const tipEndpointSettings = pickStickEndpointTipSettings(s, 'tip');
      const contactDiameterA = pickTwigContactDiameter(baseEndpointSettings);
      const contactDiameterB = pickTwigContactDiameter(tipEndpointSettings);

      const segment: Segment = {
        id: uuidv4(),
        type: 'straight',
        diameter: Math.min(contactDiameterA, contactDiameterB),
      };

      const twig: Twig = {
        id: uuidv4(),
        modelId: objectId,
        segments: [segment],
        contactDiskA: {
          id: uuidv4(),
          pos: { x: baseWorld.x, y: baseWorld.y, z: baseWorld.z },
          surfaceNormal: { x: transformedBaseNormal.x, y: transformedBaseNormal.y, z: transformedBaseNormal.z },
          coneAxis: { x: axisA.x, y: axisA.y, z: axisA.z },
          profile: {
            type: 'disk',
            diskThicknessMm: tipDefaults.diskThicknessMm ?? 0.1,
            maxStandoffMm: tipDefaults.maxStandoffMm ?? 1.5,
            standoffAngleThreshold: tipDefaults.standoffAngleThreshold ?? Math.PI / 4,
          },
          contactDiameterMm: contactDiameterA,
        },
        contactDiskB: {
          id: uuidv4(),
          pos: { x: tipWorld.x, y: tipWorld.y, z: tipWorld.z },
          surfaceNormal: { x: transformedTipNormal.x, y: transformedTipNormal.y, z: transformedTipNormal.z },
          coneAxis: { x: axisB.x, y: axisB.y, z: axisB.z },
          profile: {
            type: 'disk',
            diskThicknessMm: tipDefaults.diskThicknessMm ?? 0.1,
            maxStandoffMm: tipDefaults.maxStandoffMm ?? 1.5,
            standoffAngleThreshold: tipDefaults.standoffAngleThreshold ?? Math.PI / 4,
          },
          contactDiameterMm: contactDiameterB,
        },
      };

      result.twigs?.push(twig);
    }

    for (const { s } of stickCandidates) {
      if (!s.base || !s.tip) continue;

      const baseWorld = transformObjectPoint(s.base);
      const tipWorld = transformObjectPoint(s.tip);

      const transformedBaseNormal = s.baseNormal ? transformObjectNormal(s.baseNormal) : null;
      const transformedTipNormal = s.tipNormal ? transformObjectNormal(s.tipNormal) : null;

      if (!transformedBaseNormal || transformedBaseNormal.lengthSq() <= 1e-8
        || !transformedTipNormal || transformedTipNormal.lengthSq() <= 1e-8) {
        continue;
      }

      const baseEndpointSettings = pickStickEndpointTipSettings(s, 'base');
      const tipEndpointSettings = pickStickEndpointTipSettings(s, 'tip');

      const { socketJoint: socketJointA, contactCone: contactConeA } = createContactAssembly(
        s,
        baseWorld,
        { x: tipWorld.x, y: tipWorld.y, z: tipWorld.z },
        baseEndpointSettings,
        tipDefaults,
        mesh,
        true,
        true,
        transformedBaseNormal,
        false
      );

      const { socketJoint: socketJointB, contactCone: contactConeB } = createContactAssembly(
        s,
        tipWorld,
        { x: baseWorld.x, y: baseWorld.y, z: baseWorld.z },
        tipEndpointSettings,
        tipDefaults,
        mesh,
        true,
        true,
        transformedTipNormal,
        false
      );

      const shaftDiameter = s.settings?.base?.joinDiameter
        || baseEndpointSettings?.diameter
        || tipEndpointSettings?.diameter
        || shaftDefaults.diameterMm;

      const segment: Segment = {
        id: uuidv4(),
        type: 'straight',
        diameter: shaftDiameter,
        bottomJoint: socketJointA,
        topJoint: socketJointB,
      };

      const stick: Stick = {
        id: uuidv4(),
        modelId: objectId,
        segments: [segment],
        contactConeA,
        contactConeB,
      };

      result.sticks?.push(stick);
    }

    for (const { id, s } of rootCandidates) {
      if (!s.base || !s.tip) continue;

      const tipWorld = transformObjectPoint(s.tip);
      const baseRefWorld = transformRootBasePoint(s.base);

      const tipSettings = pickContactTipSettings(s);
      const baseSettings = s.settings?.base;
      const baseTipSettings = s.settings?.baseTip;

      const rootId = uuidv4();

      const padDiameter = rootDefaults.diameterMm;
      const diskHeight = rootDefaults.diskHeightMm;
      const coneHeight = rootDefaults.coneHeightMm;
      const totalBaseHeight = diskHeight + coneHeight;

      const pillarDiameter = baseSettings?.joinDiameter
        || tipSettings?.diameter
        || shaftDefaults.diameterMm;

      const root: Roots = {
        id: rootId,
        modelId: objectId,
        transform: {
          pos: { x: baseRefWorld.x, y: baseRefWorld.y, z: 0 },
          rot: { x: 0, y: 0, z: 0, w: 1 },
        },
        diameter: padDiameter,
        diskHeight: diskHeight,
        coneHeight: coneHeight,
      };

      const lycheeVisibleJoinLength = Number.isFinite(baseSettings?.joinLength as number)
        ? Math.max(0, baseSettings?.joinLength as number)
        : null;
      const lycheeSolveJoinLength = Number.isFinite(baseSettings?.newJoinLength as number)
        ? Math.max(0, baseSettings?.newJoinLength as number)
        : lycheeVisibleJoinLength;

      const joint0SolveRise = lycheeSolveJoinLength ?? totalBaseHeight;
      const joint0VisibleRiseRaw = lycheeVisibleJoinLength ?? joint0SolveRise;

      const minimumVisibleKneeRise = totalBaseHeight + 0.05;
      const joint0Rise = Math.max(joint0VisibleRiseRaw, minimumVisibleKneeRise);
      const joint0SolvePos: Vec3 = {
        x: baseRefWorld.x,
        y: baseRefWorld.y,
        z: baseRefWorld.z + joint0SolveRise,
      };
      const joint0Z = baseRefWorld.z + joint0Rise;
      const joint0: Joint = {
        id: uuidv4(),
        pos: { x: baseRefWorld.x, y: baseRefWorld.y, z: joint0Z },
        diameter: getJointDiameter(baseTipSettings?.diameter || pillarDiameter),
      };

      const transformedTipNormal = s.tipNormal ? transformObjectNormal(s.tipNormal) : null;
      const { socketJoint, contactCone } = createContactAssembly(
        s,
        tipWorld,
        joint0SolvePos,
        tipSettings,
        tipDefaults,
        mesh,
        true,
        true,
        transformedTipNormal
      );

      const segments: Segment[] = [];
      segments.push({
        id: uuidv4(),
        type: 'straight',
        diameter: baseTipSettings?.diameter || pillarDiameter,
        bottomJoint: undefined,
        topJoint: joint0,
      });
      segments.push({
        id: uuidv4(),
        type: 'straight',
        diameter: pillarDiameter,
        bottomJoint: joint0,
        topJoint: socketJoint,
      });

      const trunk: Trunk = {
        id: uuidv4(),
        modelId: objectId,
        rootId: rootId,
        segments: segments,
        contactCone: contactCone,
      };

      result.roots.push(root);
      result.trunks.push(trunk);

      hostsByLycheeId.set(id, {
        kind: 'trunk',
        shaftId: trunk.id,
        trunk,
        root,
      });
    }

    const unresolvedBranches = [...branchCandidates];
    let madeProgress = true;

    while (unresolvedBranches.length > 0 && madeProgress) {
      madeProgress = false;

      for (let i = unresolvedBranches.length - 1; i >= 0; i--) {
        const { id, s, parentIds } = unresolvedBranches[i];
        if (!s.base || !s.tip || parentIds.length === 0) {
          unresolvedBranches.splice(i, 1);
          continue;
        }

        const parentId = parentIds[0];
        const parentHost = hostsByLycheeId.get(parentId);
        if (!parentHost) {
          continue;
        }

        const pA = transformObjectPoint(s.base);
        const pB = transformObjectPoint(s.tip);

        const endpointRoles = pickAttachAndTipFromParentHints(s, parentId, parentHost, pA, pB);
        if (!endpointRoles) {
          console.warn(`[LysConverter] Child ${id} (object ${objectId}) could not project onto parent ${parentId}. Skipping.`);
          unresolvedBranches.splice(i, 1);
          continue;
        }

        const knotPos = endpointRoles.usedExplicitParentHint
          ? { x: endpointRoles.attachPoint.x, y: endpointRoles.attachPoint.y, z: endpointRoles.attachPoint.z }
          : endpointRoles.attachProjection.pointOnLine;

        const knot: Knot = {
          id: uuidv4(),
          parentShaftId: endpointRoles.attachProjection.parentShaftId,
          t: endpointRoles.attachProjection.t,
          pos: knotPos,
        };
        result.knots.push(knot);

        const tipSettings = pickContactTipSettings(s);
        const baseSettings = s.settings?.base;
        const tipLen = tipSettings?.length || tipDefaults.lengthMm;

        const knotPosVec = new THREE.Vector3(knot.pos.x, knot.pos.y, knot.pos.z);
        const totalDist = knotPosVec.distanceTo(endpointRoles.tipPoint);
        const shaftLength = totalDist - tipLen;
        const isLeafByGeometry = shaftLength <= 0.2;
        const isLeaf = isMiniSupport(s) || isLeafByGeometry;

        const transformedTipNormal = s.tipNormal ? transformObjectNormal(s.tipNormal) : null;
        const { socketJoint, contactCone } = createContactAssembly(
          s,
          endpointRoles.tipPoint,
          knot.pos,
          tipSettings,
          tipDefaults,
          mesh,
          true,
          true,
          transformedTipNormal
        );

        if (isLeaf) {
          socketJoint.pos = knot.pos;

          const conePosVec = new THREE.Vector3(contactCone.pos.x, contactCone.pos.y, contactCone.pos.z);
          const coneToKnot = knotPosVec.clone().sub(conePosVec);
          if (coneToKnot.lengthSq() > 1e-8) {
            const leafDir = coneToKnot.normalize();
            contactCone.normal = { x: leafDir.x, y: leafDir.y, z: leafDir.z };
          }

          const leafConeLength = Math.max(0.1, conePosVec.distanceTo(knotPosVec));
          contactCone.profile.lengthMm = leafConeLength;

          const tipEndpoint = inferLeafTipEndpoint(endpointRoles.tipPoint, pA, pB);
          const anchorEndpoint = tipEndpoint === 'tip' ? 'base' : 'tip';

          const contactDiameter = pickLeafEndpointDiameter(
            s,
            tipEndpoint,
            contactCone.profile.contactDiameterMm
          );
          const anchorDiameter = pickLeafEndpointDiameter(
            s,
            anchorEndpoint,
            contactCone.profile.bodyDiameterMm
          );

          contactCone.profile.contactDiameterMm = contactDiameter;
          contactCone.profile.bodyDiameterMm = anchorDiameter;

          contactCone.socketJointId = socketJoint.id;

          const leaf: Leaf = {
            id: uuidv4(),
            modelId: objectId,
            parentKnotId: knot.id,
            contactCone: contactCone,
          };

          result.leaves.push(leaf);
        } else {
          const pillarDiameter = baseSettings?.joinDiameter
            || tipSettings?.diameter
            || shaftDefaults.diameterMm;

          const segment: Segment = {
            id: uuidv4(),
            type: 'straight',
            diameter: pillarDiameter,
            bottomJoint: undefined,
            topJoint: socketJoint,
          };

          const branch: Branch = {
            id: uuidv4(),
            modelId: objectId,
            parentKnotId: knot.id,
            segments: [segment],
            contactCone: contactCone,
          };

          result.branches.push(branch);
          hostsByLycheeId.set(id, {
            kind: 'branch',
            shaftId: branch.id,
            branch,
            parentKnot: knot,
          });
        }

        unresolvedBranches.splice(i, 1);
        madeProgress = true;
      }
    }

    unresolvedBranches.forEach(({ id, parentIds }) => {
      const parentId = parentIds[0];
      console.warn(`[LysConverter] Child ${id} (object ${objectId}) refers to unknown/unprocessed parent ${String(parentId)}. Skipping.`);
    });

    for (const { s, parentIds } of braceCandidates) {
      if (parentIds.length < 2) continue;

      const parentAId = parentIds[0];
      const parentBId = parentIds[1];

      const hostA = hostsByLycheeId.get(parentAId);
      const hostB = hostsByLycheeId.get(parentBId);

      if (!hostA || !hostB) continue;

      const pA = transformObjectPoint(s.base);
      const pB = transformObjectPoint(s.tip);

      let pairing = pickBracePairing(hostA, hostB, pA, pB);
      if (!pairing) continue;

      let knotPosA: Vec3 = pairing.projA.pointOnLine;
      let knotPosB: Vec3 = pairing.projB.pointOnLine;

      const parentBaseId = typeof s.parentBaseId === 'string' ? s.parentBaseId : null;
      const parentTipId = typeof s.parentTipId === 'string' ? s.parentTipId : null;

      if (parentBaseId && parentTipId) {
        const hintedAttachA = parentBaseId === parentAId
          ? pA
          : parentTipId === parentAId
            ? pB
            : null;

        const hintedAttachB = parentBaseId === parentBId
          ? pA
          : parentTipId === parentBId
            ? pB
            : null;

        const hintedProjA = parentBaseId === parentAId
          ? projectPointToHost(hostA, pA)
          : parentTipId === parentAId
            ? projectPointToHost(hostA, pB)
            : null;

        const hintedProjB = parentBaseId === parentBId
          ? projectPointToHost(hostB, pA)
          : parentTipId === parentBId
            ? projectPointToHost(hostB, pB)
            : null;

        if (hintedAttachA && hintedAttachB && hintedProjA && hintedProjB) {
          pairing = { projA: hintedProjA, projB: hintedProjB };
          knotPosA = { x: hintedAttachA.x, y: hintedAttachA.y, z: hintedAttachA.z };
          knotPosB = { x: hintedAttachB.x, y: hintedAttachB.y, z: hintedAttachB.z };
        }
      }

      const knotA: Knot = {
        id: uuidv4(),
        parentShaftId: pairing.projA.parentShaftId,
        t: pairing.projA.t,
        pos: knotPosA,
      };

      const knotB: Knot = {
        id: uuidv4(),
        parentShaftId: pairing.projB.parentShaftId,
        t: pairing.projB.t,
        pos: knotPosB,
      };

      result.knots.push(knotA, knotB);

      const baseSettings = s.settings?.base;
      const braceDiameter = baseSettings?.joinDiameter || 0.5;

      const brace: Brace = {
        id: uuidv4(),
        modelId: objectId,
        startKnotId: knotA.id,
        endKnotId: knotB.id,
        profile: {
          diameter: braceDiameter,
        },
      };

      result.braces.push(brace);
    }

    applyWorldXYPlacementToSlice(result, sliceStart, pos.x, pos.y);
  }

  return result;
}

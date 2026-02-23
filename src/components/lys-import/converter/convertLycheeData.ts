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
import { buildSupportBraceData } from '../../../supports/SupportTypes/SupportBrace/supportBraceBuilder';
import type { SupportBraceBuildResult, SupportBracePlacementLayout } from '../../../supports/SupportTypes/SupportBrace/types';
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
import { quaternionFromGlobalEulerDegrees } from '@/utils/rotation';

export function convertLycheeData(data: LycheeData, settings: SupportSettings, mesh?: THREE.Mesh): DragonfruitImportFormat {
  const result: DragonfruitImportFormat & { supportBraces: SupportBraceBuildResult[] } = {
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
    supportBraces: [],
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
    const objectQuaternion = quaternionFromGlobalEulerDegrees(rot);

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
    const sourceSupportByLycheeId = new Map(supportsForObject.map(({ id, s }) => [id, s] as const));

    const twigCandidates: { id: string; s: LycheeSupport }[] = [];
    const stickCandidates: { id: string; s: LycheeSupport }[] = [];
    const rootCandidates: { id: string; s: LycheeSupport }[] = [];
    const branchCandidates: { id: string; s: LycheeSupport; parentIds: string[] }[] = [];
    const braceCandidates: { id: string; s: LycheeSupport; parentIds: string[] }[] = [];
    const supportBraceCandidates: { id: string; s: LycheeSupport; parentIds: string[] }[] = [];

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
        const parentBaseId = typeof s.parentBaseId === 'string' && s.parentBaseId.trim().length > 0
          ? s.parentBaseId.trim()
          : null;
        const parentTipId = typeof s.parentTipId === 'string' && s.parentTipId.trim().length > 0
          ? s.parentTipId.trim()
          : null;
        const explicitSingleParentHintCount = (parentBaseId ? 1 : 0) + (parentTipId ? 1 : 0);
        const hasExplicitSingleParentHint = explicitSingleParentHintCount >= 1;
        const baseIsGrounded = Number.isFinite(s.base?.z) && Math.abs((s.base?.z as number)) <= 0.2;
        const supportType = (s as any)?.type;
        // Lychee can encode single-parent support braces as either type 1 or type 0.
        const isSupportBraceSourceType = !Number.isFinite(supportType) || supportType === 1 || supportType === 0;

        if (hasExplicitSingleParentHint && baseIsGrounded && isSupportBraceSourceType && !isMiniSupport(s)) {
          supportBraceCandidates.push({ id, s, parentIds });
        } else {
          branchCandidates.push({ id, s, parentIds });
        }
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
      supportBraces: result.supportBraces.length,
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

        const projectedAttachPoint = new THREE.Vector3(
          endpointRoles.attachProjection.pointOnLine.x,
          endpointRoles.attachProjection.pointOnLine.y,
          endpointRoles.attachProjection.pointOnLine.z,
        );
        const authoredAttachDeltaMm = endpointRoles.attachPoint.distanceTo(projectedAttachPoint);
        const preserveAuthoredAttachPoint = endpointRoles.usedExplicitParentHint && authoredAttachDeltaMm <= 0.5;

        let knotPos = preserveAuthoredAttachPoint
          ? { x: endpointRoles.attachPoint.x, y: endpointRoles.attachPoint.y, z: endpointRoles.attachPoint.z }
          : endpointRoles.attachProjection.pointOnLine;

        if (endpointRoles.usedExplicitParentHint) {
          const sourceBaseZ = Number.isFinite(s.base?.z) ? (s.base?.z as number) : null;
          const sourceTipZ = Number.isFinite(s.tip?.z) ? (s.tip?.z as number) : null;
          const sourceTipMinusBase =
            sourceBaseZ !== null && sourceTipZ !== null ? (sourceTipZ - sourceBaseZ) : null;
          const importedTipMinusKnot = endpointRoles.tipPoint.z - knotPos.z;

          // Preserve Lychee endpoint-side ordering for explicit parent-hint branches.
          // If projection puts the knot on the opposite side of the branch tip, keep the authored attach point.
          if (
            sourceTipMinusBase !== null
            && Math.abs(sourceTipMinusBase) > 1e-4
            && sourceTipMinusBase * importedTipMinusKnot < 0
          ) {
            knotPos = {
              x: endpointRoles.attachPoint.x,
              y: endpointRoles.attachPoint.y,
              z: endpointRoles.attachPoint.z,
            };
          }
        }

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

    for (const { id, s, parentIds } of supportBraceCandidates) {
      if (!s.base || !s.tip || parentIds.length === 0) continue;

      const parentId = parentIds[0];
      const parentHost = hostsByLycheeId.get(parentId);
      if (!parentHost) {
        console.warn(`[LysConverter] Support brace candidate ${id} (object ${objectId}) refers to unknown parent ${String(parentId)}. Skipping.`);
        continue;
      }

      if (parentHost.kind === 'supportBrace') {
        console.warn(`[LysConverter] Support brace candidate ${id} (object ${objectId}) cannot attach to support-brace parent ${String(parentId)}. Skipping.`);
        continue;
      }

      const pA = transformObjectPoint(s.base);
      const pB = transformObjectPoint(s.tip);

      const endpointRoles = pickAttachAndTipFromParentHints(s, parentId, parentHost, pA, pB);
      if (!endpointRoles) {
        console.warn(`[LysConverter] Support brace candidate ${id} (object ${objectId}) could not project onto parent ${String(parentId)}. Skipping.`);
        continue;
      }

      const attachIsBaseEndpoint = endpointRoles.attachPoint === pA;
      const rootEndpoint = attachIsBaseEndpoint ? s.tip : s.base;
      const rootBaseWorld = transformRootBasePoint(rootEndpoint);

      let hostProjection = endpointRoles.attachProjection;
      const visibleJoinLength = Number.isFinite(s.settings?.base?.joinLength as number)
        ? Math.max(0, s.settings?.base?.joinLength as number)
        : null;
      const parentVisibleJoinLength = Number.isFinite(sourceSupportByLycheeId.get(parentId)?.settings?.base?.joinLength as number)
        ? Math.max(0, sourceSupportByLycheeId.get(parentId)?.settings?.base?.joinLength as number)
        : null;
      const targetAttachHeight = Math.max(visibleJoinLength ?? 0, parentVisibleJoinLength ?? 0);

      // Lychee support braces are rooted columns. When joinLength is authored,
      // seek host contact near that column height to avoid collapsing the host
      // attach point to a low endpoint-only projection.
      if (targetAttachHeight > 1e-4) {
        const joinHeightProbe = new THREE.Vector3(
          endpointRoles.attachPoint.x,
          endpointRoles.attachPoint.y,
          rootBaseWorld.z + targetAttachHeight,
        );
        const joinHeightProjection = projectPointToHost(parentHost, joinHeightProbe);
        if (joinHeightProjection) {
          hostProjection = joinHeightProjection;
        }
      }

      let hostDiameterMm = shaftDefaults.diameterMm;
      if (parentHost.kind === 'trunk') {
        const hostSeg = parentHost.trunk.segments.find((seg) => seg.id === hostProjection.parentShaftId);
        if (hostSeg?.diameter && Number.isFinite(hostSeg.diameter)) hostDiameterMm = hostSeg.diameter;
      } else {
        const hostSeg = parentHost.branch.segments.find((seg: Segment) => seg.id === hostProjection.parentShaftId);
        if (hostSeg?.diameter && Number.isFinite(hostSeg.diameter)) hostDiameterMm = hostSeg.diameter;
      }

      const hostPos = hostProjection.pointOnLine;

      let layoutOverrides: Partial<SupportBracePlacementLayout> | undefined;
      if (Number.isFinite(visibleJoinLength as number) && (visibleJoinLength as number) > 1e-4) {
        const rootTopZ = rootBaseWorld.z + rootDefaults.diskHeightMm + rootDefaults.coneHeightMm;
        const hostRise = hostPos.z - rootTopZ;
        const desiredColumnTopZ = rootBaseWorld.z + (visibleJoinLength as number);

        if (Number.isFinite(hostRise) && hostRise > 1e-4) {
          const desiredSecondRatioRaw = (desiredColumnTopZ - rootTopZ) / hostRise;
          const desiredSecondRatio = THREE.MathUtils.clamp(desiredSecondRatioRaw, 0.3, 0.95);
          const desiredFirstRatio = THREE.MathUtils.clamp(desiredSecondRatio * 0.55, 0.1, desiredSecondRatio - 0.01);

          layoutOverrides = {
            firstJointHeightRatio: desiredFirstRatio,
            secondJointHeightRatio: desiredSecondRatio,
          };
        }
      }

      const build = buildSupportBraceData({
        modelId: objectId,
        rootPos: {
          x: rootBaseWorld.x,
          y: rootBaseWorld.y,
          z: rootBaseWorld.z,
        },
        host: {
          segmentId: hostProjection.parentShaftId,
          supportKind: parentHost.kind,
          t: hostProjection.t,
          pos: hostPos,
          diameterMm: hostDiameterMm,
          minT: 0,
        },
        layoutOverrides,
      });

      result.supportBraces.push(build);
      hostsByLycheeId.set(id, {
        kind: 'supportBrace',
        shaftId: build.supportBrace.id,
        supportBrace: build.supportBrace,
        root: build.root,
        hostKnot: build.hostKnot,
      });
    }

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
      const braceTipBodyDiameter = s.settings?.tip?.diameter;
      const braceBaseTipBodyDiameter = s.settings?.baseTip?.diameter;
      const braceDiameter =
        (Number.isFinite(braceTipBodyDiameter as number) && (braceTipBodyDiameter as number) > 0
          ? (braceTipBodyDiameter as number)
          : Number.isFinite(braceBaseTipBodyDiameter as number) && (braceBaseTipBodyDiameter as number) > 0
            ? (braceBaseTipBodyDiameter as number)
            : Number.isFinite(baseSettings?.joinDiameter as number) && (baseSettings?.joinDiameter as number) > 0
              ? (baseSettings?.joinDiameter as number)
              : 0.5);

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

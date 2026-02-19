import * as THREE from 'three';
import {
  DragonfruitImportFormat,
  Joint,
} from '../../supports/types';
import { SupportSettings } from '../../supports/Settings';
import { convertLycheeData } from './converter/convertLycheeData';
import { LycheeData } from './converter/types';

export class LysConverter {

  static reassignModelId(data: DragonfruitImportFormat, modelId: string): void {
    if (!modelId) return;

    for (const root of data.roots) root.modelId = modelId;
    for (const trunk of data.trunks) trunk.modelId = modelId;
    for (const branch of data.branches) branch.modelId = modelId;
    for (const leaf of data.leaves) leaf.modelId = modelId;
    for (const twig of data.twigs || []) twig.modelId = modelId;
    for (const stick of data.sticks || []) stick.modelId = modelId;
    for (const brace of data.braces) brace.modelId = modelId;
    for (const supportBraceBuild of data.supportBraces || []) {
      supportBraceBuild.root.modelId = modelId;
      supportBraceBuild.supportBrace.modelId = modelId;
    }
  }

  static applyWorldXYPlacement(data: DragonfruitImportFormat, offsetX: number, offsetY: number): void {
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

    for (const root of data.roots) {
      shiftPos(root.transform?.pos);
    }

    for (const trunk of data.trunks) {
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

    for (const branch of data.branches) {
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

    for (const leaf of data.leaves) {
      shiftPos(leaf.contactCone?.pos);
    }

    for (const twig of data.twigs || []) {
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

    for (const stick of data.sticks || []) {
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

    for (const knot of data.knots) {
      shiftPos(knot.pos);
    }

    for (const supportBraceBuild of data.supportBraces || []) {
      shiftPos(supportBraceBuild.root.transform?.pos);
      shiftPos(supportBraceBuild.hostKnot.pos);
      for (const seg of supportBraceBuild.supportBrace.segments) {
        shiftJoint(seg.bottomJoint);
        shiftJoint(seg.topJoint);
        if (seg.type === 'bezier') {
          shiftPos(seg.controlPoint1 as { x: number; y: number } | undefined);
          shiftPos(seg.controlPoint2 as { x: number; y: number } | undefined);
        }
      }
    }
  }

  static convert(data: LycheeData, settings: SupportSettings, mesh?: THREE.Mesh): DragonfruitImportFormat {
    return convertLycheeData(data, settings, mesh);
  }
}

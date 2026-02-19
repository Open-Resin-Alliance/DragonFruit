import {
  Roots,
  Trunk,
  Branch,
  Knot,
} from '../../../supports/types';
import type { SupportBrace } from '../../../supports/SupportTypes/SupportBrace/types';

export interface LycheeVector {
  x: number;
  y: number;
  z: number;
}

export interface LycheeSupportSettings {
  tip?: {
    length?: number;
    angle?: number;
    diameter?: number;
    pointDiameter?: number;
  };
  base?: {
    length?: number;
    diameter?: number;
    joinDiameter?: number;
    joinLength?: number;
    newJoinLength?: number;
    joinCone?: number;
  };
  baseTip?: {
    length?: number;
    diameter?: number;
    pointDiameter?: number;
    isStraight?: boolean;
  };
  isStraight?: boolean;
}

export interface LycheeSupport {
  id: string;
  base: LycheeVector;
  tip: LycheeVector;
  isBaseTip?: boolean;
  baseNormal?: LycheeVector;
  tipNormal?: LycheeVector;
  mini?: boolean;
  settings?: LycheeSupportSettings;
  objectIdTip?: string | number | null;
  objectIdBase?: string | number | null;
  parentId?: string[];
  parentBaseId?: string | null;
  parentTipId?: string | null;
}

export interface LycheeObject {
  id: string;
  center?: LycheeVector;
  formerCenter?: LycheeVector;
  position?: LycheeVector;
  rotation?: LycheeVector;
  scale?: LycheeVector;
  supportsBase?: string[];
}

export interface LycheeData {
  objects?: { present?: { byId?: Record<string, LycheeObject> } };
  supports?: { present?: { byId?: Record<string, LycheeSupport> } };
}

export type HostEntry =
  | { kind: 'trunk'; shaftId: string; trunk: Trunk; root: Roots }
  | { kind: 'branch'; shaftId: string; branch: Branch; parentKnot: Knot }
  | { kind: 'supportBrace'; shaftId: string; supportBrace: SupportBrace; root: Roots; hostKnot: Knot };

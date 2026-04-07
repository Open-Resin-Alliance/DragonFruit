import React from 'react';
import * as THREE from 'three';
import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot } from './state';
import { getRaftSettings, subscribeToRaftStore } from './Rafts/Crenelated/RaftState';
import { JOINT_DIAMETER_OFFSET_MM } from './constants';
import { useKickstandStoreState } from './SupportTypes/Kickstand/kickstandStore';
import { InstancedShaftGroup, type InstancedShaft } from './SupportPrimitives/Shaft/InstancedShaftGroup';
import { InstancedRootsGroup, type InstancedRoot } from './SupportPrimitives/Roots/InstancedRootsGroup';
import { InstancedJointGroup, type InstancedJoint } from './SupportPrimitives/Joint/InstancedJointGroup';
import { InstancedContactConeGroup, type InstancedContactCone } from './SupportPrimitives/ContactCone/InstancedContactConeGroup';
import { getFinalSocketPosition } from './SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from './SupportPrimitives/ContactDisk/contactDiskUtils';
import { emitSupportModelPointerHover } from './interaction/clickHandlers';
import type { ContactDisk, Vec3 } from './types';

interface SupportProxyMeshLayerProps {
  mode?: 'prepare' | 'analysis' | 'support' | 'export' | 'printing';
  clipLower?: number | null;
  clipUpper?: number | null;
  supportColorsByModelId?: Record<string, string>;
  activeModelId?: string | null;
  selectedModelIds?: string[];
  hoverModelId?: string | null;
  hoverTintColor?: string;
  hoverTintStrength?: number;
  modelFilterId?: string | null;
  excludeModelId?: string | null;
  excludeModelIds?: string[];
  modelDropOffsetsById?: Record<string, number>;
  ghostOpacity?: number;
  showOutOfBoundsOverlay?: boolean;
  outOfBoundsMin?: THREE.Vector3 | null;
  outOfBoundsMax?: THREE.Vector3 | null;
  outOfBoundsStripeColor?: string;
  onModelPointerSelect?: (modelId: string) => void;
  enablePointerSelection?: boolean;
  includeDetailedPrimitives?: boolean;
}

const DEFAULT_SUPPORT_COLOR = '#9a9a9a';
const ACTIVE_SUPPORT_COLOR = '#c8752a';
const PROXY_JOINT_DIAMETER_BLEND_MM = JOINT_DIAMETER_OFFSET_MM * 0.75;

type ProxyModelGeometry = {
  modelId?: string;
  shafts: InstancedShaft[];
  roots: InstancedRoot[];
  joints: InstancedJoint[];
  cones: InstancedContactCone[];
};

type VisibleModelEntry = {
  modelKey: string;
  modelId?: string;
  zOffset: number;
  geometry: ProxyModelGeometry;
};

type FlatProxyGeometry = {
  shafts: InstancedShaft[];
  roots: InstancedRoot[];
  joints: InstancedJoint[];
  cones: InstancedContactCone[];
};

type SharedProxyCacheEntry = {
  supportTrunksRef: ReturnType<typeof getSnapshot>['trunks'];
  supportRootsRef: ReturnType<typeof getSnapshot>['roots'];
  supportKnotsRef: ReturnType<typeof getSnapshot>['knots'];
  supportBranchesRef: ReturnType<typeof getSnapshot>['branches'];
  supportLeavesRef: ReturnType<typeof getSnapshot>['leaves'];
  supportTwigsRef: ReturnType<typeof getSnapshot>['twigs'];
  supportSticksRef: ReturnType<typeof getSnapshot>['sticks'];
  supportBracesRef: ReturnType<typeof getSnapshot>['braces'];
  kickstandKickstandsRef: ReturnType<typeof useKickstandStoreState>['kickstands'];
  kickstandRootsRef: ReturnType<typeof useKickstandStoreState>['roots'];
  kickstandKnotsRef: ReturnType<typeof useKickstandStoreState>['knots'];
  hasSolidBottom: boolean;
  raftThickness: number;
  includeDetailedPrimitives: boolean;
  baseProxyByModel: Map<string, ProxyModelGeometry>;
};

let sharedProxyCache: SharedProxyCacheEntry | null = null;

const MODEL_NONE_KEY = '__none__';

function toModelKey(modelId?: string): string {
  return modelId ?? MODEL_NONE_KEY;
}

function fromModelKey(modelKey: string): string | undefined {
  return modelKey === MODEL_NONE_KEY ? undefined : modelKey;
}

function getDiskTipCenter(disk: ContactDisk): Vec3 {
  const thickness = disk.diskLengthOverride ?? calculateDiskThickness(disk.surfaceNormal, disk.coneAxis, disk.profile);
  return {
    x: disk.pos.x + (disk.surfaceNormal.x * thickness),
    y: disk.pos.y + (disk.surfaceNormal.y * thickness),
    z: disk.pos.z + (disk.surfaceNormal.z * thickness),
  };
}

export function SupportProxyMeshLayer({
  mode,
  clipLower,
  clipUpper,
  activeModelId = null,
  selectedModelIds = [],
  hoverModelId = null,
  hoverTintColor = '#d18a4a',
  hoverTintStrength = 0.35,
  modelFilterId = null,
  excludeModelId = null,
  excludeModelIds = [],
  modelDropOffsetsById,
  ghostOpacity = 1,
  showOutOfBoundsOverlay = false,
  outOfBoundsMin = null,
  outOfBoundsMax = null,
  outOfBoundsStripeColor,
  onModelPointerSelect,
  enablePointerSelection = true,
  includeDetailedPrimitives = true,
}: SupportProxyMeshLayerProps) {
  const supportState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const raftSettings = useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);
  const kickstandState = useKickstandStoreState();
  const supportTrunks = supportState.trunks;
  const supportRoots = supportState.roots;
  const supportKnots = supportState.knots;
  const supportBranches = supportState.branches;
  const supportLeaves = supportState.leaves;
  const supportTwigs = supportState.twigs;
  const supportSticks = supportState.sticks;
  const supportBraces = supportState.braces;
  const kickstandKickstands = kickstandState.kickstands;
  const kickstandRoots = kickstandState.roots;
  const kickstandKnots = kickstandState.knots;
  const hasSolidBottom = raftSettings.bottomMode === 'solid';
  const raftThickness = raftSettings.thickness ?? 0;

  const excludedModelIdSet = React.useMemo(
    () => new Set(excludeModelIds.filter((id): id is string => Boolean(id))),
    [excludeModelIds],
  );
  const lastSupportHoverModelIdRef = React.useRef<string | null>(null);
  const hoverClearRafRef = React.useRef<number | null>(null);

  const resolveModelVisible = React.useCallback((modelId?: string) => {
    if (modelFilterId && modelId !== modelFilterId) return false;
    if (excludeModelId && modelId === excludeModelId) return false;
    if (modelId && excludedModelIdSet.has(modelId)) return false;
    return true;
  }, [excludedModelIdSet, excludeModelId, modelFilterId]);

  const clippingPlanes = React.useMemo(() => {
    const planes: THREE.Plane[] = [];
    if (clipLower != null) planes.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), -clipLower));
    if (clipUpper != null) planes.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), clipUpper));
    return planes.length > 0 ? planes : null;
  }, [clipLower, clipUpper]);

  const outOfBoundsMaterial = React.useMemo(() => {
    if (!showOutOfBoundsOverlay || !outOfBoundsMin || !outOfBoundsMax) return null;

    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      uniforms: {
        boundsMin: { value: outOfBoundsMin.clone() },
        boundsMax: { value: outOfBoundsMax.clone() },
        stripeFreq: { value: 0.22 },
        stripeAlpha: { value: 0.42 },
        stripeColor: { value: new THREE.Color(outOfBoundsStripeColor ?? '#b6ff2e') },
      },
      vertexShader: `
        varying vec3 vWorldPos;
        void main() {
          vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vWorldPos = worldPos.xyz;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        varying vec3 vWorldPos;
        uniform vec3 boundsMin;
        uniform vec3 boundsMax;
        uniform float stripeFreq;
        uniform float stripeAlpha;
        uniform vec3 stripeColor;

        void main() {
          bool outside =
            vWorldPos.x < boundsMin.x || vWorldPos.x > boundsMax.x ||
            vWorldPos.y < boundsMin.y || vWorldPos.y > boundsMax.y ||
            vWorldPos.z < boundsMin.z || vWorldPos.z > boundsMax.z;

          if (!outside) discard;

          float stripeSeed = (vWorldPos.x + vWorldPos.y + vWorldPos.z) * stripeFreq;
          float band = step(0.5, fract(stripeSeed));
          vec3 colorA = stripeColor;
          vec3 colorB = vec3(1.0, 1.0, 1.0);
          vec3 color = mix(colorA, colorB, band);

          gl_FragColor = vec4(color, stripeAlpha);
        }
      `,
    });
  }, [outOfBoundsMax, outOfBoundsMin, outOfBoundsStripeColor, showOutOfBoundsOverlay]);

  React.useEffect(() => {
    return () => {
      outOfBoundsMaterial?.dispose();
    };
  }, [outOfBoundsMaterial]);

  const baseProxyByModel = React.useMemo(() => {
    if (
      sharedProxyCache
      && sharedProxyCache.supportTrunksRef === supportTrunks
      && sharedProxyCache.supportRootsRef === supportRoots
      && sharedProxyCache.supportKnotsRef === supportKnots
      && sharedProxyCache.supportBranchesRef === supportBranches
      && sharedProxyCache.supportLeavesRef === supportLeaves
      && sharedProxyCache.supportTwigsRef === supportTwigs
      && sharedProxyCache.supportSticksRef === supportSticks
      && sharedProxyCache.supportBracesRef === supportBraces
      && sharedProxyCache.kickstandKickstandsRef === kickstandKickstands
      && sharedProxyCache.kickstandRootsRef === kickstandRoots
      && sharedProxyCache.kickstandKnotsRef === kickstandKnots
      && sharedProxyCache.hasSolidBottom === hasSolidBottom
      && sharedProxyCache.raftThickness === raftThickness
      && sharedProxyCache.includeDetailedPrimitives === includeDetailedPrimitives
    ) {
      return sharedProxyCache.baseProxyByModel;
    }

    const byModel = new Map<string, ProxyModelGeometry>();
    const segmentModelIdById = new Map<string, string | undefined>();
    const segmentSupportIdById = new Map<string, string | undefined>();
    const leafModelIdById = new Map<string, string | undefined>();
    const leafSupportIdById = new Map<string, string | undefined>();
    const seenJointKeysByModel = new Map<string, Set<string>>();
    const seenConeKeysByModel = new Map<string, Set<string>>();

    const ensureModel = (modelId?: string): ProxyModelGeometry => {
      const key = toModelKey(modelId);
      let existing = byModel.get(key);
      if (!existing) {
        existing = { modelId, shafts: [], roots: [], joints: [], cones: [] };
        byModel.set(key, existing);
      }
      return existing;
    };

    const ensureJointSeenSet = (modelId?: string): Set<string> => {
      const key = toModelKey(modelId);
      const existing = seenJointKeysByModel.get(key);
      if (existing) return existing;
      const created = new Set<string>();
      seenJointKeysByModel.set(key, created);
      return created;
    };

    const ensureConeSeenSet = (modelId?: string): Set<string> => {
      const key = toModelKey(modelId);
      const existing = seenConeKeysByModel.get(key);
      if (existing) return existing;
      const created = new Set<string>();
      seenConeKeysByModel.set(key, created);
      return created;
    };

    const registerSegmentMeta = (segmentId: string, modelId?: string, supportId?: string) => {
      segmentModelIdById.set(segmentId, modelId);
      segmentSupportIdById.set(segmentId, supportId);
    };

    const pushShaft = (shaft: InstancedShaft) => {
      ensureModel(shaft.modelId).shafts.push(shaft);
      registerSegmentMeta(shaft.id, shaft.modelId, shaft.supportId);
    };

    const pushRoot = (root: InstancedRoot) => {
      const effectiveDiskHeight = hasSolidBottom
        ? 0.05
        : Math.max(0.001, root.effectiveDiskHeight);
      const verticalOffset = hasSolidBottom
        ? Math.max(raftThickness - effectiveDiskHeight, 0)
        : 0;

      ensureModel(root.modelId).roots.push({
        ...root,
        basePos: {
          x: root.basePos.x,
          y: root.basePos.y,
          z: root.basePos.z + verticalOffset,
        },
        effectiveDiskHeight,
      });
    };

    const pushJoint = (joint: InstancedJoint, dedupeKey?: string, diameterBlendMm: number = PROXY_JOINT_DIAMETER_BLEND_MM) => {
      const seen = ensureJointSeenSet(joint.modelId);
      const key = dedupeKey ?? joint.id;
      if (seen.has(key)) return;
      seen.add(key);
      ensureModel(joint.modelId).joints.push({
        ...joint,
        diameter: Math.max(0.001, joint.diameter - diameterBlendMm),
      });
    };

    const pushCone = (cone: InstancedContactCone, dedupeKey?: string) => {
      const seen = ensureConeSeenSet(cone.modelId);
      const key = dedupeKey ?? cone.id;
      if (seen.has(key)) return;
      seen.add(key);
      ensureModel(cone.modelId).cones.push(cone);
    };

    for (const trunk of Object.values(supportTrunks)) {
      const root = supportRoots[trunk.rootId];
      if (!root) continue;

      if (includeDetailedPrimitives && trunk.contactCone) {
        pushCone({
          ...trunk.contactCone,
          supportId: trunk.id,
          modelId: trunk.modelId,
        });
      }

      pushRoot({
        id: root.id,
        supportId: trunk.id,
        modelId: trunk.modelId,
        basePos: root.transform.pos,
        bottomRadius: Math.max(0.001, root.diameter / 2),
        topRadius: Math.max(0.001, (trunk.segments[0]?.diameter ?? root.diameter) / 2),
        effectiveDiskHeight: Math.max(0.001, root.diskHeight),
        coneHeight: Math.max(0, root.coneHeight),
      });

      let currentStart: Vec3 = {
        x: root.transform.pos.x,
        y: root.transform.pos.y,
        z: root.transform.pos.z + root.diskHeight + root.coneHeight,
      };

      for (const segment of trunk.segments) {
        if (includeDetailedPrimitives && segment.bottomJoint) {
          pushJoint({
            id: segment.bottomJoint.id,
            pos: segment.bottomJoint.pos,
            diameter: segment.bottomJoint.diameter,
            supportId: trunk.id,
            modelId: trunk.modelId,
          });
        }

        if (segment.bottomJoint) currentStart = segment.bottomJoint.pos;
        const end = segment.topJoint?.pos
          ?? (trunk.contactCone ? getFinalSocketPosition(trunk.contactCone) : { x: currentStart.x, y: currentStart.y, z: currentStart.z + 5 });

        pushShaft({
          id: segment.id,
          supportId: trunk.id,
          modelId: trunk.modelId,
          start: currentStart,
          end,
          diameter: segment.diameter,
        });

        if (includeDetailedPrimitives && segment.topJoint) {
          pushJoint({
            id: segment.topJoint.id,
            pos: segment.topJoint.pos,
            diameter: segment.topJoint.diameter,
            supportId: trunk.id,
            modelId: trunk.modelId,
          });
        }

        currentStart = end;
      }
    }

    for (const branch of Object.values(supportBranches)) {
      const parentKnot = supportKnots[branch.parentKnotId];
      if (!parentKnot) continue;

      if (includeDetailedPrimitives && branch.contactCone) {
        pushCone({
          ...branch.contactCone,
          supportId: branch.id,
          modelId: branch.modelId,
        });
      }

      let currentStart: Vec3 = parentKnot.pos;

      for (const segment of branch.segments) {
        if (includeDetailedPrimitives && segment.bottomJoint) {
          pushJoint({
            id: segment.bottomJoint.id,
            pos: segment.bottomJoint.pos,
            diameter: segment.bottomJoint.diameter,
            supportId: branch.id,
            modelId: branch.modelId,
          });
        }

        const end = segment.topJoint?.pos
          ?? (branch.contactCone ? getFinalSocketPosition(branch.contactCone) : { x: currentStart.x, y: currentStart.y, z: currentStart.z + 5 });

        pushShaft({
          id: segment.id,
          supportId: branch.id,
          modelId: branch.modelId,
          start: currentStart,
          end,
          diameter: segment.diameter,
        });

        if (includeDetailedPrimitives && segment.topJoint) {
          pushJoint({
            id: segment.topJoint.id,
            pos: segment.topJoint.pos,
            diameter: segment.topJoint.diameter,
            supportId: branch.id,
            modelId: branch.modelId,
          });
        }

        currentStart = end;
      }
    }

    if (includeDetailedPrimitives) {
      for (const leaf of Object.values(supportLeaves)) {
        leafModelIdById.set(leaf.id, leaf.modelId);
        leafSupportIdById.set(leaf.id, leaf.id);
        pushCone({
          ...leaf.contactCone,
          supportId: leaf.id,
          modelId: leaf.modelId,
        });
      }
    }

    for (const twig of Object.values(supportTwigs)) {
      for (const segment of twig.segments) {
        if (includeDetailedPrimitives && segment.bottomJoint) {
          pushJoint({
            id: segment.bottomJoint.id,
            pos: segment.bottomJoint.pos,
            diameter: segment.bottomJoint.diameter,
            supportId: twig.id,
            modelId: twig.modelId,
          });
        }

        const start = segment.bottomJoint?.pos ?? getDiskTipCenter(twig.contactDiskA);
        const end = segment.topJoint?.pos ?? getDiskTipCenter(twig.contactDiskB);

        pushShaft({
          id: segment.id,
          supportId: twig.id,
          modelId: twig.modelId,
          start,
          end,
          diameter: segment.diameter,
        });

        if (includeDetailedPrimitives && segment.topJoint) {
          pushJoint({
            id: segment.topJoint.id,
            pos: segment.topJoint.pos,
            diameter: segment.topJoint.diameter,
            supportId: twig.id,
            modelId: twig.modelId,
          });
        }
      }
    }

    for (const stick of Object.values(supportSticks)) {
      if (includeDetailedPrimitives) {
        pushCone({
          ...stick.contactConeA,
          supportId: stick.id,
          modelId: stick.modelId,
        });
        pushCone({
          ...stick.contactConeB,
          supportId: stick.id,
          modelId: stick.modelId,
        });
      }

      for (const segment of stick.segments) {
        if (includeDetailedPrimitives && segment.bottomJoint) {
          pushJoint({
            id: segment.bottomJoint.id,
            pos: segment.bottomJoint.pos,
            diameter: segment.bottomJoint.diameter,
            supportId: stick.id,
            modelId: stick.modelId,
          });
        }

        const start = segment.bottomJoint?.pos ?? getFinalSocketPosition(stick.contactConeA);
        const end = segment.topJoint?.pos ?? getFinalSocketPosition(stick.contactConeB);

        pushShaft({
          id: segment.id,
          supportId: stick.id,
          modelId: stick.modelId,
          start,
          end,
          diameter: segment.diameter,
        });

        if (includeDetailedPrimitives && segment.topJoint) {
          pushJoint({
            id: segment.topJoint.id,
            pos: segment.topJoint.pos,
            diameter: segment.topJoint.diameter,
            supportId: stick.id,
            modelId: stick.modelId,
          });
        }
      }
    }

    for (const brace of Object.values(supportBraces)) {
      const startKnot = supportKnots[brace.startKnotId];
      const endKnot = supportKnots[brace.endKnotId];
      if (!startKnot || !endKnot) continue;

      // Mirror SupportRenderer: derive visual diameter from host knot diameters (= trunk segment
      // diameter + 0.1mm offset). Using profile.diameter alone produces the thin brace setting
      // value and loses the dynamic sizing that matches the attached trunk thickness.
      const profileDiameter = Math.max(0.001, brace.profile?.diameter ?? 1);
      const startHostDiameter = Math.max(
        0.001,
        (startKnot.diameter ?? (profileDiameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM,
      );
      const endHostDiameter = Math.max(
        0.001,
        (endKnot.diameter ?? (profileDiameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM,
      );

      pushShaft({
        id: `braceSegment:${brace.id}`,
        supportId: brace.id,
        modelId: brace.modelId,
        start: startKnot.pos,
        end: endKnot.pos,
        diameter: (startHostDiameter + endHostDiameter) * 0.5,
      });
    }

    // Knots are interaction affordances (branch/brace attachment point drag handles) rendered
    // only for selected supports in the full SupportRenderer. Omitting them from the proxy
    // avoids visible hemisphere bumps at every trunk segment split point.

    for (const kickstand of Object.values(kickstandKickstands)) {
      const root = kickstandRoots[kickstand.rootId];
      const hostKnot = kickstandKnots[kickstand.hostKnotId];
      if (!root || !hostKnot) continue;

      pushRoot({
        id: root.id,
        supportId: kickstand.id,
        modelId: kickstand.modelId,
        basePos: root.transform.pos,
        bottomRadius: Math.max(0.001, root.diameter / 2),
        topRadius: Math.max(0.001, (kickstand.segments[0]?.diameter ?? root.diameter) / 2),
        effectiveDiskHeight: Math.max(0.001, root.diskHeight),
        coneHeight: Math.max(0, root.coneHeight),
      });

      let currentStart: Vec3 = {
        x: root.transform.pos.x,
        y: root.transform.pos.y,
        z: root.transform.pos.z + root.diskHeight + root.coneHeight,
      };

      for (const segment of kickstand.segments) {
        if (includeDetailedPrimitives && segment.bottomJoint) {
          pushJoint({
            id: segment.bottomJoint.id,
            pos: segment.bottomJoint.pos,
            diameter: segment.bottomJoint.diameter,
            supportId: kickstand.id,
            modelId: kickstand.modelId,
          });
        }

        const end = segment.topJoint?.pos ?? hostKnot.pos;
        pushShaft({
          id: segment.id,
          supportId: kickstand.id,
          modelId: kickstand.modelId,
          start: currentStart,
          end,
          diameter: segment.diameter,
        });

        if (includeDetailedPrimitives && segment.topJoint) {
          pushJoint({
            id: segment.topJoint.id,
            pos: segment.topJoint.pos,
            diameter: segment.topJoint.diameter,
            supportId: kickstand.id,
            modelId: kickstand.modelId,
          });
        }

        currentStart = end;
      }
    }

    // Kickstand host knots are also interaction affordances — omitted from proxy for the same reason.

    sharedProxyCache = {
      supportTrunksRef: supportTrunks,
      supportRootsRef: supportRoots,
      supportKnotsRef: supportKnots,
      supportBranchesRef: supportBranches,
      supportLeavesRef: supportLeaves,
      supportTwigsRef: supportTwigs,
      supportSticksRef: supportSticks,
      supportBracesRef: supportBraces,
      kickstandKickstandsRef: kickstandKickstands,
      kickstandRootsRef: kickstandRoots,
      kickstandKnotsRef: kickstandKnots,
      hasSolidBottom,
      raftThickness,
      includeDetailedPrimitives,
      baseProxyByModel: byModel,
    };

    return byModel;
  }, [
    supportTrunks,
    supportRoots,
    supportKnots,
    supportBranches,
    supportLeaves,
    supportTwigs,
    supportSticks,
    supportBraces,
    kickstandKickstands,
    kickstandRoots,
    kickstandKnots,
    hasSolidBottom,
    raftThickness,
    includeDetailedPrimitives,
  ]);

  const modelEntries = React.useMemo(() => {
    if (modelFilterId) {
      const modelKey = toModelKey(modelFilterId);
      const geometry = baseProxyByModel.get(modelKey);
      return geometry ? [[modelKey, geometry] as const] : [];
    }
    return Array.from(baseProxyByModel.entries());
  }, [baseProxyByModel, modelFilterId]);

  const visibleModelEntries = React.useMemo<VisibleModelEntry[]>(() => {
    const visible: VisibleModelEntry[] = [];
    for (const [modelKey, geometry] of modelEntries) {
      const modelId = fromModelKey(modelKey);
      if (!resolveModelVisible(modelId)) continue;

      visible.push({
        modelKey,
        modelId,
        geometry,
        zOffset: modelId ? (modelDropOffsetsById?.[modelId] ?? 0) : 0,
      });
    }
    return visible;
  }, [modelEntries, resolveModelVisible, modelDropOffsetsById]);

  const highlightedModelIdSet = React.useMemo(() => {
    const ids = new Set<string>();
    for (const id of selectedModelIds) ids.add(id);
    return ids;
  }, [selectedModelIds]);

  const effectiveHoverModelId = hoverModelId;

  const hoveredOverlayColor = ACTIVE_SUPPORT_COLOR;

  const flattenedGeometry = React.useMemo(() => {
    const createEmpty = (): FlatProxyGeometry => ({ shafts: [], roots: [], joints: [], cones: [] });
    const base = createEmpty();
    const highlighted = createEmpty();

    const appendShaft = (target: FlatProxyGeometry, shaft: InstancedShaft, zOffset: number) => {
      if (Math.abs(zOffset) < 1e-6) {
        target.shafts.push(shaft);
        return;
      }
      target.shafts.push({
        ...shaft,
        start: { x: shaft.start.x, y: shaft.start.y, z: shaft.start.z + zOffset },
        end: { x: shaft.end.x, y: shaft.end.y, z: shaft.end.z + zOffset },
      });
    };

    const appendRoot = (target: FlatProxyGeometry, root: InstancedRoot, zOffset: number) => {
      if (Math.abs(zOffset) < 1e-6) {
        target.roots.push(root);
        return;
      }
      target.roots.push({
        ...root,
        basePos: { x: root.basePos.x, y: root.basePos.y, z: root.basePos.z + zOffset },
      });
    };

    const appendJoint = (target: FlatProxyGeometry, joint: InstancedJoint, zOffset: number) => {
      if (Math.abs(zOffset) < 1e-6) {
        target.joints.push(joint);
        return;
      }
      target.joints.push({
        ...joint,
        pos: { x: joint.pos.x, y: joint.pos.y, z: joint.pos.z + zOffset },
      });
    };

    const appendCone = (target: FlatProxyGeometry, cone: InstancedContactCone, zOffset: number) => {
      if (Math.abs(zOffset) < 1e-6) {
        target.cones.push(cone);
        return;
      }
      target.cones.push({
        ...cone,
        pos: { x: cone.pos.x, y: cone.pos.y, z: cone.pos.z + zOffset },
      });
    };

    for (const entry of visibleModelEntries) {
      const target = entry.modelId && highlightedModelIdSet.has(entry.modelId) ? highlighted : base;
      const zOffset = entry.zOffset;

      for (const shaft of entry.geometry.shafts) appendShaft(target, shaft, zOffset);
      for (const root of entry.geometry.roots) appendRoot(target, root, zOffset);
      if (includeDetailedPrimitives) {
        for (const joint of entry.geometry.joints) appendJoint(target, joint, zOffset);
        for (const cone of entry.geometry.cones) appendCone(target, cone, zOffset);
      }
    }

    return { base, highlighted };
  }, [visibleModelEntries, highlightedModelIdSet, includeDetailedPrimitives]);

  const proxyOpacity = Math.max(0.05, Math.min(1, ghostOpacity));
  const proxyTransparent = proxyOpacity < 0.999;
  const hoverOverlayOpacity = React.useMemo(() => {
    const hoverAlpha = Math.max(0.05, Math.min(1, hoverTintStrength));
    return Math.max(0.05, Math.min(1, proxyOpacity * hoverAlpha));
  }, [hoverTintStrength, proxyOpacity]);
  const hoverOverlayTransparent = hoverOverlayOpacity < 0.999;

  const pointerHoverEnabled = enablePointerSelection && mode === 'prepare';
  const pointerSelectionEnabled = enablePointerSelection && mode === 'prepare' && !!onModelPointerSelect;

  const setSupportHoverModel = React.useCallback((nextModelId: string | null) => {
    if (hoverClearRafRef.current !== null) {
      cancelAnimationFrame(hoverClearRafRef.current);
      hoverClearRafRef.current = null;
    }

    if (lastSupportHoverModelIdRef.current === nextModelId) {
      return;
    }

    lastSupportHoverModelIdRef.current = nextModelId;
    emitSupportModelPointerHover(nextModelId);
  }, []);

  const scheduleSupportHoverClear = React.useCallback(() => {
    if (hoverClearRafRef.current !== null) return;

    hoverClearRafRef.current = requestAnimationFrame(() => {
      hoverClearRafRef.current = null;
      if (lastSupportHoverModelIdRef.current === null) return;
      lastSupportHoverModelIdRef.current = null;
      emitSupportModelPointerHover(null);
    });
  }, []);

  React.useEffect(() => {
    return () => {
      if (hoverClearRafRef.current !== null) {
        cancelAnimationFrame(hoverClearRafRef.current);
        hoverClearRafRef.current = null;
      }
      if (lastSupportHoverModelIdRef.current !== null) {
        lastSupportHoverModelIdRef.current = null;
        emitSupportModelPointerHover(null);
      }
    };
  }, []);

  React.useEffect(() => {
    if (pointerHoverEnabled) return;
    if (hoverClearRafRef.current !== null) {
      cancelAnimationFrame(hoverClearRafRef.current);
      hoverClearRafRef.current = null;
    }
    if (lastSupportHoverModelIdRef.current !== null) {
      lastSupportHoverModelIdRef.current = null;
      emitSupportModelPointerHover(null);
    }
  }, [pointerHoverEnabled]);

  const handleProxyShaftClick = React.useCallback((shaft: InstancedShaft) => {
    if (!pointerSelectionEnabled) return;
    if (!shaft.modelId) return;
    onModelPointerSelect?.(shaft.modelId);
  }, [onModelPointerSelect, pointerSelectionEnabled]);

  const handleProxyShaftPointerMove = React.useCallback((shaft: InstancedShaft) => {
    if (!pointerHoverEnabled) return;
    setSupportHoverModel(shaft.modelId ?? null);
  }, [pointerHoverEnabled, setSupportHoverModel]);

  const handleProxyRootClick = React.useCallback((root: InstancedRoot) => {
    if (!pointerSelectionEnabled) return;
    if (!root.modelId) return;
    onModelPointerSelect?.(root.modelId);
  }, [onModelPointerSelect, pointerSelectionEnabled]);

  const handleProxyRootPointerMove = React.useCallback((root: InstancedRoot) => {
    if (!pointerHoverEnabled) return;
    setSupportHoverModel(root.modelId ?? null);
  }, [pointerHoverEnabled, setSupportHoverModel]);

  const handleProxyJointClick = React.useCallback((joint: InstancedJoint) => {
    if (!pointerSelectionEnabled) return;
    if (!joint.modelId) return;
    onModelPointerSelect?.(joint.modelId);
  }, [onModelPointerSelect, pointerSelectionEnabled]);

  const handleProxyJointPointerMove = React.useCallback((joint: InstancedJoint) => {
    if (!pointerHoverEnabled) return;
    setSupportHoverModel(joint.modelId ?? null);
  }, [pointerHoverEnabled, setSupportHoverModel]);

  const handleProxyConeClick = React.useCallback((cone: InstancedContactCone) => {
    if (!pointerSelectionEnabled) return;
    if (!cone.modelId) return;
    onModelPointerSelect?.(cone.modelId);
  }, [onModelPointerSelect, pointerSelectionEnabled]);

  const handleProxyConePointerMove = React.useCallback((cone: InstancedContactCone) => {
    if (!pointerHoverEnabled) return;
    setSupportHoverModel(cone.modelId ?? null);
  }, [pointerHoverEnabled, setSupportHoverModel]);

  const handleProxyPointerOut = React.useCallback(() => {
    if (!pointerHoverEnabled) return;
    scheduleSupportHoverClear();
  }, [pointerHoverEnabled, scheduleSupportHoverClear]);

  const hoveredOverlayEntry = React.useMemo(() => {
    if (!effectiveHoverModelId) return null;
    if (highlightedModelIdSet.has(effectiveHoverModelId)) return null;
    if (!resolveModelVisible(effectiveHoverModelId)) return null;

    const modelKey = toModelKey(effectiveHoverModelId);
    const geometry = baseProxyByModel.get(modelKey);
    if (!geometry) return null;

    return {
      modelId: effectiveHoverModelId,
      modelKey,
      zOffset: modelDropOffsetsById?.[effectiveHoverModelId] ?? 0,
      geometry,
    };
  }, [
    effectiveHoverModelId,
    highlightedModelIdSet,
    resolveModelVisible,
    baseProxyByModel,
    modelDropOffsetsById,
  ]);

  if (visibleModelEntries.length === 0) {
    return null;
  }

  const hasBase = flattenedGeometry.base.shafts.length > 0
    || flattenedGeometry.base.roots.length > 0
    || (includeDetailedPrimitives && (flattenedGeometry.base.joints.length > 0 || flattenedGeometry.base.cones.length > 0));

  const hasHighlighted = flattenedGeometry.highlighted.shafts.length > 0
    || flattenedGeometry.highlighted.roots.length > 0
    || (includeDetailedPrimitives && (flattenedGeometry.highlighted.joints.length > 0 || flattenedGeometry.highlighted.cones.length > 0));

  return (
    <group>
      {hasBase && (
        <group key="proxy-base-batch">
          {flattenedGeometry.base.shafts.length > 0 && (
            <InstancedShaftGroup
              shafts={flattenedGeometry.base.shafts}
              color={DEFAULT_SUPPORT_COLOR}
              transparent={proxyTransparent}
              opacity={proxyOpacity}
              radialSegments={10}
              clippingPlanes={clippingPlanes}
              outOfBoundsMaterial={outOfBoundsMaterial}
              onShaftClick={pointerSelectionEnabled ? handleProxyShaftClick : undefined}
              onShaftPointerMove={pointerHoverEnabled ? handleProxyShaftPointerMove : undefined}
              onShaftPointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}
          {flattenedGeometry.base.roots.length > 0 && (
            <InstancedRootsGroup
              roots={flattenedGeometry.base.roots}
              color={DEFAULT_SUPPORT_COLOR}
              transparent={proxyTransparent}
              opacity={proxyOpacity}
              clippingPlanes={clippingPlanes}
              outOfBoundsMaterial={outOfBoundsMaterial}
              onRootClick={pointerSelectionEnabled ? handleProxyRootClick : undefined}
              onRootPointerMove={pointerHoverEnabled ? handleProxyRootPointerMove : undefined}
              onRootPointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}
          {includeDetailedPrimitives && flattenedGeometry.base.joints.length > 0 && (
            <InstancedJointGroup
              joints={flattenedGeometry.base.joints}
              color={DEFAULT_SUPPORT_COLOR}
              transparent={proxyTransparent}
              opacity={proxyOpacity}
              clippingPlanes={clippingPlanes}
              outOfBoundsMaterial={outOfBoundsMaterial}
              onJointClick={pointerSelectionEnabled ? (joint) => handleProxyJointClick(joint) : undefined}
              onJointPointerMove={pointerHoverEnabled ? handleProxyJointPointerMove : undefined}
              onJointPointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}
          {includeDetailedPrimitives && flattenedGeometry.base.cones.length > 0 && (
            <InstancedContactConeGroup
              cones={flattenedGeometry.base.cones}
              color={DEFAULT_SUPPORT_COLOR}
              transparent={proxyTransparent}
              opacity={proxyOpacity}
              clippingPlanes={clippingPlanes}
              outOfBoundsMaterial={outOfBoundsMaterial}
              onConeClick={pointerSelectionEnabled ? (cone) => handleProxyConeClick(cone) : undefined}
              onConePointerMove={pointerHoverEnabled ? handleProxyConePointerMove : undefined}
              onConePointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}
        </group>
      )}

      {hasHighlighted && (
        <group key="proxy-highlight-batch">
          {flattenedGeometry.highlighted.shafts.length > 0 && (
            <InstancedShaftGroup
              shafts={flattenedGeometry.highlighted.shafts}
              color={ACTIVE_SUPPORT_COLOR}
              transparent={proxyTransparent}
              opacity={proxyOpacity}
              radialSegments={10}
              clippingPlanes={clippingPlanes}
              outOfBoundsMaterial={outOfBoundsMaterial}
              onShaftClick={pointerSelectionEnabled ? handleProxyShaftClick : undefined}
              onShaftPointerMove={pointerHoverEnabled ? handleProxyShaftPointerMove : undefined}
              onShaftPointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}
          {flattenedGeometry.highlighted.roots.length > 0 && (
            <InstancedRootsGroup
              roots={flattenedGeometry.highlighted.roots}
              color={ACTIVE_SUPPORT_COLOR}
              transparent={proxyTransparent}
              opacity={proxyOpacity}
              clippingPlanes={clippingPlanes}
              outOfBoundsMaterial={outOfBoundsMaterial}
              onRootClick={pointerSelectionEnabled ? handleProxyRootClick : undefined}
              onRootPointerMove={pointerHoverEnabled ? handleProxyRootPointerMove : undefined}
              onRootPointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}
          {includeDetailedPrimitives && flattenedGeometry.highlighted.joints.length > 0 && (
            <InstancedJointGroup
              joints={flattenedGeometry.highlighted.joints}
              color={ACTIVE_SUPPORT_COLOR}
              transparent={proxyTransparent}
              opacity={proxyOpacity}
              clippingPlanes={clippingPlanes}
              outOfBoundsMaterial={outOfBoundsMaterial}
              onJointClick={pointerSelectionEnabled ? (joint) => handleProxyJointClick(joint) : undefined}
              onJointPointerMove={pointerHoverEnabled ? handleProxyJointPointerMove : undefined}
              onJointPointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}
          {includeDetailedPrimitives && flattenedGeometry.highlighted.cones.length > 0 && (
            <InstancedContactConeGroup
              cones={flattenedGeometry.highlighted.cones}
              color={ACTIVE_SUPPORT_COLOR}
              transparent={proxyTransparent}
              opacity={proxyOpacity}
              clippingPlanes={clippingPlanes}
              outOfBoundsMaterial={outOfBoundsMaterial}
              onConeClick={pointerSelectionEnabled ? (cone) => handleProxyConeClick(cone) : undefined}
              onConePointerMove={pointerHoverEnabled ? handleProxyConePointerMove : undefined}
              onConePointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}
        </group>
      )}

      {hoveredOverlayEntry && (
        <group key={`proxy-hover:${hoveredOverlayEntry.modelKey}`} position={hoveredOverlayEntry.zOffset !== 0 ? [0, 0, hoveredOverlayEntry.zOffset] : undefined}>
          {hoveredOverlayEntry.geometry.shafts.length > 0 && (
            <InstancedShaftGroup
              shafts={hoveredOverlayEntry.geometry.shafts}
              color={hoveredOverlayColor}
              emissive={hoveredOverlayColor}
              emissiveIntensity={0.1}
              transparent={hoverOverlayTransparent}
              opacity={hoverOverlayOpacity}
              radialSegments={10}
              clippingPlanes={clippingPlanes}
              onShaftClick={pointerSelectionEnabled ? handleProxyShaftClick : undefined}
              onShaftPointerMove={pointerHoverEnabled ? handleProxyShaftPointerMove : undefined}
              onShaftPointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}

          {hoveredOverlayEntry.geometry.roots.length > 0 && (
            <InstancedRootsGroup
              roots={hoveredOverlayEntry.geometry.roots}
              color={hoveredOverlayColor}
              emissive={hoveredOverlayColor}
              emissiveIntensity={0.1}
              transparent={hoverOverlayTransparent}
              opacity={hoverOverlayOpacity}
              clippingPlanes={clippingPlanes}
              onRootClick={pointerSelectionEnabled ? handleProxyRootClick : undefined}
              onRootPointerMove={pointerHoverEnabled ? handleProxyRootPointerMove : undefined}
              onRootPointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}

          {includeDetailedPrimitives && hoveredOverlayEntry.geometry.joints.length > 0 && (
            <InstancedJointGroup
              joints={hoveredOverlayEntry.geometry.joints}
              color={hoveredOverlayColor}
              emissive={hoveredOverlayColor}
              emissiveIntensity={0.1}
              transparent={hoverOverlayTransparent}
              opacity={hoverOverlayOpacity}
              clippingPlanes={clippingPlanes}
              onJointClick={pointerSelectionEnabled ? (joint) => handleProxyJointClick(joint) : undefined}
              onJointPointerMove={pointerHoverEnabled ? handleProxyJointPointerMove : undefined}
              onJointPointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}

          {includeDetailedPrimitives && hoveredOverlayEntry.geometry.cones.length > 0 && (
            <InstancedContactConeGroup
              cones={hoveredOverlayEntry.geometry.cones}
              color={hoveredOverlayColor}
              emissive={hoveredOverlayColor}
              emissiveIntensity={0.1}
              transparent={hoverOverlayTransparent}
              opacity={hoverOverlayOpacity}
              clippingPlanes={clippingPlanes}
              onConeClick={pointerSelectionEnabled ? (cone) => handleProxyConeClick(cone) : undefined}
              onConePointerMove={pointerHoverEnabled ? handleProxyConePointerMove : undefined}
              onConePointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}
        </group>
      )}
    </group>
  );
}

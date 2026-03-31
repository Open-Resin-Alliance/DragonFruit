import React from 'react';
import * as THREE from 'three';
import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot } from './state';
import { useKickstandStoreState } from './SupportTypes/Kickstand/kickstandStore';
import { InstancedShaftGroup, type InstancedShaft } from './SupportPrimitives/Shaft/InstancedShaftGroup';
import { InstancedRootsGroup, type InstancedRoot } from './SupportPrimitives/Roots/InstancedRootsGroup';
import { InstancedJointGroup, type InstancedJoint } from './SupportPrimitives/Joint/InstancedJointGroup';
import { InstancedContactConeGroup, type InstancedContactCone } from './SupportPrimitives/ContactCone/InstancedContactConeGroup';
import { getFinalSocketPosition } from './SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from './SupportPrimitives/ContactDisk/contactDiskUtils';
import type { ContactDisk, Vec3 } from './types';

interface SupportProxyMeshLayerProps {
  mode?: 'prepare' | 'analysis' | 'support' | 'export' | 'printing';
  clipLower?: number | null;
  clipUpper?: number | null;
  supportColorsByModelId?: Record<string, string>;
  activeModelId?: string | null;
  selectedModelIds?: string[];
  modelFilterId?: string | null;
  excludeModelId?: string | null;
  excludeModelIds?: string[];
  modelDropOffsetsById?: Record<string, number>;
  ghostOpacity?: number;
  onModelPointerSelect?: (modelId: string) => void;
  enablePointerSelection?: boolean;
  includeDetailedPrimitives?: boolean;
}

const DEFAULT_SUPPORT_COLOR = '#9a9a9a';
const ACTIVE_SUPPORT_COLOR = '#c8752a';

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
  supportStateRef: unknown;
  kickstandStateRef: unknown;
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
  supportColorsByModelId,
  activeModelId = null,
  selectedModelIds = [],
  modelFilterId = null,
  excludeModelId = null,
  excludeModelIds = [],
  modelDropOffsetsById,
  ghostOpacity = 1,
  onModelPointerSelect,
  enablePointerSelection = true,
  includeDetailedPrimitives = true,
}: SupportProxyMeshLayerProps) {
  const supportState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const kickstandState = useKickstandStoreState();

  const selectedModelIdSet = React.useMemo(() => new Set(selectedModelIds), [selectedModelIds]);
  const excludedModelIdSet = React.useMemo(
    () => new Set(excludeModelIds.filter((id): id is string => Boolean(id))),
    [excludeModelIds],
  );

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

  const baseProxyByModel = React.useMemo(() => {
    if (
      sharedProxyCache
      && sharedProxyCache.supportStateRef === supportState
      && sharedProxyCache.kickstandStateRef === kickstandState
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
      ensureModel(root.modelId).roots.push(root);
    };

    const pushJoint = (joint: InstancedJoint, dedupeKey?: string) => {
      const seen = ensureJointSeenSet(joint.modelId);
      const key = dedupeKey ?? joint.id;
      if (seen.has(key)) return;
      seen.add(key);
      ensureModel(joint.modelId).joints.push(joint);
    };

    const pushCone = (cone: InstancedContactCone, dedupeKey?: string) => {
      const seen = ensureConeSeenSet(cone.modelId);
      const key = dedupeKey ?? cone.id;
      if (seen.has(key)) return;
      seen.add(key);
      ensureModel(cone.modelId).cones.push(cone);
    };

    for (const trunk of Object.values(supportState.trunks)) {
      const root = supportState.roots[trunk.rootId];
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

    for (const branch of Object.values(supportState.branches)) {
      const parentKnot = supportState.knots[branch.parentKnotId];
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
      for (const leaf of Object.values(supportState.leaves)) {
        leafModelIdById.set(leaf.id, leaf.modelId);
        leafSupportIdById.set(leaf.id, leaf.id);
        pushCone({
          ...leaf.contactCone,
          supportId: leaf.id,
          modelId: leaf.modelId,
        });
      }
    }

    for (const twig of Object.values(supportState.twigs)) {
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

    for (const stick of Object.values(supportState.sticks)) {
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

    for (const brace of Object.values(supportState.braces)) {
      const startKnot = supportState.knots[brace.startKnotId];
      const endKnot = supportState.knots[brace.endKnotId];
      if (!startKnot || !endKnot) continue;

      pushShaft({
        id: `braceSegment:${brace.id}`,
        supportId: brace.id,
        modelId: brace.modelId,
        start: startKnot.pos,
        end: endKnot.pos,
        diameter: Math.max(0.1, brace.profile?.diameter ?? 1),
      });
    }

    if (includeDetailedPrimitives) {
      for (const knot of Object.values(supportState.knots)) {
        let modelId = segmentModelIdById.get(knot.parentShaftId);
        let supportId = segmentSupportIdById.get(knot.parentShaftId);

        if (!modelId && knot.parentShaftId.startsWith('leafCone:')) {
          const leafId = knot.parentShaftId.slice('leafCone:'.length);
          modelId = leafModelIdById.get(leafId);
          supportId = leafSupportIdById.get(leafId);
        }

        pushJoint({
          id: `knot:${knot.id}`,
          pos: knot.pos,
          diameter: Math.max(0.2, knot.diameter ?? 1),
          supportId,
          modelId,
        }, `knot:${knot.id}`);
      }
    }

    for (const kickstand of Object.values(kickstandState.kickstands)) {
      const root = kickstandState.roots[kickstand.rootId];
      const hostKnot = kickstandState.knots[kickstand.hostKnotId];
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

    if (includeDetailedPrimitives) {
      for (const knot of Object.values(kickstandState.knots)) {
        const modelId = segmentModelIdById.get(knot.parentShaftId);
        const supportId = segmentSupportIdById.get(knot.parentShaftId);

        pushJoint({
          id: `kickstand-knot:${knot.id}`,
          pos: knot.pos,
          diameter: Math.max(0.2, knot.diameter ?? 1),
          supportId,
          modelId,
        }, `kickstand-knot:${knot.id}`);
      }
    }

    sharedProxyCache = {
      supportStateRef: supportState,
      kickstandStateRef: kickstandState,
      includeDetailedPrimitives,
      baseProxyByModel: byModel,
    };

    return byModel;
  }, [
    supportState,
    supportState.trunks,
    supportState.roots,
    supportState.knots,
    supportState.branches,
    supportState.leaves,
    supportState.twigs,
    supportState.sticks,
    supportState.braces,
    kickstandState.kickstands,
    kickstandState.roots,
    kickstandState.knots,
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
    if (activeModelId) ids.add(activeModelId);
    for (const id of selectedModelIds) ids.add(id);
    return ids;
  }, [activeModelId, selectedModelIds]);

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

  const pointerSelectionEnabled = enablePointerSelection && mode === 'prepare' && !!onModelPointerSelect;

  const handleProxyShaftClick = React.useCallback((shaft: InstancedShaft) => {
    if (!pointerSelectionEnabled) return;
    if (!shaft.modelId) return;
    onModelPointerSelect?.(shaft.modelId);
  }, [onModelPointerSelect, pointerSelectionEnabled]);

  const handleProxyRootClick = React.useCallback((root: InstancedRoot) => {
    if (!pointerSelectionEnabled) return;
    if (!root.modelId) return;
    onModelPointerSelect?.(root.modelId);
  }, [onModelPointerSelect, pointerSelectionEnabled]);

  const handleProxyJointClick = React.useCallback((joint: InstancedJoint) => {
    if (!pointerSelectionEnabled) return;
    if (!joint.modelId) return;
    onModelPointerSelect?.(joint.modelId);
  }, [onModelPointerSelect, pointerSelectionEnabled]);

  const handleProxyConeClick = React.useCallback((cone: InstancedContactCone) => {
    if (!pointerSelectionEnabled) return;
    if (!cone.modelId) return;
    onModelPointerSelect?.(cone.modelId);
  }, [onModelPointerSelect, pointerSelectionEnabled]);

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
              onShaftClick={pointerSelectionEnabled ? handleProxyShaftClick : undefined}
            />
          )}
          {flattenedGeometry.base.roots.length > 0 && (
            <InstancedRootsGroup
              roots={flattenedGeometry.base.roots}
              color={DEFAULT_SUPPORT_COLOR}
              transparent={proxyTransparent}
              opacity={proxyOpacity}
              clippingPlanes={clippingPlanes}
              onRootClick={pointerSelectionEnabled ? handleProxyRootClick : undefined}
            />
          )}
          {includeDetailedPrimitives && flattenedGeometry.base.joints.length > 0 && (
            <InstancedJointGroup
              joints={flattenedGeometry.base.joints}
              color={DEFAULT_SUPPORT_COLOR}
              transparent={proxyTransparent}
              opacity={proxyOpacity}
              clippingPlanes={clippingPlanes}
              onJointClick={pointerSelectionEnabled ? (joint) => handleProxyJointClick(joint) : undefined}
            />
          )}
          {includeDetailedPrimitives && flattenedGeometry.base.cones.length > 0 && (
            <InstancedContactConeGroup
              cones={flattenedGeometry.base.cones}
              color={DEFAULT_SUPPORT_COLOR}
              transparent={proxyTransparent}
              opacity={proxyOpacity}
              clippingPlanes={clippingPlanes}
              onConeClick={pointerSelectionEnabled ? (cone) => handleProxyConeClick(cone) : undefined}
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
              onShaftClick={pointerSelectionEnabled ? handleProxyShaftClick : undefined}
            />
          )}
          {flattenedGeometry.highlighted.roots.length > 0 && (
            <InstancedRootsGroup
              roots={flattenedGeometry.highlighted.roots}
              color={ACTIVE_SUPPORT_COLOR}
              transparent={proxyTransparent}
              opacity={proxyOpacity}
              clippingPlanes={clippingPlanes}
              onRootClick={pointerSelectionEnabled ? handleProxyRootClick : undefined}
            />
          )}
          {includeDetailedPrimitives && flattenedGeometry.highlighted.joints.length > 0 && (
            <InstancedJointGroup
              joints={flattenedGeometry.highlighted.joints}
              color={ACTIVE_SUPPORT_COLOR}
              transparent={proxyTransparent}
              opacity={proxyOpacity}
              clippingPlanes={clippingPlanes}
              onJointClick={pointerSelectionEnabled ? (joint) => handleProxyJointClick(joint) : undefined}
            />
          )}
          {includeDetailedPrimitives && flattenedGeometry.highlighted.cones.length > 0 && (
            <InstancedContactConeGroup
              cones={flattenedGeometry.highlighted.cones}
              color={ACTIVE_SUPPORT_COLOR}
              transparent={proxyTransparent}
              opacity={proxyOpacity}
              clippingPlanes={clippingPlanes}
              onConeClick={pointerSelectionEnabled ? (cone) => handleProxyConeClick(cone) : undefined}
            />
          )}
        </group>
      )}
    </group>
  );
}

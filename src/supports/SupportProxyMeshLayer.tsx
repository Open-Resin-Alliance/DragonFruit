import React from 'react';
import * as THREE from 'three';
import { useSyncExternalStore } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { usePicking } from '@/components/picking';
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
import { bezierSegmentToBatchedShaft, braceBezierToBatchedShaft } from './Curves/batchedBezierShaft';
import type { ContactDisk, Segment, Vec3 } from './types';
import { MARQUEE_CANDIDATE_TINT_FACTOR } from '@/utils/marqueeCandidateTint';

interface SupportProxyMeshLayerProps {
  mode?: 'prepare' | 'analysis' | 'support' | 'export' | 'printing';
  clipLower?: number | null;
  clipUpper?: number | null;
  supportColorsByModelId?: Record<string, string>;
  activeModelId?: string | null;
  selectedModelIds?: string[];
  /** Models the marquee would take if the drag ended now. */
  marqueeCandidateModelIds?: readonly string[];
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
  /** In Select mode, a pointer-down on a support proxy reports a potential
   *  model XY-drag start (model + screen coords). The scene owns the drag. */
  onModelPointerDragStart?: (modelId: string, clientX: number, clientY: number) => void;
  enablePointerSelection?: boolean;
  includeDetailedPrimitives?: boolean;
  /** When true, only show supports whose contact points touch the cavity mesh. */
  interiorView?: boolean;
  /** Cavity mesh geometry keyed by modelId, used for interior support filtering. */
  cavityGeometryByModelId?: Map<string, THREE.BufferGeometry>;
  /**
   * World-to-local inverse matrices per modelId. Needed to transform support
   * contact positions (world space) into the cavity geometry's local space
   * for accurate BVH closest-point queries.
   */
  modelWorldInverseById?: Map<string, THREE.Matrix4>;
}

const DEFAULT_SUPPORT_COLOR = '#9a9a9a';
const ACTIVE_SUPPORT_COLOR = '#c8752a';
const EMPTY_MARQUEE_CANDIDATES: readonly string[] = Object.freeze([]);
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
  supportAnchorsRef: ReturnType<typeof getSnapshot>['anchors'];
  kickstandKickstandsRef: ReturnType<typeof useKickstandStoreState>['kickstands'];
  kickstandRootsRef: ReturnType<typeof useKickstandStoreState>['roots'];
  kickstandKnotsRef: ReturnType<typeof useKickstandStoreState>['knots'];
  hasSolidBottom: boolean;
  raftThickness: number;
  includeDetailedPrimitives: boolean;
  interiorSupportIdSet: Set<string> | null;
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
  marqueeCandidateModelIds = EMPTY_MARQUEE_CANDIDATES,
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
  onModelPointerDragStart,
  enablePointerSelection = true,
  includeDetailedPrimitives = true,
  interiorView = false,
  cavityGeometryByModelId,
  modelWorldInverseById,
}: SupportProxyMeshLayerProps) {
  // usePicking() causes a re-render on every pointer-move frame — only
  // subscribe when pointer interactions are enabled (prepare mode). In
  // other modes, the hit data is unused but still cost us re-renders.
  const { hit } = usePicking();
  const hitCategoryRef = React.useRef(hit.category);
  hitCategoryRef.current = hit.category;
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

  // ── Interior support filtering ────────────────────────────────────────
  // When interiorView is active, build a set of support IDs whose contact
  // points are ON the cavity mesh surface (interior supports). Exterior
  // supports contact the outer shell, which is typically 1-3mm away from
  // the cavity surface — well beyond the threshold.
  //
  // Uses three-mesh-bvh's closestPointToPoint (O(log n) per query) for
  // exact distance-to-surface measurement. The BVH is built once on the
  // cavity geometry and cached on geometry.boundsTree.
  //
  // IMPORTANT: Support contact positions are in WORLD space, while the
  // cavity geometry is in the model's LOCAL space. We use the model's
  // world-inverse matrix to transform support positions into local space
  // before the BVH query.
  const interiorSupportIdSet = React.useMemo<Set<string> | null>(() => {
    if (!interiorView || !cavityGeometryByModelId || cavityGeometryByModelId.size === 0) return null;

    const ids = new Set<string>();
    const tempVec = new THREE.Vector3();
    const queryTarget = { point: new THREE.Vector3(), distance: 0, faceIndex: -1 } as {
      point: THREE.Vector3;
      distance: number;
      faceIndex: number;
    };

    // Build BVH on cavity geometries for O(log n) closest-point queries
    const cavityBvhByGeometry = new Map<THREE.BufferGeometry, THREE.BufferGeometry & { boundsTree?: { closestPointToPoint: Function } }>();
    for (const [, geometry] of cavityGeometryByModelId) {
      const g = geometry as THREE.BufferGeometry & { boundsTree?: { closestPointToPoint: Function }; computeBoundsTree?: () => void };
      if (!g.boundsTree && typeof g.computeBoundsTree === 'function') {
        g.computeBoundsTree();
      }
      cavityBvhByGeometry.set(geometry, g);
    }

    // Pre-compute face normals for each cavity geometry so we can determine
    // which side of the cavity surface a point lies on.
    const faceNormalsByGeometry = new Map<THREE.BufferGeometry, Float32Array>();
    for (const [, geometry] of cavityGeometryByModelId) {
      const posAttr = geometry.getAttribute('position');
      const indexAttr = geometry.getIndex();
      if (!posAttr) continue;
      const positions = posAttr.array as Float32Array;
      const indices = indexAttr ? (indexAttr.array as Uint16Array | Uint32Array) : null;

      const triCount = indices
        ? indices.length / 3
        : posAttr.count / 3;
      const normals = new Float32Array(triCount * 3);

      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const c = new THREE.Vector3();
      const edge1 = new THREE.Vector3();
      const edge2 = new THREE.Vector3();
      const faceNormal = new THREE.Vector3();

      for (let i = 0; i < triCount; i++) {
        const i0 = indices ? indices[i * 3] : i * 3;
        const i1 = indices ? indices[i * 3 + 1] : i * 3 + 1;
        const i2 = indices ? indices[i * 3 + 2] : i * 3 + 2;
        a.set(positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]);
        b.set(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
        c.set(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);
        edge1.subVectors(b, a);
        edge2.subVectors(c, a);
        faceNormal.crossVectors(edge1, edge2).normalize();
        normals[i * 3] = faceNormal.x;
        normals[i * 3 + 1] = faceNormal.y;
        normals[i * 3 + 2] = faceNormal.z;
      }
      faceNormalsByGeometry.set(geometry, normals);
    }

    /**
     * Returns true if `pos` lies on the interior side of the cavity surface
     * or is very close to it (within the shell thickness).
     *
     * Finds the closest point on the cavity mesh, then compares the vector
     * from that point to `pos` against the face normal at the closest point.
     * - dot > 0  → pos is in same direction as normal → INSIDE cavity → show
     * - dot ≤ 0 but dist < SHELL_PROXIMITY_MM → near the cavity wall → show
     * - dot ≤ 0 and dist ≥ SHELL_PROXIMITY_MM → in solid material far from cavity → hide
     *
     * This is purely local — no watertightness or raycasting required.
     */
    const isOnInteriorSide = (pos: Vec3, modelId?: string): boolean => {
      const geometry = modelId ? cavityGeometryByModelId.get(modelId) : null;
      const target = geometry ?? (cavityGeometryByModelId ? Array.from(cavityGeometryByModelId.values())[0] : null);
      if (!target) return false;
      const g = cavityBvhByGeometry.get(target);
      if (!g?.boundsTree) return false;

      tempVec.set(pos.x, pos.y, pos.z);
      if (modelId && modelWorldInverseById) {
        const inv = modelWorldInverseById.get(modelId);
        if (inv) tempVec.applyMatrix4(inv);
      }
      queryTarget.distance = Infinity;
      queryTarget.faceIndex = -1;
      const result = g.boundsTree.closestPointToPoint(tempVec, queryTarget);
      if (!result || queryTarget.faceIndex < 0) return false;

      const normals = faceNormalsByGeometry.get(target);
      if (!normals || queryTarget.faceIndex * 3 + 2 >= normals.length) return false;

      // Vector from closest cavity point → support point
      const dx = tempVec.x - queryTarget.point.x;
      const dy = tempVec.y - queryTarget.point.y;
      const dz = tempVec.z - queryTarget.point.z;

      // Face normal at closest point (outward from cavity)
      const nx = normals[queryTarget.faceIndex * 3];
      const ny = normals[queryTarget.faceIndex * 3 + 1];
      const nz = normals[queryTarget.faceIndex * 3 + 2];

      const dot = dx * nx + dy * ny + dz * nz;

      // Cavity mesh normals point INTO the cavity (marching-cubes convention).
      // dot > 0  → point is inside the cavity void → definitely show
      // dot ≤ 0  → point is in the model wall or outside.
      //   dist < 1.5mm → on/near the INTERIOR wall (cavity-facing) → show
      //   dist ≥ 1.5mm → exterior wall or far outside → hide
      const INTERIOR_WALL_THRESHOLD_MM = 1.5;
      return dot > 0 || result.distance < INTERIOR_WALL_THRESHOLD_MM;
    };

    const isInteriorContactCone = (cone: { pos: Vec3; placementSurface?: 'interior' | 'exterior' } | undefined, modelId?: string): boolean => {
      if (!cone) return false;
      if (cone.placementSurface === 'interior') return true;
      if (cone.placementSurface === 'exterior') return false;
      return isOnInteriorSide(cone.pos, modelId);
    };

    const isInteriorContactDisk = (disk: { pos: Vec3; placementSurface?: 'interior' | 'exterior' } | undefined, modelId?: string): boolean => {
      if (!disk) return false;
      if (disk.placementSurface === 'interior') return true;
      if (disk.placementSurface === 'exterior') return false;
      return isOnInteriorSide(disk.pos, modelId);
    };

    // Sample a segment shaft for cavity interior crossing. Both endpoints are
    // typically outside the cavity (tip at model surface, base at raft/parent).
    // The shaft may only pass through the cavity over a short fraction of its
    // length, so we sample at 10% increments to catch narrow crossings.
    const isAnySegmentPointInterior = (
      segs: Array<{ bottomJoint?: { pos: Vec3 }; topJoint?: { pos: Vec3 } }>,
      modelId?: string,
    ): boolean => {
      for (const seg of segs) {
        if (seg.bottomJoint?.pos && isOnInteriorSide(seg.bottomJoint.pos, modelId)) return true;
        if (seg.topJoint?.pos && isOnInteriorSide(seg.topJoint.pos, modelId)) return true;

        const a = seg.bottomJoint?.pos;
        const b = seg.topJoint?.pos;
        if (a && b) {
          for (let i = 1; i <= 9; i++) {
            const t = i / 10;
            const mid: Vec3 = {
              x: a.x + (b.x - a.x) * t,
              y: a.y + (b.y - a.y) * t,
              z: a.z + (b.z - a.z) * t,
            };
            if (isOnInteriorSide(mid, modelId)) return true;
          }
        }
      }
      return false;
    };

    // Trunks always have roots (raft-connected) — their shafts originate at the
    // build plate and their tips are at the model exterior surface. They never
    // belong in the interior cavity view.
    // (trunk loop intentionally omitted — trunks are never added to the set)

    for (const branch of Object.values(supportBranches)) {
      if (isInteriorContactCone(branch.contactCone, branch.modelId)) {
        ids.add(`branch:${branch.id}`);
        continue;
      }
      if (isAnySegmentPointInterior(branch.segments, branch.modelId)) {
        ids.add(`branch:${branch.id}`);
      }
    }
    for (const leaf of Object.values(supportLeaves)) {
      if (isInteriorContactCone(leaf.contactCone, leaf.modelId)) {
        ids.add(`leaf:${leaf.id}`);
      }
    }
    for (const stick of Object.values(supportSticks)) {
      const onA = isInteriorContactCone(stick.contactConeA, stick.modelId);
      const onB = isInteriorContactCone(stick.contactConeB, stick.modelId);
      if (onA || onB) ids.add(`stick:${stick.id}`);
    }
    for (const anchor of Object.values(supportState.anchors)) {
      if (isInteriorContactCone(anchor.contactCone, anchor.modelId)) {
        ids.add(`anchor:${anchor.id}`);
      }
    }
    for (const twig of Object.values(supportTwigs)) {
      const onA = isInteriorContactDisk(twig.contactDiskA, twig.modelId);
      const onB = isInteriorContactDisk(twig.contactDiskB, twig.modelId);
      if (onA || onB) ids.add(`twig:${twig.id}`);
    }

    return ids;
  }, [
    interiorView,
    cavityGeometryByModelId,
    modelWorldInverseById,
    supportTrunks,
    supportBranches,
    supportLeaves,
    supportSticks,
    supportTwigs,
    supportState.anchors,
  ]);

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
      && sharedProxyCache.supportAnchorsRef === supportState.anchors
      && sharedProxyCache.kickstandKickstandsRef === kickstandKickstands
      && sharedProxyCache.kickstandRootsRef === kickstandRoots
      && sharedProxyCache.kickstandKnotsRef === kickstandKnots
      && sharedProxyCache.hasSolidBottom === hasSolidBottom
      && sharedProxyCache.raftThickness === raftThickness
      && sharedProxyCache.includeDetailedPrimitives === includeDetailedPrimitives
      && sharedProxyCache.interiorSupportIdSet === interiorSupportIdSet
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

    // Curved segments become curved batched-shaft entries; InstancedShaftGroup
    // renders them as smooth capped tubes (same approach as the support-mode
    // scene batch). This keeps curves visible in proxy views AND in mesh
    // export: the unscoped STL/3MF path serializes this layer's live scene
    // graph in prepare/export modes.
    const pushSegmentShafts = (segment: Segment, start: Vec3, end: Vec3, supportId: string, modelId?: string) => {
      if (segment.type === 'bezier') {
        pushShaft(bezierSegmentToBatchedShaft(segment, start, end, supportId, modelId));
        return;
      }
      pushShaft({
        id: segment.id,
        supportId,
        modelId,
        start,
        end,
        diameter: segment.diameter,
      });
    };

    const pushRoot = (root: InstancedRoot) => {
      const effectiveDiskHeight = Math.max(0.001, root.effectiveDiskHeight);
      const verticalOffset = 0;

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
      if (interiorSupportIdSet && !interiorSupportIdSet.has(`trunk:${trunk.id}`)) continue;
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

        pushSegmentShafts(segment, currentStart, end, trunk.id, trunk.modelId);

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
      if (interiorSupportIdSet && !interiorSupportIdSet.has(`branch:${branch.id}`)) continue;
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

        pushSegmentShafts(segment, currentStart, end, branch.id, branch.modelId);

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

      // The branch's parent knot renders as a sphere on the host shaft
      // (BranchRenderer draws it always) — the proxy must carry it too.
      if (includeDetailedPrimitives) {
        pushJoint(
          {
            id: parentKnot.id,
            pos: parentKnot.pos,
            diameter: parentKnot.diameter ?? 1.2,
            supportId: branch.id,
            modelId: branch.modelId,
          },
          undefined,
          // KnotRenderer blends the FULL joint offset; the segment joints
          // use the ×0.75 proxy blend.
          JOINT_DIAMETER_OFFSET_MM,
        );
      }
    }

    if (includeDetailedPrimitives) {
      for (const leaf of Object.values(supportLeaves)) {
        if (interiorSupportIdSet && !interiorSupportIdSet.has(`leaf:${leaf.id}`)) continue;
        leafModelIdById.set(leaf.id, leaf.modelId);
        leafSupportIdById.set(leaf.id, leaf.id);
        pushCone({
          ...leaf.contactCone,
          supportId: leaf.id,
          modelId: leaf.modelId,
        });

        // Rod connecting the leaf's contact cone (on the model) to its
        // parent knot on the host shaft. Without this the leaf appears as
        // a floating cone in proxy views.
        const parentKnot = supportKnots[leaf.parentKnotId];
        if (parentKnot) {
          const tipSocket = getFinalSocketPosition(leaf.contactCone);
          const cone = leaf.contactCone;
          const rodDiameter = Math.max(0.001, cone.profile.bodyDiameterMm ?? 0.5);
          pushShaft({
            id: `leafRod:${leaf.id}`,
            supportId: leaf.id,
            modelId: leaf.modelId,
            start: tipSocket,
            end: parentKnot.pos,
            diameter: rodDiameter,
          });

          // The leaf base knot sphere (LeafRenderer draws it always).
          pushJoint(
            {
              id: parentKnot.id,
              pos: parentKnot.pos,
              diameter: parentKnot.diameter ?? 1.2,
              supportId: leaf.id,
              modelId: leaf.modelId,
            },
            undefined,
            JOINT_DIAMETER_OFFSET_MM,
          );
        }
      }
    }

    for (const twig of Object.values(supportTwigs)) {
      if (interiorSupportIdSet && !interiorSupportIdSet.has(`twig:${twig.id}`)) continue;
      if (includeDetailedPrimitives) {
        pushCone({
          id: twig.contactDiskA.id,
          supportId: twig.id,
          modelId: twig.modelId,
          pos: twig.contactDiskA.pos,
          normal: twig.contactDiskA.coneAxis,
          surfaceNormal: twig.contactDiskA.surfaceNormal,
          diskLengthOverride: twig.contactDiskA.diskLengthOverride,
          profile: {
            type: 'disk',
            contactDiameterMm: twig.contactDiskA.contactDiameterMm,
            bodyDiameterMm: twig.contactDiskA.contactDiameterMm,
            lengthMm: 0.001,
            penetrationMm: 0,
            diskThicknessMm: twig.contactDiskA.profile.diskThicknessMm,
            maxStandoffMm: twig.contactDiskA.profile.maxStandoffMm,
            standoffAngleThreshold: twig.contactDiskA.profile.standoffAngleThreshold,
          },
        });
        pushCone({
          id: twig.contactDiskB.id,
          supportId: twig.id,
          modelId: twig.modelId,
          pos: twig.contactDiskB.pos,
          normal: twig.contactDiskB.coneAxis,
          surfaceNormal: twig.contactDiskB.surfaceNormal,
          diskLengthOverride: twig.contactDiskB.diskLengthOverride,
          profile: {
            type: 'disk',
            contactDiameterMm: twig.contactDiskB.contactDiameterMm,
            bodyDiameterMm: twig.contactDiskB.contactDiameterMm,
            lengthMm: 0.001,
            penetrationMm: 0,
            diskThicknessMm: twig.contactDiskB.profile.diskThicknessMm,
            maxStandoffMm: twig.contactDiskB.profile.maxStandoffMm,
            standoffAngleThreshold: twig.contactDiskB.profile.standoffAngleThreshold,
          },
        });
      }

      for (const segment of twig.segments) {
        if (includeDetailedPrimitives && segment.bottomJoint) {
          pushJoint({
            id: segment.bottomJoint.id,
            pos: segment.bottomJoint.pos,
            diameter: segment.diameter,
            supportId: twig.id,
            modelId: twig.modelId,
          });
        }

        const start = segment.bottomJoint?.pos ?? getDiskTipCenter(twig.contactDiskA);
        const end = segment.topJoint?.pos ?? getDiskTipCenter(twig.contactDiskB);

        pushSegmentShafts(segment, start, end, twig.id, twig.modelId);

        if (includeDetailedPrimitives && segment.topJoint) {
          pushJoint({
            id: segment.topJoint.id,
            pos: segment.topJoint.pos,
            diameter: segment.diameter,
            supportId: twig.id,
            modelId: twig.modelId,
          });
        }
      }
    }

    for (const stick of Object.values(supportSticks)) {
      if (interiorSupportIdSet && !interiorSupportIdSet.has(`stick:${stick.id}`)) continue;
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

        pushSegmentShafts(segment, start, end, stick.id, stick.modelId);

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
      // In interior view, hide braces entirely — they're connecting
      // structures between supports, not model-facing supports.
      if (interiorSupportIdSet) continue;
      const startKnot = supportKnots[brace.startKnotId];
      const endKnot = supportKnots[brace.endKnotId];
      if (!startKnot || !endKnot) continue;

      // Mirror SupportRenderer: derive visual diameter from host knot diameters (= trunk segment
      // diameter + 0.1mm offset). Using profile.diameter alone produces the thin brace setting
      // value and loses the dynamic sizing that matches the attached trunk thickness.
      const profileDiameter = Math.max(0.001, brace.profile?.diameter ?? 1);
      const startHostDiameter = Math.min(
        profileDiameter,
        Math.max(
          0.001,
          (startKnot.diameter ?? (profileDiameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM,
        ),
      );
      const endHostDiameter = Math.min(
        profileDiameter,
        Math.max(
          0.001,
          (endKnot.diameter ?? (profileDiameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM,
        ),
      );

      const braceDiameter = (startHostDiameter + endHostDiameter) * 0.5;
      if (brace.curve?.type === 'bezier') {
        pushShaft(braceBezierToBatchedShaft(
          `braceSegment:${brace.id}`,
          startKnot.pos,
          endKnot.pos,
          brace.curve.controlPoint1,
          brace.curve.controlPoint2,
          braceDiameter,
          brace.curve.resolution,
          brace.id,
          brace.modelId,
        ));
      } else {
        pushShaft({
          id: `braceSegment:${brace.id}`,
          supportId: brace.id,
          modelId: brace.modelId,
          start: startKnot.pos,
          end: endKnot.pos,
          diameter: braceDiameter,
        });
      }
    }

    // Knots that the scene renders always (leaf base knots and branch parent
    // knots on host shafts) are emitted as spheres above. The knots still
    // omitted here — brace endpoints and kickstand host knots — are
    // selection-only interaction affordances in SupportRenderer, so leaving
    // them out keeps the proxy geometry clean.

    // Anchors: root + contact cone, no shafts
    const supportAnchors = supportState.anchors;
    for (const anchor of Object.values(supportAnchors)) {
      if (interiorSupportIdSet && !interiorSupportIdSet.has(`anchor:${anchor.id}`)) continue;
      pushRoot({
        id: `${anchor.id}:root`,
        supportId: anchor.id,
        modelId: anchor.modelId,
        basePos: anchor.rootPos,
        bottomRadius: Math.max(0.001, anchor.rootBaseDiameter / 2),
        topRadius: Math.max(0.001, anchor.rootTopDiameter / 2),
        effectiveDiskHeight: 0.1,
        coneHeight: Math.max(0, anchor.rootHeight),
      });

      if (includeDetailedPrimitives && anchor.contactCone) {
        pushCone({
          ...anchor.contactCone,
          supportId: anchor.id,
          modelId: anchor.modelId,
        });
      }
    }

    for (const kickstand of Object.values(kickstandKickstands)) {
      if (interiorSupportIdSet && !interiorSupportIdSet.has(`kickstand:${kickstand.id}`)) continue;
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
        pushSegmentShafts(segment, currentStart, end, kickstand.id, kickstand.modelId);

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
      supportAnchorsRef: supportState.anchors,
      kickstandKickstandsRef: kickstandKickstands,
      kickstandRootsRef: kickstandRoots,
      kickstandKnotsRef: kickstandKnots,
      hasSolidBottom,
      raftThickness,
      includeDetailedPrimitives,
      interiorSupportIdSet,
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
    interiorSupportIdSet,
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

  const proxyOpacity = Math.max(0.05, Math.min(1, ghostOpacity));
  const proxyTransparent = proxyOpacity < 0.999;
  const hoverOverlayOpacity = React.useMemo(() => {
    const hoverAlpha = Math.max(0.05, Math.min(1, hoverTintStrength));
    return Math.max(0.05, Math.min(1, proxyOpacity * hoverAlpha));
  }, [hoverTintStrength, proxyOpacity]);
  const hoverOverlayTransparent = hoverOverlayOpacity < 0.999;

  const pointerHoverEnabled = enablePointerSelection && mode === 'prepare';
  const pointerSelectionEnabled = enablePointerSelection && mode === 'prepare' && !!onModelPointerSelect;
  const pointerDragStartEnabled = enablePointerSelection && mode === 'prepare';

  const reportModelDragStart = React.useCallback((modelId: string | undefined, event: ThreeEvent<PointerEvent>) => {
    if (!pointerDragStartEnabled || !onModelPointerDragStart) return;
    if (!modelId) return;
    if (hitCategoryRef.current === 'gizmo') return;
    const native = event.nativeEvent as PointerEvent | undefined;
    if (native?.ctrlKey || native?.metaKey || native?.shiftKey) return;
    if (event.button !== 0) return;
    onModelPointerDragStart(modelId, event.clientX, event.clientY);
  }, [onModelPointerDragStart, pointerDragStartEnabled]);

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
    if (hitCategoryRef.current === 'gizmo') return;
    onModelPointerSelect?.(shaft.modelId);
  }, [onModelPointerSelect, pointerSelectionEnabled]);

  const handleProxyShaftPointerMove = React.useCallback((shaft: InstancedShaft) => {
    if (!pointerHoverEnabled) return;
    setSupportHoverModel(shaft.modelId ?? null);
  }, [pointerHoverEnabled, setSupportHoverModel]);

  const handleProxyRootClick = React.useCallback((root: InstancedRoot) => {
    if (!pointerSelectionEnabled) return;
    if (!root.modelId) return;
    if (hitCategoryRef.current === 'gizmo') return;
    onModelPointerSelect?.(root.modelId);
  }, [onModelPointerSelect, pointerSelectionEnabled]);

  const handleProxyRootPointerMove = React.useCallback((root: InstancedRoot) => {
    if (!pointerHoverEnabled) return;
    setSupportHoverModel(root.modelId ?? null);
  }, [pointerHoverEnabled, setSupportHoverModel]);

  const handleProxyJointClick = React.useCallback((joint: InstancedJoint) => {
    if (!pointerSelectionEnabled) return;
    if (!joint.modelId) return;
    if (hitCategoryRef.current === 'gizmo') return;
    onModelPointerSelect?.(joint.modelId);
  }, [onModelPointerSelect, pointerSelectionEnabled]);

  const handleProxyJointPointerMove = React.useCallback((joint: InstancedJoint) => {
    if (!pointerHoverEnabled) return;
    setSupportHoverModel(joint.modelId ?? null);
  }, [pointerHoverEnabled, setSupportHoverModel]);

  const handleProxyConeClick = React.useCallback((cone: InstancedContactCone) => {
    if (!pointerSelectionEnabled) return;
    if (!cone.modelId) return;
    if (hitCategoryRef.current === 'gizmo') return;
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

  // The hover tint also covers the models a marquee drag is about to take, so
  // their supports light up with the model instead of after the mouse is up.
  const hoveredOverlayEntries = React.useMemo(() => {
    const modelIds = new Set<string>();
    if (effectiveHoverModelId) modelIds.add(effectiveHoverModelId);
    for (const modelId of marqueeCandidateModelIds) modelIds.add(modelId);

    const entries: Array<{
      modelId: string;
      modelKey: string;
      zOffset: number;
      geometry: NonNullable<ReturnType<typeof baseProxyByModel.get>>;
      opacity: number;
    }> = [];

    for (const modelId of modelIds) {
      if (highlightedModelIdSet.has(modelId)) continue;
      if (!resolveModelVisible(modelId)) continue;

      const modelKey = toModelKey(modelId);
      const geometry = baseProxyByModel.get(modelKey);
      if (!geometry) continue;

      entries.push({
        modelId,
        modelKey,
        zOffset: modelDropOffsetsById?.[modelId] ?? 0,
        geometry,
        // A candidate tints lighter than a hover, so a marquee lighting up
        // model, supports and raft at once still reads apart from a selection.
        opacity: modelId === effectiveHoverModelId
          ? hoverOverlayOpacity
          : hoverOverlayOpacity * MARQUEE_CANDIDATE_TINT_FACTOR,
      });
    }

    return entries;
  }, [
    effectiveHoverModelId,
    marqueeCandidateModelIds,
    highlightedModelIdSet,
    resolveModelVisible,
    baseProxyByModel,
    modelDropOffsetsById,
    hoverOverlayOpacity,
  ]);

  // Flatten all visible model geometries into two batched groups (base + highlighted) so the
  // entire scene is rendered with a constant number of draw calls regardless of model count.
  // This restores the "singular mesh" performance characteristic that was lost when per-model
  // groups were introduced in the ZIP Import / Batch Export refactor.
  const flattenedGeometry = React.useMemo(() => {
    const createEmpty = (): FlatProxyGeometry => ({ shafts: [], roots: [], joints: [], cones: [] });
    const base = createEmpty();
    const highlighted = createEmpty();

    const appendShaft = (target: FlatProxyGeometry, shaft: InstancedShaft, zOffset: number) => {
      if (Math.abs(zOffset) < 1e-6) {
        target.shafts.push(shaft);
        return;
      }
      const pushed: InstancedShaft = {
        ...shaft,
        start: { x: shaft.start.x, y: shaft.start.y, z: shaft.start.z + zOffset },
        end: { x: shaft.end.x, y: shaft.end.y, z: shaft.end.z + zOffset },
      };
      if (shaft.controlPoint1) pushed.controlPoint1 = { x: shaft.controlPoint1.x, y: shaft.controlPoint1.y, z: shaft.controlPoint1.z + zOffset };
      if (shaft.controlPoint2) pushed.controlPoint2 = { x: shaft.controlPoint2.x, y: shaft.controlPoint2.y, z: shaft.controlPoint2.z + zOffset };
      target.shafts.push(pushed);
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
              onShaftPointerDown={pointerDragStartEnabled ? (shaft, event) => reportModelDragStart(shaft.modelId, event) : undefined}
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
              onRootPointerDown={pointerDragStartEnabled ? (root, event) => reportModelDragStart(root.modelId, event) : undefined}
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
              onJointClick={pointerSelectionEnabled ? (joint) => handleProxyJointClick(joint) : undefined}
              onJointPointerDown={pointerDragStartEnabled ? (joint, event) => reportModelDragStart(joint.modelId, event) : undefined}
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
              onConeClick={pointerSelectionEnabled ? (cone) => handleProxyConeClick(cone) : undefined}
              onConePointerDown={pointerDragStartEnabled ? (cone, event) => reportModelDragStart(cone.modelId, event) : undefined}
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
              onShaftPointerDown={pointerDragStartEnabled ? (shaft, event) => reportModelDragStart(shaft.modelId, event) : undefined}
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
              onRootPointerDown={pointerDragStartEnabled ? (root, event) => reportModelDragStart(root.modelId, event) : undefined}
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
              onJointClick={pointerSelectionEnabled ? (joint) => handleProxyJointClick(joint) : undefined}
              onJointPointerDown={pointerDragStartEnabled ? (joint, event) => reportModelDragStart(joint.modelId, event) : undefined}
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
              onConeClick={pointerSelectionEnabled ? (cone) => handleProxyConeClick(cone) : undefined}
              onConePointerDown={pointerDragStartEnabled ? (cone, event) => reportModelDragStart(cone.modelId, event) : undefined}
              onConePointerMove={pointerHoverEnabled ? handleProxyConePointerMove : undefined}
              onConePointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}
        </group>
      )}

      {hoveredOverlayEntries.map((hoveredOverlayEntry) => (
        <group
          key={`proxy-hover:${hoveredOverlayEntry.modelKey}`}
          userData={{ modelId: hoveredOverlayEntry.modelId ?? null }}
          position={hoveredOverlayEntry.zOffset !== 0 ? [0, 0, hoveredOverlayEntry.zOffset] as [number, number, number] : undefined}
        >
          {hoveredOverlayEntry.geometry.shafts.length > 0 && (
            <InstancedShaftGroup
              shafts={hoveredOverlayEntry.geometry.shafts}
              color={hoveredOverlayColor}
              emissive={hoveredOverlayColor}
              emissiveIntensity={0.1}
              transparent={hoverOverlayTransparent}
              opacity={hoveredOverlayEntry.opacity}
              radialSegments={10}
              clippingPlanes={clippingPlanes}
              onShaftClick={pointerSelectionEnabled ? handleProxyShaftClick : undefined}
              onShaftPointerDown={pointerDragStartEnabled ? (shaft, event) => reportModelDragStart(shaft.modelId, event) : undefined}
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
              opacity={hoveredOverlayEntry.opacity}
              clippingPlanes={clippingPlanes}
              onRootClick={pointerSelectionEnabled ? handleProxyRootClick : undefined}
              onRootPointerDown={pointerDragStartEnabled ? (root, event) => reportModelDragStart(root.modelId, event) : undefined}
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
              opacity={hoveredOverlayEntry.opacity}
              clippingPlanes={clippingPlanes}
              onJointClick={pointerSelectionEnabled ? (joint) => handleProxyJointClick(joint) : undefined}
              onJointPointerDown={pointerDragStartEnabled ? (joint, event) => reportModelDragStart(joint.modelId, event) : undefined}
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
              opacity={hoveredOverlayEntry.opacity}
              clippingPlanes={clippingPlanes}
              onConeClick={pointerSelectionEnabled ? (cone) => handleProxyConeClick(cone) : undefined}
              onConePointerDown={pointerDragStartEnabled ? (cone, event) => reportModelDragStart(cone.modelId, event) : undefined}
              onConePointerMove={pointerHoverEnabled ? handleProxyConePointerMove : undefined}
              onConePointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}
        </group>
      ))}
    </group>
  );
}

import React from 'react';
import * as THREE from 'three';
import { useSyncExternalStore } from 'react';
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
import type { BezierSegment, ContactDisk, Segment, Vec3 } from './types';
import { resolveTwigSegmentDiameters, twigJointDiameterForLocalDiameter } from './SupportTypes/Twig/twigTaper';
import { toVector3 } from './Curves/BezierUtils';

// Tapered straight shaft for the proxy. Rendered as a non-instanced
// truncated-cone mesh (separate from the instanced uniform-shaft batch)
// because three's InstancedMesh uses one shared geometry per group and
// cannot represent per-instance start/end radii.
interface ProxyTaperedShaft {
    id: string;
    supportId?: string;
    modelId?: string;
    start: Vec3;
    end: Vec3;
    diameterStart: number;
    diameterEnd: number;
}

// Curved shaft for the proxy. Rendered as one continuous TubeGeometry per
// bezier segment (same approach as the full SupportPage BezierRenderer) so
// the silhouette is smooth instead of a stack of short cylinders with
// abrupt diameter jumps.
interface ProxyBezierShaft {
    id: string;
    supportId?: string;
    modelId?: string;
    start: Vec3;
    end: Vec3;
    control1: Vec3;
    control2: Vec3;
    resolution: number;
    diameterStart: number;
    diameterEnd: number;
}

function isBezierSegment(seg: Segment): seg is BezierSegment {
    return (seg as BezierSegment).type === 'bezier';
}

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
const PROXY_JOINT_DIAMETER_BLEND_MM = JOINT_DIAMETER_OFFSET_MM * 0.75;

type ProxyModelGeometry = {
  modelId?: string;
  shafts: InstancedShaft[];
  taperedShafts: ProxyTaperedShaft[];
  bezierShafts: ProxyBezierShaft[];
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
  taperedShafts: ProxyTaperedShaft[];
  bezierShafts: ProxyBezierShaft[];
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

function toProxyConeFromTwigDisk(disk: ContactDisk, supportId: string, modelId: string): InstancedContactCone {
  return {
    id: disk.id,
    supportId,
    modelId,
    pos: disk.pos,
    normal: disk.coneAxis,
    surfaceNormal: disk.surfaceNormal,
    diskLengthOverride: disk.diskLengthOverride,
    profile: {
      type: 'disk',
      contactDiameterMm: disk.contactDiameterMm,
      bodyDiameterMm: disk.contactDiameterMm,
      lengthMm: 0.001,
      penetrationMm: 0,
      diskThicknessMm: disk.profile.diskThicknessMm,
      maxStandoffMm: disk.profile.maxStandoffMm,
      standoffAngleThreshold: disk.profile.standoffAngleThreshold,
    },
  };
}

// Non-instanced tapered-shaft renderer for the proxy. One mesh per shaft;
// used for the relatively rare tapered straight rods (twigs, tapered braces).
// Bezier rods go through ProxyBezierShaftGroup instead. Radial-segment count
// matches the full-renderer ShaftRenderer default (16) so the silhouette
// reads identically across pages.
const TAPERED_SHAFT_RADIAL_SEGMENTS = 16;
const TAPERED_UP = new THREE.Vector3(0, 1, 0);

interface ProxyTaperedShaftGroupProps {
    shafts: ProxyTaperedShaft[];
    color: string;
    emissive?: string;
    emissiveIntensity?: number;
    transparent?: boolean;
    opacity?: number;
    clippingPlanes?: THREE.Plane[] | null;
    onShaftClick?: (shaft: ProxyTaperedShaft) => void;
    onShaftPointerMove?: (shaft: ProxyTaperedShaft) => void;
    onShaftPointerOut?: () => void;
}

function ProxyTaperedShaftGroup({
    shafts,
    color,
    emissive,
    emissiveIntensity = 0,
    transparent = false,
    opacity = 1,
    clippingPlanes = null,
    onShaftClick,
    onShaftPointerMove,
    onShaftPointerOut,
}: ProxyTaperedShaftGroupProps) {
    if (shafts.length === 0) return null;
    return (
        <group>
            {shafts.map((shaft) => {
                const startVec = new THREE.Vector3(shaft.start.x, shaft.start.y, shaft.start.z);
                const endVec = new THREE.Vector3(shaft.end.x, shaft.end.y, shaft.end.z);
                const length = startVec.distanceTo(endVec);
                if (length < 0.001) return null;
                const midpoint = new THREE.Vector3().addVectors(startVec, endVec).multiplyScalar(0.5);
                const direction = new THREE.Vector3().subVectors(endVec, startVec).normalize();
                const quaternion = new THREE.Quaternion().setFromUnitVectors(TAPERED_UP, direction);
                const radiusStart = Math.max(0.001, shaft.diameterStart / 2);
                const radiusEnd = Math.max(0.001, shaft.diameterEnd / 2);
                return (
                    <mesh
                        key={shaft.id}
                        position={[midpoint.x, midpoint.y, midpoint.z]}
                        quaternion={quaternion}
                        onClick={onShaftClick ? (e) => { e.stopPropagation(); onShaftClick(shaft); } : undefined}
                        onPointerMove={onShaftPointerMove ? (e) => { e.stopPropagation(); onShaftPointerMove(shaft); } : undefined}
                        onPointerOut={onShaftPointerOut ? () => onShaftPointerOut() : undefined}
                    >
                        <cylinderGeometry args={[radiusEnd, radiusStart, length, TAPERED_SHAFT_RADIAL_SEGMENTS]} />
                        <meshStandardMaterial
                            color={color}
                            emissive={emissive ?? '#000000'}
                            emissiveIntensity={emissiveIntensity}
                            transparent={transparent}
                            opacity={opacity}
                            depthWrite={!transparent}
                            clippingPlanes={clippingPlanes ?? undefined}
                        />
                    </mesh>
                );
            })}
        </group>
    );
}

// Non-instanced bezier-shaft renderer for the proxy. Uses one continuous
// TubeGeometry per curved segment — same approach as the full-renderer
// BezierRenderer — so the curve reads as a smooth tube instead of a stack
// of stepped cylinders. Diameter is linearly interpolated along the curve
// to support tapered curved twigs/braces.
interface ProxyBezierShaftGroupProps {
    shafts: ProxyBezierShaft[];
    color: string;
    emissive?: string;
    emissiveIntensity?: number;
    transparent?: boolean;
    opacity?: number;
    clippingPlanes?: THREE.Plane[] | null;
    onShaftClick?: (shaft: ProxyBezierShaft) => void;
    onShaftPointerMove?: (shaft: ProxyBezierShaft) => void;
    onShaftPointerOut?: () => void;
}

function ProxyBezierShaftItem({
    shaft,
    color,
    emissive,
    emissiveIntensity,
    transparent,
    opacity,
    clippingPlanes,
    onShaftClick,
    onShaftPointerMove,
    onShaftPointerOut,
}: {
    shaft: ProxyBezierShaft;
    color: string;
    emissive?: string;
    emissiveIntensity?: number;
    transparent?: boolean;
    opacity?: number;
    clippingPlanes?: THREE.Plane[] | null;
    onShaftClick?: (shaft: ProxyBezierShaft) => void;
    onShaftPointerMove?: (shaft: ProxyBezierShaft) => void;
    onShaftPointerOut?: () => void;
}) {
    const geometry = React.useMemo(() => {
        const curve = new THREE.CubicBezierCurve3(
            toVector3(shaft.start),
            toVector3(shaft.control1),
            toVector3(shaft.control2),
            toVector3(shaft.end),
        );
        const tubularSegments = Math.max(8, Math.min(48, shaft.resolution ?? 16));
        const radialSegments = 12;
        const g = new THREE.TubeGeometry(curve, tubularSegments, 1, radialSegments, false);

        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const ringSize = radialSegments + 1;
        const ringCount = tubularSegments + 1;
        const rStart = Math.max(0.001, shaft.diameterStart / 2);
        const rEnd = Math.max(0.001, shaft.diameterEnd / 2);

        for (let i = 0; i < ringCount; i++) {
            const u = i / tubularSegments;
            const center = curve.getPointAt(u);
            const r = THREE.MathUtils.lerp(rStart, rEnd, u);

            for (let j = 0; j < ringSize; j++) {
                const idx = i * ringSize + j;
                const x = pos.getX(idx);
                const y = pos.getY(idx);
                const z = pos.getZ(idx);
                const v = new THREE.Vector3(x, y, z);
                const dir = v.sub(center);
                const len = dir.length();
                if (len > 0) dir.multiplyScalar(1 / len);
                const nv = center.clone().add(dir.multiplyScalar(r));
                pos.setXYZ(idx, nv.x, nv.y, nv.z);
            }
        }

        pos.needsUpdate = true;
        g.computeVertexNormals();
        g.computeBoundingBox();
        g.computeBoundingSphere();
        return g;
    }, [
        shaft.start.x, shaft.start.y, shaft.start.z,
        shaft.end.x, shaft.end.y, shaft.end.z,
        shaft.control1.x, shaft.control1.y, shaft.control1.z,
        shaft.control2.x, shaft.control2.y, shaft.control2.z,
        shaft.diameterStart, shaft.diameterEnd, shaft.resolution,
    ]);

    React.useEffect(() => {
        return () => { geometry.dispose(); };
    }, [geometry]);

    return (
        <mesh
            onClick={onShaftClick ? (e) => { e.stopPropagation(); onShaftClick(shaft); } : undefined}
            onPointerMove={onShaftPointerMove ? (e) => { e.stopPropagation(); onShaftPointerMove(shaft); } : undefined}
            onPointerOut={onShaftPointerOut ? () => onShaftPointerOut() : undefined}
        >
            <primitive object={geometry} attach="geometry" />
            <meshStandardMaterial
                color={color}
                emissive={emissive ?? '#000000'}
                emissiveIntensity={emissiveIntensity ?? 0}
                transparent={transparent}
                opacity={opacity ?? 1}
                depthWrite={!transparent}
                clippingPlanes={clippingPlanes ?? undefined}
            />
        </mesh>
    );
}

function ProxyBezierShaftGroup({
    shafts,
    color,
    emissive,
    emissiveIntensity,
    transparent,
    opacity,
    clippingPlanes,
    onShaftClick,
    onShaftPointerMove,
    onShaftPointerOut,
}: ProxyBezierShaftGroupProps) {
    if (shafts.length === 0) return null;
    return (
        <group>
            {shafts.map((shaft) => (
                <ProxyBezierShaftItem
                    key={shaft.id}
                    shaft={shaft}
                    color={color}
                    emissive={emissive}
                    emissiveIntensity={emissiveIntensity}
                    transparent={transparent}
                    opacity={opacity}
                    clippingPlanes={clippingPlanes}
                    onShaftClick={onShaftClick}
                    onShaftPointerMove={onShaftPointerMove}
                    onShaftPointerOut={onShaftPointerOut}
                />
            ))}
        </group>
    );
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
  interiorView = false,
  cavityGeometryByModelId,
  modelWorldInverseById,
}: SupportProxyMeshLayerProps) {
  const { hit } = usePicking();
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

    const THRESHOLD_MM = 0.3;
    const RAY_HIT_EPSILON_MM = 1e-5;
    const RAY_DEDUPE_EPSILON_MM = 1e-4;
    const ids = new Set<string>();
    const tempVec = new THREE.Vector3();
    const insideRaycaster = new THREE.Raycaster();
    const insideRayDirection = new THREE.Vector3(1, 0.37139, 0.11317).normalize();
    const cavityMeshByGeometry = new Map<THREE.BufferGeometry, THREE.Mesh>();
    const queryTarget = { point: new THREE.Vector3(), distance: 0, faceIndex: -1 };

    // Ensure BVH is built on each cavity geometry
    for (const [, geometry] of cavityGeometryByModelId) {
      const g = geometry as THREE.BufferGeometry & { boundsTree?: { closestPointToPoint: Function } };
      if (!g.boundsTree && typeof (g as any).computeBoundsTree === 'function') {
        (g as any).computeBoundsTree();
      }
      cavityMeshByGeometry.set(geometry, new THREE.Mesh(geometry));
    }

    const isPointInsideCavityVolume = (pointLocal: THREE.Vector3, geometry: THREE.BufferGeometry): boolean => {
      const mesh = cavityMeshByGeometry.get(geometry);
      if (!mesh) return false;

      insideRaycaster.set(pointLocal, insideRayDirection);
      const hits = insideRaycaster.intersectObject(mesh, false);
      if (hits.length === 0) return false;

      let crossingCount = 0;
      let lastDistance = Number.NEGATIVE_INFINITY;
      for (const hit of hits) {
        if (hit.distance <= RAY_HIT_EPSILON_MM) continue;
        if (Math.abs(hit.distance - lastDistance) <= RAY_DEDUPE_EPSILON_MM) continue;
        lastDistance = hit.distance;
        crossingCount += 1;
      }

      return (crossingCount % 2) === 1;
    };

    const isPointOnCavitySurface = (pos: Vec3, modelId?: string): boolean => {
      const geometry = modelId ? cavityGeometryByModelId.get(modelId) : null;
      if (!geometry && !modelId) {
        for (const [, geom] of cavityGeometryByModelId) {
          const g = geom as THREE.BufferGeometry & { boundsTree?: { closestPointToPoint: Function } };
          tempVec.set(pos.x, pos.y, pos.z);
          if (g.boundsTree) {
            queryTarget.distance = Infinity;
            const result = g.boundsTree.closestPointToPoint(tempVec, queryTarget);
            if (result && result.distance < THRESHOLD_MM) return true;
          }
          if (isPointInsideCavityVolume(tempVec, geom)) return true;
        }
        return false;
      }
      if (!geometry) return false;
      const g = geometry as THREE.BufferGeometry & { boundsTree?: { closestPointToPoint: Function } };

      // Transform world-space support position into the model's local space
      tempVec.set(pos.x, pos.y, pos.z);
      if (modelId && modelWorldInverseById) {
        const invMatrix = modelWorldInverseById.get(modelId);
        if (invMatrix) {
          tempVec.applyMatrix4(invMatrix);
        }
      }

      if (g.boundsTree) {
        queryTarget.distance = Infinity;
        const result = g.boundsTree.closestPointToPoint(tempVec, queryTarget);
        if (result !== null && result.distance < THRESHOLD_MM) return true;
      }

      return isPointInsideCavityVolume(tempVec, geometry);
    };

    const isInteriorContactCone = (cone: { pos: Vec3; placementSurface?: 'interior' | 'exterior' } | undefined, modelId?: string): boolean => {
      if (!cone) return false;
      if (cone.placementSurface === 'interior') return true;
      if (cone.placementSurface === 'exterior') return false;
      return isPointOnCavitySurface(cone.pos, modelId);
    };

    const isInteriorContactDisk = (disk: { pos: Vec3; placementSurface?: 'interior' | 'exterior' } | undefined, modelId?: string): boolean => {
      if (!disk) return false;
      if (disk.placementSurface === 'interior') return true;
      if (disk.placementSurface === 'exterior') return false;
      return isPointOnCavitySurface(disk.pos, modelId);
    };

    // Trunks
    for (const trunk of Object.values(supportTrunks)) {
      if (isInteriorContactCone(trunk.contactCone, trunk.modelId)) {
        ids.add(`trunk:${trunk.id}`);
      }
    }
    for (const branch of Object.values(supportBranches)) {
      if (isInteriorContactCone(branch.contactCone, branch.modelId)) {
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
        existing = { modelId, shafts: [], taperedShafts: [], bezierShafts: [], roots: [], joints: [], cones: [] };
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

    const pushTaperedShaft = (shaft: ProxyTaperedShaft) => {
      ensureModel(shaft.modelId).taperedShafts.push(shaft);
      registerSegmentMeta(shaft.id, shaft.modelId, shaft.supportId);
    };

    const pushBezierShaft = (shaft: ProxyBezierShaft) => {
      ensureModel(shaft.modelId).bezierShafts.push(shaft);
      registerSegmentMeta(shaft.id, shaft.modelId, shaft.supportId);
    };

    // Emit a (possibly bezier, possibly tapered) segment into the proxy.
    // Straight uniform → instanced uniform shaft (fast path).
    // Straight tapered → non-instanced truncated-cone mesh.
    // Bezier → one continuous TubeGeometry along the curve. We do NOT sample
    // the curve into a chain of short straight cylinders — that produces
    // visible stepping/banding because every sub-cylinder has a uniform
    // radius and meets its neighbour at a slightly different radius.
    const emitSegment = (args: {
      segment: Segment;
      segmentId: string;
      supportId: string;
      modelId: string;
      start: Vec3;
      end: Vec3;
      diameterStart: number;
      diameterEnd: number;
    }) => {
      const { segment, segmentId, supportId, modelId, start, end, diameterStart, diameterEnd } = args;
      if (isBezierSegment(segment)) {
        pushBezierShaft({
          id: segmentId,
          supportId,
          modelId,
          start,
          end,
          control1: segment.controlPoint1,
          control2: segment.controlPoint2,
          resolution: segment.resolution,
          diameterStart,
          diameterEnd,
        });
        return;
      }
      const isTapered = Math.abs(diameterStart - diameterEnd) > 1e-4;
      if (isTapered) {
        pushTaperedShaft({
          id: segmentId,
          supportId,
          modelId,
          start,
          end,
          diameterStart,
          diameterEnd,
        });
        return;
      }
      pushShaft({
        id: segmentId,
        supportId,
        modelId,
        start,
        end,
        diameter: diameterStart,
      });
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

        emitSegment({
          segment,
          segmentId: segment.id,
          supportId: trunk.id,
          modelId: trunk.modelId,
          start: currentStart,
          end,
          diameterStart: segment.diameter,
          diameterEnd: segment.diameter,
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

        emitSegment({
          segment,
          segmentId: segment.id,
          supportId: branch.id,
          modelId: branch.modelId,
          start: currentStart,
          end,
          diameterStart: segment.diameter,
          diameterEnd: segment.diameter,
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
        }
      }
    }

    for (const twig of Object.values(supportTwigs)) {
      if (interiorSupportIdSet && !interiorSupportIdSet.has(`twig:${twig.id}`)) continue;
      if (includeDetailedPrimitives) {
        pushCone(toProxyConeFromTwigDisk(twig.contactDiskA, twig.id, twig.modelId));
        pushCone(toProxyConeFromTwigDisk(twig.contactDiskB, twig.id, twig.modelId));
      }

      // Per-segment cumulative-length taper from disk A to disk B (SSOT
      // lives in twigTaper.ts). Each segment carries its own diameterStart
      // / diameterEnd so the proxy shows the real tapered/curved rod.
      const taperBySegment = resolveTwigSegmentDiameters(twig);

      for (const segment of twig.segments) {
        const taper = taperBySegment.get(segment.id);
        const diameterStart = taper?.diameterStart ?? segment.diameter;
        const diameterEnd = taper?.diameterEnd ?? segment.diameter;

        if (includeDetailedPrimitives && segment.bottomJoint) {
          // Twig joints follow the 1.10× rule based on local twig diameter.
          pushJoint({
            id: segment.bottomJoint.id,
            pos: segment.bottomJoint.pos,
            diameter: twigJointDiameterForLocalDiameter(diameterStart),
            supportId: twig.id,
            modelId: twig.modelId,
          });
        }

        const start = segment.bottomJoint?.pos ?? getDiskTipCenter(twig.contactDiskA);
        const end = segment.topJoint?.pos ?? getDiskTipCenter(twig.contactDiskB);

        emitSegment({
          segment,
          segmentId: segment.id,
          supportId: twig.id,
          modelId: twig.modelId,
          start,
          end,
          diameterStart,
          diameterEnd,
        });

        if (includeDetailedPrimitives && segment.topJoint) {
          pushJoint({
            id: segment.topJoint.id,
            pos: segment.topJoint.pos,
            diameter: twigJointDiameterForLocalDiameter(diameterEnd),
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

        emitSegment({
          segment,
          segmentId: segment.id,
          supportId: stick.id,
          modelId: stick.modelId,
          start,
          end,
          diameterStart: segment.diameter,
          diameterEnd: segment.diameter,
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

      const segmentId = `braceSegment:${brace.id}`;
      const bezier = brace.curve?.type === 'bezier' ? brace.curve : null;

      if (bezier) {
        // Render the curved brace as one continuous TubeGeometry mirroring
        // the full-renderer path, so it shows a smooth taper instead of a
        // stack of stepped cylinders.
        pushBezierShaft({
          id: segmentId,
          supportId: brace.id,
          modelId: brace.modelId,
          start: startKnot.pos,
          end: endKnot.pos,
          control1: bezier.controlPoint1,
          control2: bezier.controlPoint2,
          resolution: bezier.resolution,
          diameterStart: startHostDiameter,
          diameterEnd: endHostDiameter,
        });
      } else if (Math.abs(startHostDiameter - endHostDiameter) > 1e-4) {
        pushTaperedShaft({
          id: segmentId,
          supportId: brace.id,
          modelId: brace.modelId,
          start: startKnot.pos,
          end: endKnot.pos,
          diameterStart: startHostDiameter,
          diameterEnd: endHostDiameter,
        });
      } else {
        pushShaft({
          id: segmentId,
          supportId: brace.id,
          modelId: brace.modelId,
          start: startKnot.pos,
          end: endKnot.pos,
          diameter: startHostDiameter,
        });
      }
    }

    // Knots are interaction affordances (branch/brace attachment point drag handles) rendered
    // only for selected supports in the full SupportRenderer. Omitting them from the proxy
    // avoids visible hemisphere bumps at every trunk segment split point.

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
        emitSegment({
          segment,
          segmentId: segment.id,
          supportId: kickstand.id,
          modelId: kickstand.modelId,
          start: currentStart,
          end,
          diameterStart: segment.diameter,
          diameterEnd: segment.diameter,
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
    if (hit.category === 'gizmo') return;
    onModelPointerSelect?.(shaft.modelId);
  }, [hit.category, onModelPointerSelect, pointerSelectionEnabled]);

  const handleProxyShaftPointerMove = React.useCallback((shaft: InstancedShaft) => {
    if (!pointerHoverEnabled) return;
    setSupportHoverModel(shaft.modelId ?? null);
  }, [pointerHoverEnabled, setSupportHoverModel]);

  const handleProxyTaperedShaftClick = React.useCallback((shaft: ProxyTaperedShaft) => {
    if (!pointerSelectionEnabled) return;
    if (!shaft.modelId) return;
    if (hit.category === 'gizmo') return;
    onModelPointerSelect?.(shaft.modelId);
  }, [hit.category, onModelPointerSelect, pointerSelectionEnabled]);

  const handleProxyTaperedShaftPointerMove = React.useCallback((shaft: ProxyTaperedShaft) => {
    if (!pointerHoverEnabled) return;
    setSupportHoverModel(shaft.modelId ?? null);
  }, [pointerHoverEnabled, setSupportHoverModel]);

  const handleProxyBezierShaftClick = React.useCallback((shaft: ProxyBezierShaft) => {
    if (!pointerSelectionEnabled) return;
    if (!shaft.modelId) return;
    if (hit.category === 'gizmo') return;
    onModelPointerSelect?.(shaft.modelId);
  }, [hit.category, onModelPointerSelect, pointerSelectionEnabled]);

  const handleProxyBezierShaftPointerMove = React.useCallback((shaft: ProxyBezierShaft) => {
    if (!pointerHoverEnabled) return;
    setSupportHoverModel(shaft.modelId ?? null);
  }, [pointerHoverEnabled, setSupportHoverModel]);

  const handleProxyRootClick = React.useCallback((root: InstancedRoot) => {
    if (!pointerSelectionEnabled) return;
    if (!root.modelId) return;
    if (hit.category === 'gizmo') return;
    onModelPointerSelect?.(root.modelId);
  }, [hit.category, onModelPointerSelect, pointerSelectionEnabled]);

  const handleProxyRootPointerMove = React.useCallback((root: InstancedRoot) => {
    if (!pointerHoverEnabled) return;
    setSupportHoverModel(root.modelId ?? null);
  }, [pointerHoverEnabled, setSupportHoverModel]);

  const handleProxyJointClick = React.useCallback((joint: InstancedJoint) => {
    if (!pointerSelectionEnabled) return;
    if (!joint.modelId) return;
    if (hit.category === 'gizmo') return;
    onModelPointerSelect?.(joint.modelId);
  }, [hit.category, onModelPointerSelect, pointerSelectionEnabled]);

  const handleProxyJointPointerMove = React.useCallback((joint: InstancedJoint) => {
    if (!pointerHoverEnabled) return;
    setSupportHoverModel(joint.modelId ?? null);
  }, [pointerHoverEnabled, setSupportHoverModel]);

  const handleProxyConeClick = React.useCallback((cone: InstancedContactCone) => {
    if (!pointerSelectionEnabled) return;
    if (!cone.modelId) return;
    if (hit.category === 'gizmo') return;
    onModelPointerSelect?.(cone.modelId);
  }, [hit.category, onModelPointerSelect, pointerSelectionEnabled]);

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

  // Flatten all visible model geometries into two batched groups (base + highlighted) so the
  // entire scene is rendered with a constant number of draw calls regardless of model count.
  // This restores the "singular mesh" performance characteristic that was lost when per-model
  // groups were introduced in the ZIP Import / Batch Export refactor.
  const flattenedGeometry = React.useMemo(() => {
    const createEmpty = (): FlatProxyGeometry => ({ shafts: [], taperedShafts: [], bezierShafts: [], roots: [], joints: [], cones: [] });
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

    const appendTaperedShaft = (target: FlatProxyGeometry, shaft: ProxyTaperedShaft, zOffset: number) => {
      if (Math.abs(zOffset) < 1e-6) {
        target.taperedShafts.push(shaft);
        return;
      }
      target.taperedShafts.push({
        ...shaft,
        start: { x: shaft.start.x, y: shaft.start.y, z: shaft.start.z + zOffset },
        end: { x: shaft.end.x, y: shaft.end.y, z: shaft.end.z + zOffset },
      });
    };

    const appendBezierShaft = (target: FlatProxyGeometry, shaft: ProxyBezierShaft, zOffset: number) => {
      if (Math.abs(zOffset) < 1e-6) {
        target.bezierShafts.push(shaft);
        return;
      }
      target.bezierShafts.push({
        ...shaft,
        start: { x: shaft.start.x, y: shaft.start.y, z: shaft.start.z + zOffset },
        end: { x: shaft.end.x, y: shaft.end.y, z: shaft.end.z + zOffset },
        control1: { x: shaft.control1.x, y: shaft.control1.y, z: shaft.control1.z + zOffset },
        control2: { x: shaft.control2.x, y: shaft.control2.y, z: shaft.control2.z + zOffset },
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
      for (const shaft of entry.geometry.taperedShafts) appendTaperedShaft(target, shaft, zOffset);
      for (const shaft of entry.geometry.bezierShafts) appendBezierShaft(target, shaft, zOffset);
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
    || flattenedGeometry.base.taperedShafts.length > 0
    || flattenedGeometry.base.bezierShafts.length > 0
    || flattenedGeometry.base.roots.length > 0
    || (includeDetailedPrimitives && (flattenedGeometry.base.joints.length > 0 || flattenedGeometry.base.cones.length > 0));

  const hasHighlighted = flattenedGeometry.highlighted.shafts.length > 0
    || flattenedGeometry.highlighted.taperedShafts.length > 0
    || flattenedGeometry.highlighted.bezierShafts.length > 0
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
              radialSegments={16}
              clippingPlanes={clippingPlanes}
              outOfBoundsMaterial={outOfBoundsMaterial}
              onShaftClick={pointerSelectionEnabled ? handleProxyShaftClick : undefined}
              onShaftPointerMove={pointerHoverEnabled ? handleProxyShaftPointerMove : undefined}
              onShaftPointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}
          {flattenedGeometry.base.taperedShafts.length > 0 && (
            <ProxyTaperedShaftGroup
              shafts={flattenedGeometry.base.taperedShafts}
              color={DEFAULT_SUPPORT_COLOR}
              transparent={proxyTransparent}
              opacity={proxyOpacity}
              clippingPlanes={clippingPlanes}
              onShaftClick={pointerSelectionEnabled ? handleProxyTaperedShaftClick : undefined}
              onShaftPointerMove={pointerHoverEnabled ? handleProxyTaperedShaftPointerMove : undefined}
              onShaftPointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}
          {flattenedGeometry.base.bezierShafts.length > 0 && (
            <ProxyBezierShaftGroup
              shafts={flattenedGeometry.base.bezierShafts}
              color={DEFAULT_SUPPORT_COLOR}
              transparent={proxyTransparent}
              opacity={proxyOpacity}
              clippingPlanes={clippingPlanes}
              onShaftClick={pointerSelectionEnabled ? handleProxyBezierShaftClick : undefined}
              onShaftPointerMove={pointerHoverEnabled ? handleProxyBezierShaftPointerMove : undefined}
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
              radialSegments={16}
              clippingPlanes={clippingPlanes}
              outOfBoundsMaterial={outOfBoundsMaterial}
              onShaftClick={pointerSelectionEnabled ? handleProxyShaftClick : undefined}
              onShaftPointerMove={pointerHoverEnabled ? handleProxyShaftPointerMove : undefined}
              onShaftPointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}
          {flattenedGeometry.highlighted.taperedShafts.length > 0 && (
            <ProxyTaperedShaftGroup
              shafts={flattenedGeometry.highlighted.taperedShafts}
              color={ACTIVE_SUPPORT_COLOR}
              transparent={proxyTransparent}
              opacity={proxyOpacity}
              clippingPlanes={clippingPlanes}
              onShaftClick={pointerSelectionEnabled ? handleProxyTaperedShaftClick : undefined}
              onShaftPointerMove={pointerHoverEnabled ? handleProxyTaperedShaftPointerMove : undefined}
              onShaftPointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}
          {flattenedGeometry.highlighted.bezierShafts.length > 0 && (
            <ProxyBezierShaftGroup
              shafts={flattenedGeometry.highlighted.bezierShafts}
              color={ACTIVE_SUPPORT_COLOR}
              transparent={proxyTransparent}
              opacity={proxyOpacity}
              clippingPlanes={clippingPlanes}
              onShaftClick={pointerSelectionEnabled ? handleProxyBezierShaftClick : undefined}
              onShaftPointerMove={pointerHoverEnabled ? handleProxyBezierShaftPointerMove : undefined}
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
              onConeClick={pointerSelectionEnabled ? (cone) => handleProxyConeClick(cone) : undefined}
              onConePointerMove={pointerHoverEnabled ? handleProxyConePointerMove : undefined}
              onConePointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}
        </group>
      )}

      {hoveredOverlayEntry && (
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
              opacity={hoverOverlayOpacity}
              radialSegments={16}
              clippingPlanes={clippingPlanes}
              onShaftClick={pointerSelectionEnabled ? handleProxyShaftClick : undefined}
              onShaftPointerMove={pointerHoverEnabled ? handleProxyShaftPointerMove : undefined}
              onShaftPointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}

          {hoveredOverlayEntry.geometry.taperedShafts.length > 0 && (
            <ProxyTaperedShaftGroup
              shafts={hoveredOverlayEntry.geometry.taperedShafts}
              color={hoveredOverlayColor}
              emissive={hoveredOverlayColor}
              emissiveIntensity={0.1}
              transparent={hoverOverlayTransparent}
              opacity={hoverOverlayOpacity}
              clippingPlanes={clippingPlanes}
              onShaftClick={pointerSelectionEnabled ? handleProxyTaperedShaftClick : undefined}
              onShaftPointerMove={pointerHoverEnabled ? handleProxyTaperedShaftPointerMove : undefined}
              onShaftPointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}

          {hoveredOverlayEntry.geometry.bezierShafts.length > 0 && (
            <ProxyBezierShaftGroup
              shafts={hoveredOverlayEntry.geometry.bezierShafts}
              color={hoveredOverlayColor}
              emissive={hoveredOverlayColor}
              emissiveIntensity={0.1}
              transparent={hoverOverlayTransparent}
              opacity={hoverOverlayOpacity}
              clippingPlanes={clippingPlanes}
              onShaftClick={pointerSelectionEnabled ? handleProxyBezierShaftClick : undefined}
              onShaftPointerMove={pointerHoverEnabled ? handleProxyBezierShaftPointerMove : undefined}
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

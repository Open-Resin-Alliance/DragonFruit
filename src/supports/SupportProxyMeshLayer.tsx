import React from 'react';
import * as THREE from 'three';
import { useSyncExternalStore } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { useThree } from '@react-three/fiber';
import { usePicking } from '@/components/picking';
import { supportAnswersPointer, SCENERY_DIM } from '@/features/scene/plates/plateInteractivity';
import { isCurvedBatchedShaft } from './Curves/batchedBezierTubeGeometry';
import { subscribe, getSnapshot } from './state';
// Loading the generated barrel runs every type's proxy geometry registration.
import './generatedSupportRegistrations';
import { supportProxyGeometryOf, type ProxyGeometryContext } from './proxyGeometry/seam';
import { getRaftSettings, subscribeToRaftStore } from './Rafts/Crenelated/RaftState';
import { JOINT_DIAMETER_OFFSET_MM } from './constants';
import { InstancedShaftGroup, type InstancedShaft } from './SupportPrimitives/Shaft/InstancedShaftGroup';
import { InstancedRootsGroup, type InstancedRoot } from './SupportPrimitives/Roots/InstancedRootsGroup';
import { InstancedJointGroup, type InstancedJoint } from './SupportPrimitives/Joint/InstancedJointGroup';
import { InstancedContactConeGroup, type InstancedContactCone } from './SupportPrimitives/ContactCone/InstancedContactConeGroup';
import { emitSupportModelPointerHover } from './interaction/clickHandlers';
import { bezierSegmentToBatchedShaft } from './Curves/batchedBezierShaft';
import type { Segment, SupportState, Vec3 } from './types';
import { MARQUEE_CANDIDATE_TINT_FACTOR } from '@/utils/marqueeCandidateTint';
import { SUPPORT_COLLECTION_KEYS, SUPPORT_TYPES, type SupportTypeId } from './supportTypeRegistry';
import { changedSupportModels, getSupportModelIndex, type SupportModelIndex } from './supportModelIndex';
import { perfLayerEnabled, perfMark, perfMeasure } from '@/utils/perfProbe';
import { buildProxyTiles, type FlatProxyGeometry } from './supportProxyTiles';
import {
    createCavityTester,
    interiorSupportIds,
    interiorSupportKey,
    isAnySegmentPointInterior,
    isInteriorContact,
} from './interiorSupportGeometry';

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
  /**
   * Models on another bed. Their supports are drawn dimmed and answer no pointer: hover,
   * click and drag start all resolve a model, and a model that is scenery is not one the
   * user is working on. Their shafts and cones also stay out of the hover index, which is
   * what makes this a saving and not only a rule.
   */
  pointerSceneryModelIds?: ReadonlySet<string>;
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
/**
 * Joint tessellation in the proxy view.
 *
 * A joint is a sub-millimetre ball and there are tens of thousands of them
 * (16,004 on a 20-model plate). The full support view's 12x10 sphere is 216
 * triangles per joint — 3.5M per layer — for a ball a few pixels wide. 8x6 is
 * 80 triangles and reads the same at this size; the detail view keeps the
 * denser sphere.
 */
const PROXY_JOINT_WIDTH_SEGMENTS = 8;
const PROXY_JOINT_HEIGHT_SEGMENTS = 6;

export type ProxyModelGeometry = {
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

/**
 * A dedicated stencil bit for the out-of-bounds stripe pass.
 *
 * Every kind draws its own stripe overlay, so wherever two of them overlap the
 * translucent stripe blended twice and read brighter than the rest. The first
 * overlay fragment to reach a pixel marks it and the rest are rejected, so each
 * pixel is blended once. `0x80` belongs to the mesh smoothing brush cursor, which
 * solves the same problem the same way (see `MeshSmoothingBrushCursor`).
 */
const OUT_OF_BOUNDS_STENCIL_BIT = 0x40;

export type ProxySupportTintInput = {
  selectedModelIds: ReadonlySet<string>;
  /**
   * Models standing on another bed, which are scenery: their supports take a dimmed
   * base colour, and no hover or marquee tint — nothing can point at them.
   */
  sceneryModelIds?: ReadonlySet<string>;
  hoverModelId: string | null;
  marqueeCandidateModelIds: readonly string[];
  /** The colour an untouched support takes. */
  baseColor: THREE.Color;
  /** The colour a selected support takes. */
  activeColor: THREE.Color;
  /** How far a hovered support moves from the base towards the active colour. */
  hoverStrength: number;
};

/**
 * The colour one support's instances take, given the selection and the hover.
 *
 * The tint is a *colour*, not a translucent pass over the batch: blending it on
 * top meant a hovered support's orange depended on what was underneath it, so a
 * support that was also selected came out a different orange than its
 * neighbours. A tint computed here replaces the base colour instead, so every
 * support of a hovered model reads the same, whatever its own state.
 *
 * A selected model keeps the active colour: the tint has nothing to add to a
 * support that already carries it.
 */
export function createProxySupportTint(input: ProxySupportTintInput): (modelId?: string) => THREE.Color {
  const hovered = new Set<string>();
  if (input.hoverModelId) hovered.add(input.hoverModelId);
  for (const modelId of input.marqueeCandidateModelIds) hovered.add(modelId);

  const strengthByModelId = new Map<string, number>();
  for (const modelId of hovered) {
    strengthByModelId.set(
      modelId,
      modelId === input.hoverModelId
        ? input.hoverStrength
        : input.hoverStrength * MARQUEE_CANDIDATE_TINT_FACTOR,
    );
  }

  const tintedByStrength = new Map<number, THREE.Color>();
  const tintAt = (strength: number) => {
    let tinted = tintedByStrength.get(strength);
    if (!tinted) {
      tinted = input.baseColor.clone().lerp(input.activeColor, strength);
      tintedByStrength.set(strength, tinted);
    }
    return tinted;
  };

  const dimmedBase = input.baseColor.clone().multiplyScalar(SCENERY_DIM);
  let dimmed: THREE.Color | null = null;

  return (modelId?: string) => {
    if (!modelId) return input.baseColor;
    if (input.selectedModelIds.has(modelId)) return input.activeColor;
    if (input.sceneryModelIds?.has(modelId)) {
      dimmed ??= dimmedBase;
      return dimmed;
    }
    const strength = strengthByModelId.get(modelId);
    return strength === undefined ? input.baseColor : tintAt(strength);
  };
}

/**
 * The one place the proxy primitives are built from the support state, shared by
 * every mounted layer: one identity per input is enough to reuse the walk.
 *
 * The key is the **collections**, not the snapshot. The store replaces the
 * snapshot on every write, and a hover writes it (`setHoveredState`), so keying
 * on the snapshot rebuilt all ~83k proxy primitives and re-laid out every
 * instance on each hover-target change — the repo measured that at 25-50 ms.
 * The walk reads the collections; every collection it can ask for is in
 * `SUPPORT_COLLECTION_KEYS`.
 */
type SharedProxyCacheEntry = {
  collectionRefs: readonly unknown[];
  hasSolidBottom: boolean;
  raftThickness: number;
  includeDetailedPrimitives: boolean;
  interiorSupportIdSet: Set<string> | null;
  index: SupportModelIndex;
  baseProxyByModel: Map<string, ProxyModelGeometry>;
};

let sharedProxyCache: SharedProxyCacheEntry | null = null;

function sameCollectionRefs(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const MODEL_NONE_KEY = '__none__';

function toModelKey(modelId?: string): string {
  return modelId ?? MODEL_NONE_KEY;
}

function fromModelKey(modelKey: string): string | undefined {
  return modelKey === MODEL_NONE_KEY ? undefined : modelKey;
}


/** Every proxy primitive the layer draws, grouped by model. Geometry only. */
export function collectProxyPrimitives(
    state: SupportState,
    options: {
        includeDetailedPrimitives: boolean;
        interiorSupportIdSet: Set<string> | null;
    },
    modelKeyFilter?: string,
): Map<string, ProxyModelGeometry> {
    const { includeDetailedPrimitives, interiorSupportIdSet } = options;

  const byModel = new Map<string, ProxyModelGeometry>();
  const segmentModelIdById = new Map<string, string | undefined>();
  const segmentSupportIdById = new Map<string, string | undefined>();
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

  // Curved segments become batched-shaft entries, drawn as capped tubes. The
  // unscoped STL/3MF export serializes this layer's scene graph, so curves must
  // be visible here too.
  const pushSegmentShafts = (segment: Segment, start: Vec3, end: Vec3, supportId: string, modelId?: string, diameterEnd?: number) => {
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
      ...(diameterEnd != null ? { diameterEnd } : {}),
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

  const context: ProxyGeometryContext = {
    state,
    includeDetailedPrimitives,
    pushShaft,
    pushSegmentShafts,
    pushRoot,
    pushJoint,
    pushCone,
  };

  // One walk over every type, each emitting its own registered recipe.
  for (const descriptor of SUPPORT_TYPES) {
    const registered = supportProxyGeometryOf(descriptor.id);
    if (!registered) continue;
    if (registered.registration.detailedOnly && !includeDetailedPrimitives) continue;
    if (registered.registration.skipInInteriorView && interiorSupportIdSet) continue;

    const entities = state[descriptor.location.key] as unknown as
      | Record<string, { id: string; typeId?: SupportTypeId; modelId?: string }>
      | undefined;
    for (const entity of Object.values(entities ?? {})) {
      // A per-model rebuild skips the other models before allocating anything.
      if (modelKeyFilter !== undefined && toModelKey(entity.modelId) !== modelKeyFilter) continue;
      if (interiorSupportIdSet && !interiorSupportIdSet.has(interiorSupportKey(entity))) continue;
      registered.build(entity as never, context);
    }
  }


  return byModel;
}


/**
 * Gives every instanced batch under it the tile's sphere and turns culling on.
 *
 * The primitive groups keep `frustumCulled={false}` for their other callers, and
 * an `InstancedMesh`'s bounds are computed from the unit geometry, not the
 * instances. A layout effect runs after the children exist and after R3F has
 * applied their props, so this is the one place that can set both correctly.
 */
function ProxyTileCuller({ sphere, children }: { sphere: THREE.Sphere | null; children: React.ReactNode }) {
  const groupRef = React.useRef<THREE.Group>(null);
  React.useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group || !sphere) return;
    group.traverse((object) => {
      const instanced = object as THREE.InstancedMesh;
      if (!instanced.isInstancedMesh) return;
      instanced.frustumCulled = true;
      instanced.boundingSphere = sphere;
    });
  });
  return <group ref={groupRef}>{children}</group>;
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
  pointerSceneryModelIds,
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
  const { camera, size } = useThree();
  const hitCategoryRef = React.useRef(hit.category);
  hitCategoryRef.current = hit.category;
  const supportState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const raftSettings = useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);

  // The walk reads the state itself, so the snapshot is the only identity needed.
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
      // Translucent on purpose: the stripe is a warning wash over the support, and
      // stripeAlpha is what makes it readable on top of it.
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      // Blend each pixel once, however many kinds' overlays land on it. The
      // fragment shader discards inside the bounds, and a discarded fragment
      // performs no stencil op, so only the striped pixels are marked.
      stencilWrite: true,
      stencilRef: OUT_OF_BOUNDS_STENCIL_BIT,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,
      stencilFuncMask: OUT_OF_BOUNDS_STENCIL_BIT,
      stencilWriteMask: OUT_OF_BOUNDS_STENCIL_BIT,
      uniforms: {
        boundsMin: { value: outOfBoundsMin.clone() },
        boundsMax: { value: outOfBoundsMax.clone() },
        stripeFreq: { value: 0.22 },
        stripeAlpha: { value: 0.42 },
        stripeColor: { value: new THREE.Color(outOfBoundsStripeColor ?? '#b6ff2e') },
      },
      // The batch kinds draw as instanced meshes, but the curved (branch) shafts
      // draw as merged meshes, and `instanceMatrix` only exists under
      // USE_INSTANCING. Without the guard the branch overlay's shader does not
      // compile, which is why branch shafts read differently from the rest.
      vertexShader: `
        varying vec3 vWorldPos;
        void main() {
          #ifdef USE_INSTANCING
            vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);
          #else
            vec4 worldPos = modelMatrix * vec4(position, 1.0);
          #endif
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
    const cavityTester = createCavityTester(cavityGeometryByModelId, modelWorldInverseById);
    return interiorSupportIds(
      supportState,
      (contact, modelId) => isInteriorContact(contact, modelId, cavityTester.isOnInteriorSide),
      (segments, modelId) => isAnySegmentPointInterior(segments, cavityTester.isOnInteriorSide, modelId),
    );
  }, [interiorView, cavityGeometryByModelId, modelWorldInverseById, supportState]);

  const supportCollectionRefs = React.useMemo(
    () => SUPPORT_COLLECTION_KEYS.map((key) => supportState[key]),
    [supportState],
  );

  const baseProxyByModel = React.useMemo(() => {
    const perfStart = perfMark();
    try {
    const cache = sharedProxyCache;
    const optionsSame = Boolean(cache)
      && cache!.hasSolidBottom === hasSolidBottom
      && cache!.raftThickness === raftThickness
      && cache!.includeDetailedPrimitives === includeDetailedPrimitives
      && cache!.interiorSupportIdSet === interiorSupportIdSet;
    if (optionsSame && sameCollectionRefs(cache!.collectionRefs, supportCollectionRefs)) {
      return cache!.baseProxyByModel;
    }

    const index = getSupportModelIndex(supportState as unknown as Record<string, unknown>);
    const options = { includeDetailedPrimitives, interiorSupportIdSet };
    // A support write replaces only the entities it touched, so every other
    // model's primitives are still valid: a model move rebuilds one model
    // instead of all twenty. An options change invalidates all of them.
    const changedModels = optionsSame ? changedSupportModels(cache!.index, index) : null;
    const previous = optionsSame ? cache!.baseProxyByModel : null;
    // A first build, or a change that moved most of the plate, is cheaper as one
    // walk than as a filtered pass per model: the filter still reads every
    // entity, so twenty passes read the plate twenty times.
    if (!previous || !changedModels || changedModels.size * 2 >= index.modelKeys.length) {
      const byModel = collectProxyPrimitives(supportState, options);
      sharedProxyCache = {
        collectionRefs: supportCollectionRefs,
        hasSolidBottom,
        raftThickness,
        includeDetailedPrimitives,
        interiorSupportIdSet,
        index,
        baseProxyByModel: byModel,
      };
      return byModel;
    }

    const byModel = new Map<string, ProxyModelGeometry>();

    for (const modelKey of index.modelKeys) {
      const reusable = !changedModels.has(modelKey) ? previous.get(modelKey) : undefined;
      if (reusable) {
        byModel.set(modelKey, reusable);
        continue;
      }
      const built = collectProxyPrimitives(supportState, options, modelKey).get(modelKey);
      if (built) byModel.set(modelKey, built);
    }

    sharedProxyCache = {
      collectionRefs: supportCollectionRefs,
      hasSolidBottom,
      raftThickness,
      includeDetailedPrimitives,
      interiorSupportIdSet,
      index,
      baseProxyByModel: byModel,
    };

    return byModel;
    } finally {
      perfMeasure('proxy:collect', perfStart);
    }
  }, [
    supportState,
    supportCollectionRefs,
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

  const allModelEntries = React.useMemo<VisibleModelEntry[]>(() => {
    const entries: VisibleModelEntry[] = [];
    for (const [modelKey, geometry] of modelEntries) {
      const modelId = fromModelKey(modelKey);
      entries.push({
        modelKey,
        modelId,
        geometry,
        zOffset: modelId ? (modelDropOffsetsById?.[modelId] ?? 0) : 0,
      });
    }
    return entries;
  }, [modelEntries, modelDropOffsetsById]);

  const visibleModelEntries = React.useMemo<VisibleModelEntry[]>(
    () => allModelEntries.filter((entry) => resolveModelVisible(entry.modelId)),
    [allModelEntries, resolveModelVisible],
  );

  // A filtered layer (the ghost and preview ones) draws one model and nothing
  // else, so it keeps filtering its geometry. The world layer keeps every model
  // in its batches and hides the excluded ones per instance instead: making a
  // model active then costs the changed instances, not a full re-layout.
  const hidesExcludedModels = !modelFilterId;
  const hiddenModelIds = React.useMemo(() => {
    if (!hidesExcludedModels) return null;
    const hidden = new Set<string>();
    for (const entry of allModelEntries) {
      if (entry.modelId && !resolveModelVisible(entry.modelId)) hidden.add(entry.modelId);
    }
    return hidden;
  }, [allModelEntries, hidesExcludedModels, resolveModelVisible]);

  const isHiddenPrimitive = React.useMemo(() => {
    if (!hiddenModelIds) return undefined;
    return (primitive: { modelId?: string }) => (
      primitive.modelId ? hiddenModelIds.has(primitive.modelId) : false
    );
  }, [hiddenModelIds]);

  const highlightedModelIdSet = React.useMemo(() => {
    const ids = new Set<string>();
    for (const id of selectedModelIds) ids.add(id);
    return ids;
  }, [selectedModelIds]);

  const effectiveHoverModelId = hoverModelId;

  const proxyOpacity = Math.max(0.05, Math.min(1, ghostOpacity));
  const proxyTransparent = proxyOpacity < 0.999;
  // How far a hovered support moves from its base colour towards the active one.
  // The ghost opacity is not part of it: the material carries that.
  const hoverOverlayStrength = Math.max(0.05, Math.min(1, hoverTintStrength));

  const pointerHoverEnabled = enablePointerSelection && mode === 'prepare';
  const pointerSelectionEnabled = enablePointerSelection && mode === 'prepare' && !!onModelPointerSelect;
  const pointerDragStartEnabled = enablePointerSelection && mode === 'prepare';

  const reportModelDragStart = React.useCallback((modelId: string | undefined, event: ThreeEvent<PointerEvent>) => {
    if (!pointerDragStartEnabled || !onModelPointerDragStart) return;
    if (!supportAnswersPointer(modelId, pointerSceneryModelIds)) return;
    if (!modelId) return;
    if (hitCategoryRef.current === 'gizmo') return;
    const native = event.nativeEvent as PointerEvent | undefined;
    if (native?.ctrlKey || native?.metaKey || native?.shiftKey) return;
    if (event.button !== 0) return;
    onModelPointerDragStart(modelId, event.clientX, event.clientY);
  }, [onModelPointerDragStart, pointerDragStartEnabled, pointerSceneryModelIds]);

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

  // Hover and clicks resolve a model, and the batch raycast answers which
  // instance was hit: the handler only reads its modelId, exactly as it did when
  // three walked the instances itself.
  const handleProxyInstanceMove = React.useCallback((primitive: { modelId?: string }) => {
    if (!supportAnswersPointer(primitive.modelId, pointerSceneryModelIds)) return;
    setSupportHoverModel(primitive.modelId ?? null);
  }, [setSupportHoverModel, pointerSceneryModelIds]);

  const handleProxyInstanceClick = React.useCallback((primitive: { modelId?: string }) => {
    if (!pointerSelectionEnabled) return;
    if (!supportAnswersPointer(primitive.modelId, pointerSceneryModelIds)) return;
    if (!primitive.modelId) return;
    if (hitCategoryRef.current === 'gizmo') return;
    onModelPointerSelect?.(primitive.modelId);
  }, [onModelPointerSelect, pointerSelectionEnabled, pointerSceneryModelIds]);

  const handleProxyPointerOut = React.useCallback(() => {
    scheduleSupportHoverClear();
  }, [scheduleSupportHoverClear]);

  // The selection and the hover tint both ride on per-instance colours: one batch
  // per primitive kind keeps drawing once, and a tint only rewrites colours. A
  // tint computed as a colour replaces the base, so a support's orange cannot
  // depend on what is underneath it.
  const supportColors = React.useMemo(() => ({
    base: new THREE.Color(DEFAULT_SUPPORT_COLOR),
    active: new THREE.Color(ACTIVE_SUPPORT_COLOR),
  }), []);

  const supportColorFor = React.useMemo(
    () => createProxySupportTint({
      selectedModelIds: highlightedModelIdSet,
      sceneryModelIds: pointerSceneryModelIds,
      hoverModelId: effectiveHoverModelId,
      marqueeCandidateModelIds,
      baseColor: supportColors.base,
      activeColor: supportColors.active,
      hoverStrength: hoverOverlayStrength,
    }),
    [
      effectiveHoverModelId,
      marqueeCandidateModelIds,
      highlightedModelIdSet,
      supportColors,
      hoverOverlayStrength,
      pointerSceneryModelIds,
    ],
  );

  const selectionColorFor = React.useCallback(
    (primitive: { modelId?: string }) => supportColorFor(primitive.modelId),
    [supportColorFor],
  );

  // Every visible model's primitives in one set of batches, so the whole scene
  // draws with a constant number of draw calls regardless of model count. This
  // restores the "singular mesh" performance characteristic that was lost when
  // per-model groups were introduced in the ZIP Import / Batch Export refactor.
  //
  // One set, not two. The live/scenery split existed so the other beds' batches
  // could fall out of the frustum as a group, because a single batch per kind
  // had bounds covering every plate. Tiles now give each handful of primitives
  // its own bounds, so the split no longer buys culling — and it cost a full
  // rebuild of every support array whenever the active plate or the selection
  // changed, because that changes which models are scenery. Switching plates or
  // clicking a bed therefore re-laid out ~78k instances inside the click. The
  // pointer filter still uses `pointerSceneryModelIds` to answer hits and tint.
  // Geometry arrays are built once per walk and kept stable when only which
  // models are *hidden* changes, so an exclusion change costs the instances that
  // changed state rather than a full re-layout.
  const buildFlatBatches = React.useCallback((entries: readonly VisibleModelEntry[], skipCurved: boolean) => {
    const empty = (): FlatProxyGeometry => ({ straightShafts: [], curvedShafts: [], roots: [], joints: [], cones: [] });
    const live = empty();
    const scenery = empty();

    const offsetShaft = (shaft: InstancedShaft, zOffset: number): InstancedShaft => {
      if (Math.abs(zOffset) < 1e-6) return shaft;
      const pushed: InstancedShaft = {
        ...shaft,
        start: { x: shaft.start.x, y: shaft.start.y, z: shaft.start.z + zOffset },
        end: { x: shaft.end.x, y: shaft.end.y, z: shaft.end.z + zOffset },
      };
      if (shaft.controlPoint1) pushed.controlPoint1 = { x: shaft.controlPoint1.x, y: shaft.controlPoint1.y, z: shaft.controlPoint1.z + zOffset };
      if (shaft.controlPoint2) pushed.controlPoint2 = { x: shaft.controlPoint2.x, y: shaft.controlPoint2.y, z: shaft.controlPoint2.z + zOffset };
      return pushed;
    };

    const appendRoot = (root: InstancedRoot, zOffset: number) => {
      const target = live;
      if (Math.abs(zOffset) < 1e-6) {
        target.roots.push(root);
        return;
      }
      target.roots.push({
        ...root,
        basePos: { x: root.basePos.x, y: root.basePos.y, z: root.basePos.z + zOffset },
      });
    };

    const appendJoint = (joint: InstancedJoint, zOffset: number) => {
      const target = live;
      if (Math.abs(zOffset) < 1e-6) {
        target.joints.push(joint);
        return;
      }
      target.joints.push({
        ...joint,
        pos: { x: joint.pos.x, y: joint.pos.y, z: joint.pos.z + zOffset },
      });
    };

    const appendCone = (cone: InstancedContactCone, zOffset: number) => {
      const target = live;
      if (Math.abs(zOffset) < 1e-6) {
        target.cones.push(cone);
        return;
      }
      target.cones.push({
        ...cone,
        pos: { x: cone.pos.x, y: cone.pos.y, z: cone.pos.z + zOffset },
      });
    };

    for (const entry of entries) {
      const { zOffset } = entry;

      for (const shaft of entry.geometry.shafts) {
        const curved = isCurvedBatchedShaft(shaft);
        if (skipCurved && curved) continue;
        (curved ? live.curvedShafts : live.straightShafts).push(offsetShaft(shaft, zOffset));
      }
      for (const root of entry.geometry.roots) appendRoot(root, zOffset);
      if (includeDetailedPrimitives) {
        for (const joint of entry.geometry.joints) appendJoint(joint, zOffset);
        for (const cone of entry.geometry.cones) appendCone(cone, zOffset);
      }
    }

    return { live, scenery };
  }, [includeDetailedPrimitives]);

  // The world layer's full set: every model, curved shafts filled in separately.
  const worldBatches = React.useMemo(
    () => (hidesExcludedModels ? buildFlatBatches(allModelEntries, true) : null),
    [allModelEntries, buildFlatBatches, hidesExcludedModels],
  );

  // A layer with a model filter draws that model alone, curved shafts included.
  const filteredBatches = React.useMemo(
    () => (hidesExcludedModels ? null : buildFlatBatches(visibleModelEntries, false)),
    [buildFlatBatches, hidesExcludedModels, visibleModelEntries],
  );

  // A merged tube cannot hide one shaft, so the world layer takes curved shafts
  // from the visible set. This is the only pass an exclusion change re-runs.
  const worldCurvedShafts = React.useMemo(() => {
    if (!hidesExcludedModels) return null;
    const live: InstancedShaft[] = [];
    const scenery: InstancedShaft[] = [];
    for (const entry of visibleModelEntries) {
      for (const shaft of entry.geometry.shafts) {
        if (!isCurvedBatchedShaft(shaft)) continue;
        const pushed: InstancedShaft = Math.abs(entry.zOffset) < 1e-6
          ? shaft
          : {
            ...shaft,
            start: { x: shaft.start.x, y: shaft.start.y, z: shaft.start.z + entry.zOffset },
            end: { x: shaft.end.x, y: shaft.end.y, z: shaft.end.z + entry.zOffset },
          };
        live.push(pushed);
      }
    }
    return { live, scenery };
  }, [hidesExcludedModels, visibleModelEntries]);

  const batches = React.useMemo(() => {
    if (!hidesExcludedModels || !worldBatches || !worldCurvedShafts) {
      return filteredBatches ?? buildFlatBatches([], false);
    }
    return {
      live: { ...worldBatches.live, curvedShafts: worldCurvedShafts.live },
      scenery: { ...worldBatches.scenery, curvedShafts: worldCurvedShafts.scenery },
    };
  }, [buildFlatBatches, filteredBatches, hidesExcludedModels, worldBatches, worldCurvedShafts]);

  // Tiles are cut from the base batch sets, not from `batches`: that object is
  // rebuilt whenever an exclusion changes (the active model folding in or out
  // at an orbit's start and end), and its only changed arrays are the curved
  // shafts, which tiles do not hold. Cutting again would hand every shaft, root
  // and joint group new arrays on release, which rebuilds their hover indexes
  // and is exactly the release hitch this memo must not reintroduce.
  const proxyTileSource = hidesExcludedModels ? worldBatches : filteredBatches;
  const proxyTiles = React.useMemo(() => {
    const perfStart = perfMark();
    try {
      return proxyTileSource
        ? buildProxyTiles(proxyTileSource.live, proxyTileSource.scenery)
        : { live: [], scenery: [] };
    } finally {
      perfMeasure('proxy:tiles', perfStart);
    }
  }, [proxyTileSource]);

  // A support a fraction of a pixel wide must still be grabbable, so the grab
  // radius grows with the distance: `GRAB_RADIUS_PX` of the viewport at the hit.
  // The shaft batch turns this into a hover index of its own, over the shafts it
  // actually draws - the index and the drawn list must agree, or a hit resolves
  // to a neighbouring support.
  const grabRadiusAt = React.useMemo(() => {
    const grabRadiusPx = 7;
    // `useThree().camera` is the R3F union; each member below is the concrete
    // camera the matching check selects.
    const perspectiveCamera = camera as THREE.PerspectiveCamera;
    const orthographicCamera = camera as THREE.OrthographicCamera;
    const viewportHeight = Math.max(1, size.height);
    return (distance: number) => {
      if (perspectiveCamera.isPerspectiveCamera) {
        const worldHeight = 2 * Math.tan((perspectiveCamera.fov * Math.PI) / 360) * distance;
        return (worldHeight / viewportHeight) * grabRadiusPx;
      }
      const worldHeight = (orthographicCamera.top - orthographicCamera.bottom) / Math.max(0.0001, orthographicCamera.zoom);
      return (worldHeight / viewportHeight) * grabRadiusPx;
    };
  }, [camera, size.height]);

  if (visibleModelEntries.length === 0 || !perfLayerEnabled('shapes')) {
    return null;
  }

  // Two batch sets, each with bounds of its own: the live one and the scenery one.
  // Separate is the point - see the memo above.
  const batchSets = [
    { key: 'live', geometry: batches.live },
    { key: 'scenery', geometry: batches.scenery },
  ];
  const hasBatch = (geometry: FlatProxyGeometry) => geometry.straightShafts.length > 0
    || geometry.curvedShafts.length > 0
    || geometry.roots.length > 0
    || (includeDetailedPrimitives && (geometry.joints.length > 0 || geometry.cones.length > 0));

  return (
    <group userData={{ dfPerfGroup: 'supports' }}>
      {batchSets.map(({ key, geometry }) => {
        const tiles = key === 'live' ? proxyTiles.live : proxyTiles.scenery;
        return hasBatch(geometry) && (
        <group key={`proxy-base-batch-${key}`}>
          {tiles.map((tile) => (tile.straightShafts.length + tile.roots.length + tile.joints.length) > 0 && (
            <ProxyTileCuller key={tile.key} sphere={tile.sphere}>
              {tile.straightShafts.length > 0 && (
                <InstancedShaftGroup
                  pointerSceneryModelIds={pointerSceneryModelIds}
                  shafts={tile.straightShafts}
                  color={DEFAULT_SUPPORT_COLOR}
                  instanceColor={selectionColorFor}
                  isHidden={isHiddenPrimitive}
                  transparent={proxyTransparent}
                  opacity={proxyOpacity}
                  radialSegments={10}
                  clippingPlanes={clippingPlanes}
                  outOfBoundsMaterial={outOfBoundsMaterial}
                  grabRadiusAt={grabRadiusAt}
                  onShaftClick={pointerSelectionEnabled ? handleProxyInstanceClick : undefined}
                  onShaftPointerDown={pointerDragStartEnabled ? (shaft, event) => reportModelDragStart(shaft.modelId, event) : undefined}
                  onShaftPointerMove={pointerHoverEnabled ? handleProxyInstanceMove : undefined}
                  onShaftPointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
                />
              )}
              {tile.roots.length > 0 && (
                <InstancedRootsGroup
                  roots={tile.roots}
                  color={DEFAULT_SUPPORT_COLOR}
                  instanceColor={selectionColorFor}
                  isHidden={isHiddenPrimitive}
                  transparent={proxyTransparent}
                  opacity={proxyOpacity}
                  clippingPlanes={clippingPlanes}
                  outOfBoundsMaterial={outOfBoundsMaterial}
                  onRootClick={pointerSelectionEnabled ? handleProxyInstanceClick : undefined}
                  onRootPointerDown={pointerDragStartEnabled ? (root, event) => reportModelDragStart(root.modelId, event) : undefined}
                  onRootPointerMove={pointerHoverEnabled ? handleProxyInstanceMove : undefined}
                  onRootPointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
                />
              )}
              {includeDetailedPrimitives && tile.joints.length > 0 && (
                <InstancedJointGroup
                  joints={tile.joints}
                  outOfBoundsMaterial={outOfBoundsMaterial}
                  color={DEFAULT_SUPPORT_COLOR}
                  instanceColor={selectionColorFor}
                  isHidden={isHiddenPrimitive}
                  transparent={proxyTransparent}
                  opacity={proxyOpacity}
                  clippingPlanes={clippingPlanes}
                  widthSegments={PROXY_JOINT_WIDTH_SEGMENTS}
                  heightSegments={PROXY_JOINT_HEIGHT_SEGMENTS}
                  grabRadiusAt={grabRadiusAt}
                  onJointClick={pointerSelectionEnabled ? handleProxyInstanceClick : undefined}
                  onJointPointerDown={pointerDragStartEnabled ? (joint, event) => reportModelDragStart(joint.modelId, event) : undefined}
                  onJointPointerMove={pointerHoverEnabled ? handleProxyInstanceMove : undefined}
                  onJointPointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
                />
              )}
            </ProxyTileCuller>
          ))}
          {geometry.curvedShafts.length > 0 && (
            <InstancedShaftGroup
              pointerSceneryModelIds={pointerSceneryModelIds}
              shafts={geometry.curvedShafts}
              color={DEFAULT_SUPPORT_COLOR}
              instanceColor={selectionColorFor}
              transparent={proxyTransparent}
              opacity={proxyOpacity}
              radialSegments={10}
              clippingPlanes={clippingPlanes}
              outOfBoundsMaterial={outOfBoundsMaterial}
              onShaftClick={pointerSelectionEnabled ? handleProxyInstanceClick : undefined}
              onShaftPointerDown={pointerDragStartEnabled ? (shaft, event) => reportModelDragStart(shaft.modelId, event) : undefined}
              onShaftPointerMove={pointerHoverEnabled ? handleProxyInstanceMove : undefined}
              onShaftPointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}
          {includeDetailedPrimitives && geometry.cones.length > 0 && (
            <InstancedContactConeGroup
              pointerSceneryModelIds={pointerSceneryModelIds}
              cones={geometry.cones}
              outOfBoundsMaterial={outOfBoundsMaterial}
              grabRadiusAt={grabRadiusAt}
              color={DEFAULT_SUPPORT_COLOR}
              instanceColor={selectionColorFor}
              isHidden={isHiddenPrimitive}
              transparent={proxyTransparent}
              opacity={proxyOpacity}
              clippingPlanes={clippingPlanes}
              onConeClick={pointerSelectionEnabled ? handleProxyInstanceClick : undefined}
              onConePointerDown={pointerDragStartEnabled ? (cone, event) => reportModelDragStart(cone.modelId, event) : undefined}
              onConePointerMove={pointerHoverEnabled ? handleProxyInstanceMove : undefined}
              onConePointerOut={pointerHoverEnabled ? handleProxyPointerOut : undefined}
            />
          )}
        </group>
        );
      })}

    </group>
  );
}

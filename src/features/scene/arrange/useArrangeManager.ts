import React from 'react';
import * as THREE from 'three';
import type { ScenePlate, useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import type { useTransformManager } from '@/features/transform/useTransformManager';
import type { ArrangeAnchorMode, ArrangeLayoutMode, ArrangePrecisionMode } from '@/components/controls/ArrangePanel';
import type { DuplicateLayoutMode } from '@/components/controls/DuplicatePanel';
import { type HullCacheEntry, type ArrangeModel as HighPrecisionArrangeModel } from '@/features/scene/arrange/highPrecisionArrange';
import { computeHighPrecisionArrangeResultWorker } from '@/features/scene/arrange/highPrecisionArrangeWorkerClient';
import { freeRectsForPlate, type PlateRect } from '@/features/scene/arrange/plateFreeSpace';
import { modelPlateScope } from '@/features/scene/plates/plateInteractivity';

type SceneManager = ReturnType<typeof useSceneCollectionManager>;
type TransformManager = ReturnType<typeof useTransformManager>;
type SceneModel = SceneManager['models'][number];
type ModelDimsMm = { width: number; depth: number; height: number };
type SupportAwareDimsFn = (model: SceneModel, rotationZOverride?: number, transformOverride?: SceneModel['transform']) => ModelDimsMm;
type FootprintPolygonFn = (model: SceneModel, rotationZOverride?: number, transformOverride?: SceneModel['transform']) => THREE.Vector2[];

/**
 * How many beds an arrange run will pack before giving up and setting the rest beside
 * the last one. A run adds a bed only when a full pass placed nothing new, so this is a
 * guard against a pathological set rather than a real limit — a plate holds hundreds of
 * small models.
 */
const MAX_ARRANGE_BEDS = 32;

/**
 * How far an arrange run may spread its models.
 *
 * `'plate'` keeps to the plate being worked on — overflow goes onto beds the run adds, and
 * no other bed in the scene is touched. `'plates'` fills the scene's beds before it makes
 * new ones, packing around whatever is already standing on them.
 */
export type ArrangePlateFillMode = 'plate' | 'plates';

/**
 * Where a lone model sits in a frame: the centre, or the corner the anchor mode names.
 *
 * Both the single-model branch and the pass that ends up with one model still to place
 * need this, and the high-precision packer answers nothing at all for a single target —
 * it is built to arrange a set, not to answer where one model goes.
 */
function loneModelCenter(
  frame: { minX: number; maxX: number; minY: number; maxY: number },
  dims: { width: number; depth: number },
  anchorMode: ArrangeAnchorMode,
): { x: number; y: number } {
  const halfWidth = dims.width * 0.5;
  const halfDepth = dims.depth * 0.5;

  if (anchorMode === 'front_left') return { x: frame.minX + halfWidth, y: frame.minY + halfDepth };
  if (anchorMode === 'front_right') return { x: frame.maxX - halfWidth, y: frame.minY + halfDepth };
  if (anchorMode === 'back_left') return { x: frame.minX + halfWidth, y: frame.maxY - halfDepth };
  if (anchorMode === 'back_right') return { x: frame.maxX - halfWidth, y: frame.maxY - halfDepth };
  return { x: (frame.minX + frame.maxX) * 0.5, y: (frame.minY + frame.maxY) * 0.5 };
}

/**
 * The last resort, kept from the days of one bed: models that cannot be packed anywhere
 * are set down in a column beside the beds rather than left stacked at the origin.
 *
 * The column starts left of every bed and walks further left as it fills. A model that
 * does not fit a bed is out of the build volume, but it has to be out of all of it —
 * beside a bed that has another bed to its left, a column would drop it half onto the
 * neighbour, and the out-of-volume check would be right to flag it. Left of the cascade is
 * the one side no bed — the ones already there or the ones a run adds — can reach.
 *
 * Positions come back in the active plate's own millimetres, like every other placement.
 */
function placeModelsBesideBeds<M>(args: {
  models: readonly M[];
  /** The active plate's frame, in its own millimetres: the column's height. */
  frame: PlateRect;
  spacingMm: number;
  /** Left edge of every bed, in world millimetres. */
  leftmostBedEdgeMm: number;
  activeOffset: { dxMm: number; dyMm: number };
  getRotationZ: (model: M) => number;
  getDims: (model: M) => { width: number; depth: number };
}): Array<{ model: M; rotationZ: number; positionX: number; positionY: number }> {
  const outsideGap = Math.max(8, args.spacingMm);
  let columnRightX = args.leftmostBedEdgeMm - outsideGap - args.activeOffset.dxMm;
  let columnYCursor = args.frame.minY;
  let columnMaxWidth = 0;

  return args.models.map((model) => {
    const dims = args.getDims(model);
    if (columnYCursor > args.frame.minY && (columnYCursor + dims.depth) > args.frame.maxY) {
      columnRightX -= columnMaxWidth + outsideGap;
      columnMaxWidth = 0;
      columnYCursor = args.frame.minY;
    }

    const positionX = columnRightX - dims.width * 0.5;
    const positionY = columnYCursor + dims.depth * 0.5;
    columnYCursor += dims.depth + args.spacingMm;
    columnMaxWidth = Math.max(columnMaxWidth, dims.width);

    return { model, rotationZ: args.getRotationZ(model), positionX, positionY };
  });
}

export type UseArrangeManagerOptions = {
  scene: SceneManager;
  transformMgr: TransformManager;
  sleep: (ms: number) => Promise<void>;
  displayActiveModelId: string | null;
  setDisplayActiveModelId: React.Dispatch<React.SetStateAction<string | null>>;
  setSupportRenderRefreshNonce: React.Dispatch<React.SetStateAction<number>>;
  supportBoundsByModelId: Map<string, THREE.Box3>;
  arrangeSpacingMm: number;
  getArrangeTransform: (model: SceneModel) => SceneModel['transform'];
  getModelSupportAwareDimensionsMm: SupportAwareDimsFn;
  getModelSupportAwareFootprintPolygonRef: React.MutableRefObject<FootprintPolygonFn>;
};

export function useArrangeManager({
  scene,
  transformMgr,
  sleep,
  displayActiveModelId,
  setDisplayActiveModelId,
  setSupportRenderRefreshNonce,
  supportBoundsByModelId,
  arrangeSpacingMm,
  getArrangeTransform,
  getModelSupportAwareDimensionsMm,
  getModelSupportAwareFootprintPolygonRef,
}: UseArrangeManagerOptions) {

  const [arrangePrecisionMode, setArrangePrecisionMode] = React.useState<ArrangePrecisionMode>('standard');
  const [arrangePlateFillMode, setArrangePlateFillMode] = React.useState<ArrangePlateFillMode>('plates');
  const [arrangeAllowRotateOnZ, setArrangeAllowRotateOnZ] = React.useState(false);
  const [arrangeLayoutMode, setArrangeLayoutMode] = React.useState<ArrangeLayoutMode>('auto');
  const [arrangeAnchorMode, setArrangeAnchorMode] = React.useState<ArrangeAnchorMode>('center');
  const [arrangeArrayCountX, setArrangeArrayCountX] = React.useState(3);
  const [arrangeArrayCountY, setArrangeArrayCountY] = React.useState(2);
  const [arrangeArrayCountZ, setArrangeArrayCountZ] = React.useState(1);
  const [arrangeArrayGapX, setArrangeArrayGapX] = React.useState(5);
  const [arrangeArrayGapY, setArrangeArrayGapY] = React.useState(5);
  const [arrangeArrayGapZ, setArrangeArrayGapZ] = React.useState(5);
  const [activeArrangeOperation, setActiveArrangeOperation] = React.useState<'standard' | 'high_precision' | 'high_precision_fill' | 'array' | null>(null);
  const [isAutoArranging, setIsAutoArranging] = React.useState(false);
  const [arrangeOverlayElapsedSec, setArrangeOverlayElapsedSec] = React.useState(0);
  const [arrangeOverlayModelCount, setArrangeOverlayModelCount] = React.useState<number | null>(null);
  const [duplicateTotalCopies, setDuplicateTotalCopies] = React.useState(1);
  const [duplicateSpacingMm, setDuplicateSpacingMm] = React.useState(0.5);
  const showArrangeBlockingOverlay = isAutoArranging;
  const arrangeOverlayContent = React.useMemo(() => {
    if (activeArrangeOperation === 'high_precision_fill') {
      return {
        title: 'High-Precision Fill Running…',
        detailLines: [
          'Using SAT-based 2.5D nesting to pack duplicates onto the plate.',
          'Please be patient while we compute the densest valid fill.',
        ],
      };
    }

    if (activeArrangeOperation === 'high_precision') {
      return {
        title: 'High-Precision Arrange Running…',
        detailLines: [
          'This is a computationally expensive operation for dense packing.',
          'Please be patient while we process your models.',
        ],
      };
    }

    if (activeArrangeOperation === 'array') {
      return {
        title: 'Applying Array Arrange…',
        detailLines: [
          'Positioning models and validating placement.',
          'Please wait a moment.',
        ],
      };
    }

    return {
      title: 'Arranging Models…',
      detailLines: [
        'Computing placements and resolving collisions.',
        'Please wait.',
      ],
    };
  }, [activeArrangeOperation]);
  React.useEffect(() => {
    if (!showArrangeBlockingOverlay) {
      setArrangeOverlayElapsedSec(0);
      return;
    }

    const startedAt = Date.now();
    const id = window.setInterval(() => {
      setArrangeOverlayElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);

    return () => window.clearInterval(id);
  }, [showArrangeBlockingOverlay]);
  const arrangeOverlayElapsedLabel = React.useMemo(() => {
    const total = Math.max(0, arrangeOverlayElapsedSec);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }, [arrangeOverlayElapsedSec]);
  const [duplicateLayoutMode, setDuplicateLayoutMode] = React.useState<DuplicateLayoutMode>('auto');
  const [duplicatePrecisionMode, setDuplicatePrecisionMode] = React.useState<ArrangePrecisionMode>('standard');
  const [duplicateArrayCountX, setDuplicateArrayCountX] = React.useState(2);
  const [duplicateArrayCountY, setDuplicateArrayCountY] = React.useState(1);
  const [duplicateArrayCountZ, setDuplicateArrayCountZ] = React.useState(1);
  const [duplicateArrayGapX, setDuplicateArrayGapX] = React.useState(5);
  const [duplicateArrayGapY, setDuplicateArrayGapY] = React.useState(5);
  const [duplicateArrayGapZ, setDuplicateArrayGapZ] = React.useState(5);
  const [isDuplicating, setIsDuplicating] = React.useState(false);
  const [duplicatePreviewTransforms, setDuplicatePreviewTransforms] = React.useState<Array<{
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  }>>([]);
  const [arrangeArrayPreviewItems, setArrangeArrayPreviewItems] = React.useState<Array<{
    model: (typeof scene.models)[number];
    transform: {
      position: THREE.Vector3;
      rotation: THREE.Euler;
      scale: THREE.Vector3;
    };
  }>>([]);
  const [duplicateSourcePreviewTransform, setDuplicateSourcePreviewTransform] = React.useState<{
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  } | null>(null);
  const [duplicateApplySourceModel, setDuplicateApplySourceModel] = React.useState<(typeof scene.models)[number] | null>(null);
  const [duplicateApplySourceTransform, setDuplicateApplySourceTransform] = React.useState<{
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  } | null>(null);
  const effectiveDuplicateTotalCopies = React.useMemo(() => {
    if (duplicateLayoutMode === 'array') {
      const countX = Math.max(1, Math.round(duplicateArrayCountX));
      const countY = Math.max(1, Math.round(duplicateArrayCountY));
      const countZ = Math.max(1, Math.round(duplicateArrayCountZ));
      return Math.max(1, Math.min(128, countX * countY * countZ));
    }

    if (duplicatePrecisionMode === 'high_precision') {
      return Math.max(1, duplicatePreviewTransforms.length + (duplicateSourcePreviewTransform ? 1 : 0));
    }

    return Math.max(1, Math.round(duplicateTotalCopies));
  }, [
    duplicateArrayCountX,
    duplicateArrayCountY,
    duplicateArrayCountZ,
    duplicateLayoutMode,
    duplicatePrecisionMode,
    duplicatePreviewTransforms.length,
    duplicateSourcePreviewTransform,
    duplicateTotalCopies,
  ]);
  const isDuplicateSetupBlockingArrange = Boolean(scene.activeModel) && effectiveDuplicateTotalCopies > 1;
  const arrangeHullFootprintCacheRef = React.useRef<Map<string, HullCacheEntry>>(new Map());
  React.useEffect(() => {
    if (arrangePrecisionMode !== 'high_precision') return;
    if (arrangeAllowRotateOnZ) return;
    setArrangeAllowRotateOnZ(true);
  }, [arrangePrecisionMode, arrangeAllowRotateOnZ]);
  const buildHighPrecisionArrangeSupportLocalPoints = React.useCallback((
    modelTransformById: Map<string, (typeof scene.models)[number]['transform']>,
  ) => {
    const supportLocalPointsByModelId = new Map<string, { points: THREE.Vector3[]; key: string }>();

    for (const model of scene.models) {
      const supportBounds = supportBoundsByModelId.get(model.id);
      if (!supportBounds || supportBounds.isEmpty()) continue;

      const t = modelTransformById.get(model.id) ?? model.transform;
      const worldMatrix = new THREE.Matrix4().compose(
        t.position,
        new THREE.Quaternion().setFromEuler(t.rotation),
        t.scale,
      );
      const invWorldMatrix = worldMatrix.clone().invert();

      const xs = [supportBounds.min.x, supportBounds.max.x];
      const ys = [supportBounds.min.y, supportBounds.max.y];
      const zs = [supportBounds.min.z, supportBounds.max.z];

      const points: THREE.Vector3[] = [];
      const seen = new Set<string>();
      const tmp = new THREE.Vector3();
      for (const x of xs) {
        for (const y of ys) {
          for (const z of zs) {
            tmp.set(x, y, z).applyMatrix4(invWorldMatrix);
            const dedupeKey = `${tmp.x.toFixed(4)}:${tmp.y.toFixed(4)}:${tmp.z.toFixed(4)}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            points.push(tmp.clone());
          }
        }
      }

      if (points.length === 0) continue;

      const key = [
        supportBounds.min.x.toFixed(4),
        supportBounds.min.y.toFixed(4),
        supportBounds.min.z.toFixed(4),
        supportBounds.max.x.toFixed(4),
        supportBounds.max.y.toFixed(4),
        supportBounds.max.z.toFixed(4),
        points.length,
      ].join('|');

      supportLocalPointsByModelId.set(model.id, { points, key });
    }

    return supportLocalPointsByModelId;
  }, [scene.models, supportBoundsByModelId]);

  const buildHighPrecisionArrangeModels = React.useCallback((
    sourceModels: (typeof scene.models),
    modelTransformById: Map<string, (typeof scene.models)[number]['transform']>,
  ): HighPrecisionArrangeModel[] => {
    const supportLocalPointsByModelId = buildHighPrecisionArrangeSupportLocalPoints(modelTransformById);

    return sourceModels.map((model): HighPrecisionArrangeModel => {
      const t = modelTransformById.get(model.id) ?? model.transform;
      const supportLocal = supportLocalPointsByModelId.get(model.id);

      return {
        id: model.id,
        visible: model.visible,
        transform: {
          position: t.position.clone(),
          rotation: t.rotation.clone(),
          scale: t.scale.clone(),
        },
        geometry: {
          center: model.geometry.center.clone(),
          geometry: model.geometry.geometry,
          supportLocalPoints: supportLocal?.points,
          supportHullKey: supportLocal?.key,
        },
      };
    });
  }, [buildHighPrecisionArrangeSupportLocalPoints]);

  /**
   * Where the active plate sits, in world millimetres: the cascade offset from the
   * first plate. Arrange packs in a plate's own frame, so a run on a later plate
   * needs this to come out on that plate rather than on plate 1.
   *
   * The members are listed one by one rather than depending on `scene` itself: the
   * manager object is new on every render, and a callback that changed with it rebuilt
   * the array-preview effect on every render, which set state from an effect on every
   * commit — React's "Maximum update depth exceeded". Keep these dependency lists
   * precise.
   */
  const arrangePlateOffset = React.useCallback(
    () => scene.plateOffsetFor(scene.activePlateId),
    [scene.activePlateId, scene.plateOffsetFor],
  );

  /**
   * The build area a run packs, in millimetres.
   *
   * Arrange works in a plate's own frame — the one `view3dSettings` describes — and a
   * scene's later plates are drawn at a cascade offset from the first. The offset
   * defaults to the active plate's, so a run on plate 2 packs into plate 2's bounds
   * instead of dropping its models onto plate 1; a bed an overflow pass is about to
   * land on passes its own once it exists. The models a run may touch come from
   * `resolveArrangeVisibleModels`, which is scoped to the active plate.
   */
  const resolveArrangeFrame = React.useCallback((offset?: { dxMm: number; dyMm: number }) => {
    const { originMode, widthMm, depthMm, safetyMarginMm } = scene.view3dSettings;
    const { dxMm, dyMm } = offset ?? arrangePlateOffset();
    const rawMinX = (originMode === 'front_left' ? 0 : -widthMm * 0.5) + dxMm;
    const rawMaxX = rawMinX + widthMm;
    const rawMinY = (originMode === 'front_left' ? 0 : -depthMm * 0.5) + dyMm;
    const rawMaxY = rawMinY + depthMm;
    const minX = rawMinX + Math.max(0, safetyMarginMm?.left ?? 0);
    const maxX = rawMaxX - Math.max(0, safetyMarginMm?.right ?? 0);
    const minY = rawMinY + Math.max(0, safetyMarginMm?.front ?? 0);
    const maxY = rawMaxY - Math.max(0, safetyMarginMm?.back ?? 0);

    return {
      dxMm,
      dyMm,
      minX,
      maxX,
      minY,
      maxY,
      width: Math.max(1, maxX - minX),
      depth: Math.max(1, maxY - minY),
    };
  }, [arrangePlateOffset, scene.view3dSettings]);

  /**
   * The beds a run fills, in the order it fills them, each with the room already taken on
   * it.
   *
   * `'plates'` — the scene's own beds are used up before a new one is made: the plate
   * being worked on first, then every other bed, in cascade order.
   * `'plate'` — only the plate being worked on; whatever does not fit goes onto beds this
   * run adds.
   *
   * Everything standing on a bed counts as taken except the models this run is placing,
   * so a bed that is already carrying models is filled around them rather than skipped or
   * stacked on. Rectangles come back in the bed's own millimetres, which is the frame the
   * packers place in.
   */
  const resolveArrangeBedTargets = React.useCallback((
    mode: ArrangePlateFillMode,
    runModelIds: ReadonlySet<string>,
  ): Array<{ plateId: string; occupied: PlateRect[] }> => {
    const otherBeds = mode === 'plates'
      ? scene.plates.filter((plate) => plate.id !== scene.activePlateId && !scene.isPlateLocked(plate.id))
      : [];

    const plateIds = [scene.activePlateId, ...otherBeds.map((plate) => plate.id)];

    return plateIds.map((plateId) => {
      const { dxMm, dyMm } = scene.plateOffsetFor(plateId);
      const occupied: PlateRect[] = [];

      for (const model of scene.models) {
        if (runModelIds.has(model.id)) continue;
        if (scene.resolveModelPlateId(model) !== plateId) continue;

        const t = getArrangeTransform(model);
        const dims = getModelSupportAwareDimensionsMm(model, undefined, t);
        const x = t.position.x - dxMm;
        const y = t.position.y - dyMm;

        occupied.push({
          minX: x - dims.width * 0.5,
          maxX: x + dims.width * 0.5,
          minY: y - dims.depth * 0.5,
          maxY: y + dims.depth * 0.5,
        });
      }

      return { plateId, occupied };
    });
  }, [
    getArrangeTransform,
    getModelSupportAwareDimensionsMm,
    scene.activePlateId,
    scene.isPlateLocked,
    scene.models,
    scene.plateOffsetFor,
    scene.plates,
    scene.resolveModelPlateId,
  ]);

  const resolveArrangeVisibleModels = React.useCallback((scope: 'all' | 'selected', explicitSelectedIds?: string[]) => {
    // An arrange run packs one plate — the one whose tool asked for it, which is the
    // active one. A scene-wide sweep would pack the other beds' models into this
    // plate's frame, which is how arranging plate 2 moved its models onto plate 1.
    const onActivePlate = (model: SceneModel) => (
      scene.resolveModelPlateId(model) === scene.activePlateId
    );
    // A model standing on no plate at all is broken whichever bed asked for the arrange,
    // so every run takes it: arranging is what puts it back on a bed. It is the same rule
    // the canvas uses to decide a model is loose, not a second one.
    const standsOnNoPlate = (model: SceneModel) => modelPlateScope({
      position: model.transform.position,
      frames: scene.plateFrames,
      activePlateId: scene.activePlateId,
      plateCount: scene.plates.length,
    }) === 'loose';
    const inRun = (model: SceneModel) => onActivePlate(model) || standsOnNoPlate(model);

    if (scope === 'all') {
      return scene.models.filter((m) => m.visible && inRun(m));
    }

    const selectedIdSet = new Set(explicitSelectedIds ?? scene.selectedModelIds);

    // Guard against transient selection desync: ensure active model participates
    // when user arranges selected models and the active model is visible.
    if (scene.activeModelId) {
      const activeVisible = scene.models.some((m) => m.id === scene.activeModelId && m.visible);
      if (activeVisible) selectedIdSet.add(scene.activeModelId);
    }

    return scene.models.filter((m) => m.visible && selectedIdSet.has(m.id) && inRun(m));
  }, [
    scene.activeModelId,
    scene.activePlateId,
    scene.models,
    scene.plateFrames,
    scene.plates.length,
    scene.resolveModelPlateId,
    scene.selectedModelIds,
  ]);

  const applyArrangeTransforms = React.useCallback((
    updates: Array<{
      id: string;
      transform: {
        position: THREE.Vector3;
        rotation: THREE.Euler;
        scale: THREE.Vector3;
      };
    }>,
    /**
     * The beds as they stood before the run and as they stand after it, when the run
     * added some of them: the beds and the placements are then one undo step.
     */
    historyOptions?: {
      platesBefore?: { plates: ScenePlate[]; activePlateId: string };
      platesAfter?: { plates: ScenePlate[]; activePlateId: string };
    },
  ) => {
    if (updates.length === 0) return;

    const isFiniteNumber = (n: number) => Number.isFinite(n) && !Number.isNaN(n);
    const sanitizedUpdates = updates.filter((update) => {
      const { position, rotation, scale } = update.transform;
      return isFiniteNumber(position.x)
        && isFiniteNumber(position.y)
        && isFiniteNumber(position.z)
        && isFiniteNumber(rotation.x)
        && isFiniteNumber(rotation.y)
        && isFiniteNumber(rotation.z)
        && isFiniteNumber(scale.x)
        && isFiniteNumber(scale.y)
        && isFiniteNumber(scale.z);
    });

    if (sanitizedUpdates.length === 0) {
      console.warn('[Arrange][HighPrecision] Skipping apply: all computed transforms were non-finite.');
      return;
    }

    if (sanitizedUpdates.length !== updates.length) {
      console.warn('[Arrange][HighPrecision] Dropped non-finite transforms:', {
        dropped: updates.length - sanitizedUpdates.length,
        total: updates.length,
      });
    }

    scene.updateModelTransforms(sanitizedUpdates, historyOptions?.platesBefore
      ? { platesBefore: historyOptions.platesBefore, platesAfter: historyOptions.platesAfter }
      : undefined);
    setSupportRenderRefreshNonce((prev) => prev + 1);

    if (!scene.activeModelId || displayActiveModelId !== scene.activeModelId) {
      return;
    }

    const activeUpdate = sanitizedUpdates.find((update) => update.id === scene.activeModelId);
    if (!activeUpdate) return;

    const { position, rotation, scale } = activeUpdate.transform;
    transformMgr.transformHook.setPosition(position.x, position.y, position.z);
    transformMgr.transformHook.setRotation(rotation.x, rotation.y, rotation.z);
    transformMgr.transformHook.setScale(scale.x, scale.y, scale.z);
  }, [displayActiveModelId, scene, transformMgr.transformHook]);

  const handleAutoArrangeModels = React.useCallback(async (
    scope: 'all' | 'selected',
    explicitSelectedIds?: string[],
    /**
     * A one-off run can ask for its own spacing, Z-rotation and reach — the plate's
     * arrange button does, at 1mm with rotation allowed and to that plate alone — without
     * disturbing the panel's settings, which the panel's own runs use.
     */
    overrides?: { spacingMm?: number; allowRotateOnZ?: boolean; plateFillMode?: ArrangePlateFillMode },
  ) => {
    const spacingMmForRun = overrides?.spacingMm ?? arrangeSpacingMm;
    const allowRotateOnZForRun = overrides?.allowRotateOnZ ?? arrangeAllowRotateOnZ;
    const plateFillModeForRun = overrides?.plateFillMode ?? arrangePlateFillMode;
    if (isAutoArranging) return;

    const visibleModels = resolveArrangeVisibleModels(scope, explicitSelectedIds);

    if (visibleModels.length <= 1) {
      if (visibleModels.length === 1) {
        const model = visibleModels[0];
        const t = getArrangeTransform(model);
        const dims = getModelSupportAwareDimensionsMm(model, undefined, t);

        const { minX, maxX, minY, maxY } = resolveArrangeFrame();
        const { x: centerX, y: centerY } = loneModelCenter({ minX, maxX, minY, maxY }, dims, arrangeAnchorMode);

        // Arrange and Duplicate previews should never overlap.
        setDuplicateApplySourceModel(null);
        setDuplicateApplySourceTransform(null);
        setDuplicateSourcePreviewTransform(null);
        setDuplicatePreviewTransforms([]);
        setDuplicateTotalCopies(1);

        applyArrangeTransforms([{
          id: model.id,
          transform: {
            position: new THREE.Vector3(centerX, centerY, t.position.z),
            rotation: t.rotation.clone(),
            scale: t.scale.clone(),
          },
        }]);
      }
      return;
    }

    // Arrange and Duplicate previews should never overlap.
    setDuplicateApplySourceModel(null);
    setDuplicateApplySourceTransform(null);
    setDuplicateSourcePreviewTransform(null);
    setDuplicatePreviewTransforms([]);
    setDuplicateTotalCopies(1);

    const minSpinnerMs = 220;
    const startedAt = performance.now();
    setActiveArrangeOperation('standard');
    setArrangeOverlayModelCount(visibleModels.length);
    setIsAutoArranging(true);
    await sleep(0);

    try {
      /**
       * One bed's worth: pack what fits into `frame` and hand back what does not, so the
       * caller can offer the rest to the next bed. Everything here is in the frame's own
       * millimetres, which every bed shares — beds differ only by where the cascade puts
       * them, and the caller shifts the result once it knows.
       */
      const planPass = (
        passModels: SceneModel[],
        frame: { minX: number; maxX: number; minY: number; maxY: number },
      ) => {
        const modelTransformById = new Map(
          passModels.map((model) => [model.id, getArrangeTransform(model)] as const),
        );

        const modelsWithFootprints = passModels.map((model) => {
          const t = modelTransformById.get(model.id) ?? model.transform;
          const baseFootprint = getModelSupportAwareDimensionsMm(model, undefined, t);
          return {
            model,
            baseWidth: baseFootprint.width,
            baseDepth: baseFootprint.depth,
          };
        });

        const { minX, maxX, minY, maxY } = frame;
        const plateWidth = Math.max(1, maxX - minX);
        const plateDepth = Math.max(1, maxY - minY);

        type PackedEntry = {
          model: SceneModel;
          width: number;
          depth: number;
          row: number;
          indexInRow: number;
          rotationZ: number;
        };

        type SpillEntry = {
          model: SceneModel;
          width: number;
          depth: number;
          rotationZ: number;
        };

        type Row = {
          widthUsed: number;
          maxDepth: number;
          items: PackedEntry[];
        };

        const evaluatePacking = (
          ordered: typeof modelsWithFootprints,
          targetRowWidth: number,
          enableRotation: boolean,
        ) => {
          const rows: Row[] = [];
          const spills: SpillEntry[] = [];
          const placementSizeCache = new Map<string, { width: number; depth: number }>();

          let occupiedArea = 0;
          let totalDepthUsed = 0;

          type PlacementOption = {
            rotationZ: number;
            width: number;
            depth: number;
          };

          const normalizeToPi = (angle: number) => {
            let a = angle % Math.PI;
            if (a < 0) a += Math.PI;
            return a;
          };

          const nearestEquivalentAngle = (reference: number, canonical: number) => {
            const twoPi = Math.PI * 2;
            const k = Math.round((reference - canonical) / twoPi);
            return canonical + k * twoPi;
          };

          const footprintAtAngle = (model: SceneModel, angleZ: number) => {
            const t = modelTransformById.get(model.id) ?? model.transform;
            const key = `${model.id}|${angleZ.toFixed(5)}|${t.scale.x.toFixed(5)}|${t.scale.y.toFixed(5)}|${t.scale.z.toFixed(5)}|${t.rotation.x.toFixed(5)}|${t.rotation.y.toFixed(5)}`;
            const cached = placementSizeCache.get(key);
            if (cached) return cached;

            const dims = getModelSupportAwareDimensionsMm(model, angleZ, t);

            placementSizeCache.set(key, dims);
            return dims;
          };

          const getAllOptions = (current: (typeof modelsWithFootprints)[number]): PlacementOption[] => {
            const t = modelTransformById.get(current.model.id) ?? current.model.transform;
            const currentZ = t.rotation.z;
            const currentCanonical = normalizeToPi(currentZ);

            if (!enableRotation) {
              const dims = footprintAtAngle(current.model, currentCanonical);
              return [{ rotationZ: currentZ, width: dims.width, depth: dims.depth }];
            }

            const candidateCanonicals: number[] = [currentCanonical];
            const coarseStepDeg = 15;
            for (let deg = 0; deg < 180; deg += coarseStepDeg) {
              candidateCanonicals.push(THREE.MathUtils.degToRad(deg));
            }

            // Ensure we always evaluate the width/depth-swapped alternative from the current pose.
            candidateCanonicals.push(normalizeToPi(currentCanonical + (Math.PI * 0.5)));

            const seenFootprints = new Set<string>();
            const options: PlacementOption[] = [];

            for (const rawCanonical of candidateCanonicals) {
              const canonical = normalizeToPi(rawCanonical);
              const dims = footprintAtAngle(current.model, canonical);
              const key = `${dims.width.toFixed(3)}:${dims.depth.toFixed(3)}`;
              if (seenFootprints.has(key)) continue;
              seenFootprints.add(key);

              options.push({
                rotationZ: nearestEquivalentAngle(currentZ, canonical),
                width: dims.width,
                depth: dims.depth,
              });
            }

            return options;
          };

          for (const current of ordered) {
            const options = getAllOptions(current);
            const fitOptions = options.filter((opt) => opt.width <= plateWidth && opt.depth <= plateDepth);

            if (fitOptions.length === 0) {
              const fallback = options.reduce((best, candidate) => {
                const bestOverflow = Math.max(0, best.width - plateWidth) + Math.max(0, best.depth - plateDepth);
                const candidateOverflow = Math.max(0, candidate.width - plateWidth) + Math.max(0, candidate.depth - plateDepth);
                if (candidateOverflow < bestOverflow) return candidate;
                if (candidateOverflow === bestOverflow && (candidate.width * candidate.depth) < (best.width * best.depth)) return candidate;
                return best;
              }, options[0]);

              spills.push({
                model: current.model,
                width: fallback.width,
                depth: fallback.depth,
                rotationZ: fallback.rotationZ,
              });
              continue;
            }

            let bestPlacement:
              | { kind: 'same-row'; rowIndex: number; option: PlacementOption; score: number }
              | { kind: 'new-row'; option: PlacementOption; score: number }
              | null = null;

            if (rows.length > 0) {
              for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
                const row = rows[rowIndex];
                for (const option of fitOptions) {
                  const nextWidth = row.widthUsed + (row.items.length > 0 ? spacingMmForRun : 0) + option.width;
                  if (nextWidth > plateWidth) continue;

                  const nextDepth = Math.max(row.maxDepth, option.depth);
                  const depthDelta = nextDepth - row.maxDepth;
                  const nextTotalDepth = totalDepthUsed + depthDelta;
                  if (nextTotalDepth > plateDepth) continue;

                  // Prefer tighter rows, less depth growth, and widths near target row width.
                  const depthPenalty = depthDelta * 40;
                  const widthPenalty = Math.abs(targetRowWidth - nextWidth) * 0.08;
                  const areaScore = nextWidth * nextDepth;
                  const score = areaScore + depthPenalty + widthPenalty;

                  if (!bestPlacement || score < bestPlacement.score) {
                    bestPlacement = { kind: 'same-row', rowIndex, option, score };
                  }
                }
              }
            }

            for (const option of fitOptions) {
              const nextTotalDepth = totalDepthUsed + (rows.length > 0 ? spacingMmForRun : 0) + option.depth;
              if (nextTotalDepth > plateDepth) continue;

              const widthPenalty = Math.abs(targetRowWidth - option.width) * 0.12;
              const score = (option.width * option.depth) + widthPenalty + 10;
              if (!bestPlacement || score < bestPlacement.score) {
                bestPlacement = { kind: 'new-row', option, score };
              }
            }

            if (!bestPlacement) {
              const fallback = fitOptions.reduce((best, candidate) => {
                if (candidate.width < best.width) return candidate;
                if (candidate.width === best.width && candidate.depth < best.depth) return candidate;
                return best;
              }, fitOptions[0]);

              spills.push({
                model: current.model,
                width: fallback.width,
                depth: fallback.depth,
                rotationZ: fallback.rotationZ,
              });
              continue;
            }

            if (bestPlacement.kind === 'new-row') {
              const row: Row = { widthUsed: 0, maxDepth: 0, items: [] };
              rows.push(row);
              totalDepthUsed += (rows.length > 1 ? spacingMmForRun : 0) + bestPlacement.option.depth;
              row.widthUsed = bestPlacement.option.width;
              row.maxDepth = bestPlacement.option.depth;
              row.items.push({
                model: current.model,
                width: bestPlacement.option.width,
                depth: bestPlacement.option.depth,
                row: rows.length - 1,
                indexInRow: 0,
                rotationZ: bestPlacement.option.rotationZ,
              });
              occupiedArea += bestPlacement.option.width * bestPlacement.option.depth;
            } else {
              const row = rows[bestPlacement.rowIndex];
              const previousDepth = row.maxDepth;
              row.widthUsed += (row.items.length > 0 ? spacingMmForRun : 0) + bestPlacement.option.width;
              row.maxDepth = Math.max(row.maxDepth, bestPlacement.option.depth);
              totalDepthUsed += row.maxDepth - previousDepth;
              row.items.push({
                model: current.model,
                width: bestPlacement.option.width,
                depth: bestPlacement.option.depth,
                row: bestPlacement.rowIndex,
                indexInRow: row.items.length,
                rotationZ: bestPlacement.option.rotationZ,
              });
              occupiedArea += bestPlacement.option.width * bestPlacement.option.depth;
            }
          }

          const rowDepths = rows.map((r) => r.maxDepth);
          const rowWidths = rows.map((r) => r.widthUsed);
          const totalWidth = Math.min(plateWidth, rowWidths.reduce((acc, width) => Math.max(acc, width), 0));
          const totalDepth = rowDepths.reduce((acc, depth) => acc + depth, 0) + Math.max(0, rows.length - 1) * spacingMmForRun;

          const layoutArea = totalWidth * totalDepth;
          const deadSpace = Math.max(0, layoutArea - occupiedArea);
          const spillArea = spills.reduce((acc, item) => acc + (item.width * item.depth), 0);
          const spillPenalty = spills.length * 1_000_000 + spillArea * 100;
          const aspectPenalty = Math.abs(totalWidth - totalDepth) * 0.05;

          return {
            rows,
            spills,
            rowDepths,
            totalWidth,
            totalDepth,
            score: deadSpace + spillPenalty + aspectPenalty,
            usedRotation: enableRotation,
          };
        };

        const countPackedItems = (layout: ReturnType<typeof evaluatePacking>) => (
          layout.rows.reduce((acc, row) => acc + row.items.length, 0)
        );

        const isBetterLayout = (
          candidate: ReturnType<typeof evaluatePacking>,
          currentBest: ReturnType<typeof evaluatePacking> | null,
        ) => {
          if (!currentBest) return true;

          if (candidate.spills.length !== currentBest.spills.length) {
            return candidate.spills.length < currentBest.spills.length;
          }

          const candidatePackedCount = countPackedItems(candidate);
          const bestPackedCount = countPackedItems(currentBest);
          if (candidatePackedCount !== bestPackedCount) {
            return candidatePackedCount > bestPackedCount;
          }

          const scoreDelta = candidate.score - currentBest.score;
          if (Math.abs(scoreDelta) > 1e-6) {
            return scoreDelta < 0;
          }

          // When layouts are effectively tied, do not force rotation.
          if (candidate.usedRotation !== currentBest.usedRotation) {
            return !candidate.usedRotation;
          }

          return false;
        };

        const byAreaDesc = [...modelsWithFootprints].sort((a, b) => (b.baseWidth * b.baseDepth) - (a.baseWidth * a.baseDepth));
        const byMaxSideDesc = [...modelsWithFootprints].sort((a, b) => Math.max(b.baseWidth, b.baseDepth) - Math.max(a.baseWidth, a.baseDepth));
        const orderingCandidates = [modelsWithFootprints, byAreaDesc, byMaxSideDesc];

        const totalModelArea = modelsWithFootprints.reduce((acc, current) => acc + (current.baseWidth * current.baseDepth), 0);
        const baseWidth = Math.min(plateWidth, Math.max(30, Math.sqrt(totalModelArea)));
        const targetRowWidths = [
          baseWidth * 0.8,
          baseWidth,
          baseWidth * 1.2,
          plateWidth * 0.5,
          plateWidth * 0.65,
          plateWidth * 0.8,
          plateWidth,
        ]
          .map((w) => Math.min(plateWidth, Math.max(20, w)));

        const uniqueTargetRowWidths = [...new Set(targetRowWidths.map((w) => Number(w.toFixed(3))))];

        let bestLayout: ReturnType<typeof evaluatePacking> | null = null;
        const rotationModes = allowRotateOnZForRun ? [false, true] : [false];
        for (const ordered of orderingCandidates) {
          for (const targetRowWidth of uniqueTargetRowWidths) {
            for (const enableRotation of rotationModes) {
              const layout = evaluatePacking(ordered, targetRowWidth, enableRotation);
              if (isBetterLayout(layout, bestLayout)) {
                bestLayout = layout;
              }
            }
          }
        }

        if (!bestLayout) return { placed: [] as Array<PackedEntry & { positionX: number; positionY: number }>, spilled: [...passModels] };

        const { rows, spills, rowDepths, totalWidth, totalDepth } = bestLayout;

        let startX = minX + ((maxX - minX) - totalWidth) * 0.5;
        let startY = minY + ((maxY - minY) - totalDepth) * 0.5;

        if (arrangeAnchorMode === 'front_left') {
          startX = minX;
          startY = minY;
        } else if (arrangeAnchorMode === 'front_right') {
          startX = maxX - totalWidth;
          startY = minY;
        } else if (arrangeAnchorMode === 'back_left') {
          startX = minX;
          startY = maxY - totalDepth;
        } else if (arrangeAnchorMode === 'back_right') {
          startX = maxX - totalWidth;
          startY = maxY - totalDepth;
        }

        const rowCenters: number[] = [];
        let cursorY = startY;
        for (let row = 0; row < rowDepths.length; row += 1) {
          const depth = rowDepths[row];
          rowCenters[row] = cursorY + depth * 0.5;
          cursorY += depth + spacingMmForRun;
        }

        const packedWithPositions: Array<PackedEntry & { positionX: number; positionY: number }> = [];
        rows.forEach((row, rowIndex) => {
          let rowCursorX = startX;
          row.items.forEach((item) => {
            const centerX = rowCursorX + item.width * 0.5;
            packedWithPositions.push({
              ...item,
              positionX: centerX,
              positionY: rowCenters[rowIndex],
            });
            rowCursorX += item.width + spacingMmForRun;
          });
        });

        return { placed: packedWithPositions, spilled: spills.map((item) => item.model) };
      };

      // Every bed holds the same build volume; only where the cascade puts it differs.
      const localFrame = resolveArrangeFrame({ dxMm: 0, dyMm: 0 });
      const platesBefore = { plates: scene.plates, activePlateId: scene.activePlateId };
      const runModelIds = new Set(visibleModels.map((model) => model.id));
      const targets = resolveArrangeBedTargets(plateFillModeForRun, runModelIds);
      /** Left edge of every bed, in world millimetres: where the fallback column starts. */
      const leftmostBedEdgeMm = scene.plateFrames.reduce(
        (edge, plateFrame) => Math.min(edge, plateFrame.minX),
        localFrame.minX,
      );

      /**
       * The models that could not be packed anywhere are set down in a column beside the
       * beds. Reached only when a bed adds nothing — a model larger than the plate — which
       * is also what stops a run adding beds forever.
       */
      const placeBesidePlate = (modelsForColumn: SceneModel[]) => placeModelsBesideBeds({
        models: modelsForColumn,
        frame: localFrame,
        spacingMm: spacingMmForRun,
        leftmostBedEdgeMm,
        activeOffset: arrangePlateOffset(),
        getRotationZ: (model) => getArrangeTransform(model).rotation.z,
        getDims: (model) => {
          const t = getArrangeTransform(model);
          const dims = getModelSupportAwareDimensionsMm(model, undefined, t);
          return { width: dims.width, depth: dims.depth };
        },
      });

      type PlannedPass = {
        placed: Array<{ model: SceneModel; rotationZ: number; positionX: number; positionY: number }>;
        /** The bed this pass lands on, or null when the run has to add one. */
        plateId: string | null;
      };

      const passes: PlannedPass[] = [];
      let pending: SceneModel[] = [...visibleModels];

      // Fill what the scene already has: each bed's own free space, its largest rectangle
      // first, so a bed that is half full still takes what fits before another is made.
      for (const target of targets) {
        if (pending.length === 0) break;

        const freeRects = freeRectsForPlate(localFrame, target.occupied, {
          gapMm: spacingMmForRun,
          minSideMm: 2,
        });

        for (const rect of freeRects) {
          if (pending.length === 0) break;
          const pass = planPass(pending, rect);
          if (pass.placed.length === 0) continue;
          passes.push({ placed: pass.placed, plateId: target.plateId });
          pending = pass.spilled;
        }
      }

      // Everything the scene had is full: add beds until the rest has somewhere to stand.
      // The cap only bites on a set that cannot be packed at all, where a pass below makes
      // no progress and the rest goes beside the plate instead.
      while (pending.length > 0 && passes.filter((pass) => pass.plateId === null).length < MAX_ARRANGE_BEDS) {
        const pass = planPass(pending, localFrame);
        if (pass.placed.length === 0) break;

        passes.push({ placed: pass.placed, plateId: null });
        pending = pass.spilled;
      }

      if (pending.length > 0) {
        // A model bigger than a bed, or a set past the bed cap: the leftover goes beside
        // the active plate, which is what arrange has always done with it.
        passes.push({ placed: placeBesidePlate(pending), plateId: scene.activePlateId });
      }

      const newPlateCount = passes.filter((pass) => pass.plateId === null).length;
      const reserved = scene.addPlates(newPlateCount);

      // Each pass is shifted into its own bed. The frames come back with the beds because
      // a bed added late can re-lay the ones already there.
      let addedPlateIndex = 0;
      const updates = passes.flatMap((pass) => {
        const plateId = pass.plateId ?? reserved.added[addedPlateIndex++].id;
        const offset = reserved.offsets.get(plateId) ?? { dxMm: 0, dyMm: 0 };

        return pass.placed.map(({ model, rotationZ, positionX, positionY }) => {
          const t = getArrangeTransform(model);
          return {
            id: model.id,
            transform: {
              position: new THREE.Vector3(positionX + offset.dxMm, positionY + offset.dyMm, t.position.z),
              rotation: new THREE.Euler(
                t.rotation.x,
                t.rotation.y,
                rotationZ,
                t.rotation.order,
              ),
              scale: t.scale.clone(),
            },
          };
        });
      });

      applyArrangeTransforms(
        updates,
        newPlateCount > 0
          ? { platesBefore, platesAfter: { plates: reserved.plates, activePlateId: scene.activePlateId } }
          : undefined,
      );
    } finally {
      const elapsed = performance.now() - startedAt;
      if (elapsed < minSpinnerMs) {
        await sleep(minSpinnerMs - elapsed);
      }
      setIsAutoArranging(false);
      setActiveArrangeOperation(null);
      setArrangeOverlayModelCount(null);
    }
  }, [arrangeAllowRotateOnZ, arrangeAnchorMode, arrangeSpacingMm, getArrangeTransform, getModelSupportAwareDimensionsMm, isAutoArranging, resolveArrangeBedTargets, resolveArrangeFrame, resolveArrangeVisibleModels, scene, sleep, transformMgr, applyArrangeTransforms]);

  const handleHighPrecisionArrangeModels = React.useCallback(async (scope: 'all' | 'selected', explicitSelectedIds?: string[]) => {
    if (isAutoArranging) return;

    const visibleModels = resolveArrangeVisibleModels(scope, explicitSelectedIds);
    if (visibleModels.length <= 1) {
      if (visibleModels.length === 1) {
        const model = visibleModels[0];
        const t = getArrangeTransform(model);
        const dims = getModelSupportAwareDimensionsMm(model, undefined, t);

        const { minX, maxX, minY, maxY } = resolveArrangeFrame();
        const { x: centerX, y: centerY } = loneModelCenter({ minX, maxX, minY, maxY }, dims, arrangeAnchorMode);

        // Arrange and Duplicate previews should never overlap.
        setDuplicateApplySourceModel(null);
        setDuplicateApplySourceTransform(null);
        setDuplicateSourcePreviewTransform(null);
        setDuplicatePreviewTransforms([]);
        setDuplicateTotalCopies(1);

        applyArrangeTransforms([{
          id: model.id,
          transform: {
            position: new THREE.Vector3(centerX, centerY, t.position.z),
            rotation: t.rotation.clone(),
            scale: t.scale.clone(),
          },
        }]);
      }
      return;
    }

    // Arrange and Duplicate previews should never overlap.
    setDuplicateApplySourceModel(null);
    setDuplicateApplySourceTransform(null);
    setDuplicateSourcePreviewTransform(null);
    setDuplicatePreviewTransforms([]);
    setDuplicateTotalCopies(1);

    const minSpinnerMs = 220;
    const startedAt = performance.now();
    setActiveArrangeOperation('high_precision');
    setArrangeOverlayModelCount(visibleModels.length);
    setIsAutoArranging(true);
    await sleep(0);

    try {
      const activeOffset = arrangePlateOffset();
      // Every bed holds the same build volume, so a pass packs in the plate's own
      // millimetres and the bed is added afterwards. Model positions are shifted into
      // the active plate's frame so that the models standing on OTHER beds stay where
      // the cascade puts them relative to this one — the packer treats everything that
      // is not a target as a blocker.
      const localTransformById = new Map(
        scene.models.map((model) => {
          const t = getArrangeTransform(model);
          return [model.id, {
            ...t,
            position: new THREE.Vector3(
              t.position.x - activeOffset.dxMm,
              t.position.y - activeOffset.dyMm,
              t.position.z,
            ),
          }] as const;
        }),
      );
      const sceneArrangeModels = buildHighPrecisionArrangeModels(scene.models, localTransformById);
      const arrangeIdSet = new Set(visibleModels.map((model) => model.id));

      const platesBefore = { plates: scene.plates, activePlateId: scene.activePlateId };
      // Every bed holds the same build volume; only where the cascade puts it differs.
      const localFrame = resolveArrangeFrame({ dxMm: 0, dyMm: 0 });
      const targets = resolveArrangeBedTargets(arrangePlateFillMode, arrangeIdSet);
      /** Left edge of every bed, in world millimetres: where the fallback column starts. */
      const leftmostBedEdgeMm = scene.plateFrames.reduce(
        (edge, plateFrame) => Math.min(edge, plateFrame.minX),
        localFrame.minX,
      );

      type PlannedPass = {
        /** Placements in the bed's own millimetres, before the bed is put anywhere. */
        placed: Array<{ id: string; transform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 } }>;
        /** The bed this pass lands on, or null when the run has to add one. */
        plateId: string | null;
      };

      const passes: PlannedPass[] = [];
      let pendingIds = visibleModels.map((model) => model.id);
      /** The last pass's own placement beside its bed, in plate millimetres. */

      /**
       * Packs whatever is still pending into one rectangle of one bed.
       *
       * The rectangle is the room a bed has left, so the packer is told where to put
       * models rather than what to avoid: no blockers, and the frame it is given is that
       * rectangle — a bed's own frame is only the special case where nothing is on it.
       */
      const packIntoRect = async (rect: PlateRect, plateId: string | null): Promise<void> => {
        if (pendingIds.length === 0) return;

        // The packer arranges a set; asked for one model it answers nothing at all. The
        // lone leftover is therefore placed the way a solo arrange places it.
        if (pendingIds.length === 1) {
          const lone = visibleModels.find((model) => model.id === pendingIds[0]);
          if (!lone) {
            pendingIds = [];
            return;
          }

          const t = getArrangeTransform(lone);
          const dims = getModelSupportAwareDimensionsMm(lone, undefined, t);
          // Only where it fits. A lone model is not a reason to hang it over the edge of a
          // bed — the caller offers it the next rectangle, and a bed of its own if none of
          // the free space is big enough.
          if (dims.width > (rect.maxX - rect.minX) || dims.depth > (rect.maxY - rect.minY)) return;

          const { x, y } = loneModelCenter(rect, dims, arrangeAnchorMode);
          passes.push({
            placed: [{
              id: lone.id,
              transform: {
                position: new THREE.Vector3(x, y, t.position.z),
                rotation: t.rotation.clone(),
                scale: t.scale.clone(),
              },
            }],
            plateId,
          });
          pendingIds = [];
          return;
        }

        const targetIds = new Set(pendingIds);
        const passModels = sceneArrangeModels.filter((model) => targetIds.has(model.id));
        const result = await computeHighPrecisionArrangeResultWorker({
          visibleModels: passModels,
          sceneModels: passModels,
          widthMm: rect.maxX - rect.minX,
          depthMm: rect.maxY - rect.minY,
          // The rectangle is the frame: a front-left origin plus the offset puts it
          // exactly where the free space is, with the margins already taken out.
          originMode: 'front_left',
          plateOffsetMm: { dxMm: rect.minX, dyMm: rect.minY },
          arrangeSpacingMm,
          arrangeAllowRotateOnZ,
          arrangeAnchorMode,
          getArrangeTransform: (model) => model.transform,
          hullCache: arrangeHullFootprintCacheRef.current,
          safetyMarginMm: undefined,
        });

        const packedIds = new Set(result.packedIds);
        const packed = result.updates.filter((update) => packedIds.has(update.id));

        if (packed.length === 0) {
          // Nothing fitted this rectangle; the caller moves on to the next one.
          return;
        }

        passes.push({ placed: packed, plateId });
        pendingIds = result.spilledIds;
      };

      // Fill what the scene already has: each bed's own free space, its largest rectangle
      // first, so a bed that is half full still takes what fits before another is made.
      for (const target of targets) {
        if (pendingIds.length === 0) break;

        const freeRects = freeRectsForPlate(localFrame, target.occupied, {
          gapMm: arrangeSpacingMm,
          minSideMm: 2,
        });

        for (const rect of freeRects) {
          if (pendingIds.length === 0) break;
          await packIntoRect(rect, target.plateId);
        }
      }

      // Everything the scene had is full: add beds until the rest has somewhere to stand.
      let addedBeds = 0;
      while (pendingIds.length > 0 && addedBeds < MAX_ARRANGE_BEDS) {
        const before = pendingIds.length;
        await packIntoRect(localFrame, null);
        if (pendingIds.length >= before) break;
        addedBeds += 1;
      }

      if (pendingIds.length > 0) {
        // A model bigger than a bed, or a set past the bed cap: the leftover goes in a
        // column beside the beds, which is what arrange has always done with it.
        const leftoverModels = visibleModels.filter((model) => pendingIds.includes(model.id));
        const beside = placeModelsBesideBeds({
          models: leftoverModels,
          frame: localFrame,
          spacingMm: arrangeSpacingMm,
          leftmostBedEdgeMm,
          activeOffset: arrangePlateOffset(),
          getRotationZ: (model) => getArrangeTransform(model).rotation.z,
          getDims: (model) => {
            const t = getArrangeTransform(model);
            const dims = getModelSupportAwareDimensionsMm(model, undefined, t);
            return { width: dims.width, depth: dims.depth };
          },
        });

        passes.push({
          placed: beside.map((entry) => ({
            id: entry.model.id,
            transform: {
              position: new THREE.Vector3(entry.positionX, entry.positionY, getArrangeTransform(entry.model).position.z),
              rotation: getArrangeTransform(entry.model).rotation.clone(),
              scale: getArrangeTransform(entry.model).scale.clone(),
            },
          })),
          plateId: scene.activePlateId,
        });
      }

      const newPlateCount = passes.filter((pass) => pass.plateId === null).length;
      const reserved = scene.addPlates(newPlateCount);

      let addedPlateIndex = 0;
      const updates = passes.flatMap((pass) => {
        const plateId = pass.plateId ?? reserved.added[addedPlateIndex++].id;
        const offset = reserved.offsets.get(plateId) ?? { dxMm: 0, dyMm: 0 };

        return pass.placed.map((update) => ({
          id: update.id,
          transform: {
            position: update.transform.position.clone().add(new THREE.Vector3(offset.dxMm, offset.dyMm, 0)),
            rotation: update.transform.rotation.clone(),
            scale: update.transform.scale.clone(),
          },
        }));
      });

      if (updates.length > 1) {
        applyArrangeTransforms(
          updates,
          newPlateCount > 0
            ? { platesBefore, platesAfter: { plates: reserved.plates, activePlateId: scene.activePlateId } }
            : undefined,
        );
      }
    } finally {
      const elapsed = performance.now() - startedAt;
      if (elapsed < minSpinnerMs) {
        await sleep(minSpinnerMs - elapsed);
      }
      setIsAutoArranging(false);
      setActiveArrangeOperation(null);
      setArrangeOverlayModelCount(null);
    }
  }, [
    arrangeAllowRotateOnZ,
    arrangeAnchorMode,
    arrangePlateOffset,
    arrangeSpacingMm,
    getArrangeTransform,
    isAutoArranging,
    resolveArrangeBedTargets,
    resolveArrangeFrame,
    resolveArrangeVisibleModels,
    scene,
    sleep,
    transformMgr,
    buildHighPrecisionArrangeModels,
    applyArrangeTransforms,
  ]);

  const computeManualArrayArrangeUpdates = React.useCallback((scope: 'all' | 'selected', explicitSelectedIds?: string[]) => {
    const visibleModels = resolveArrangeVisibleModels(scope, explicitSelectedIds);

    const modelTransformById = new Map(
      visibleModels.map((model) => [model.id, getArrangeTransform(model)] as const),
    );

    if (visibleModels.length <= 1) return { models: visibleModels, updates: [] as Array<{ id: string; transform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 } }> };

    const countX = Math.max(1, Math.round(arrangeArrayCountX));
    const countY = Math.max(1, Math.round(arrangeArrayCountY));
    const countZ = Math.max(1, Math.round(arrangeArrayCountZ));

    // Gaps may be negative (nested arrays); the steps below keep a small
    // positive floor so the array still advances.
    const gapX = arrangeArrayGapX;
    const gapY = arrangeArrayGapY;
    const gapZ = arrangeArrayGapZ;

    const baseDims = visibleModels.map((model) => {
      const t = modelTransformById.get(model.id) ?? model.transform;
      const projected = getModelSupportAwareDimensionsMm(model, undefined, t);
      const scaledHeight = projected.height;

      return {
        width: projected.width,
        depth: projected.depth,
        height: scaledHeight,
      };
    });

    const maxWidth = Math.max(...baseDims.map((d) => d.width));
    const maxDepth = Math.max(...baseDims.map((d) => d.depth));
    const maxHeight = Math.max(...baseDims.map((d) => d.height));

    const stepX = Math.max(0.1, maxWidth + gapX);
    const stepY = Math.max(0.1, maxDepth + gapY);
    const stepZ = Math.max(0.1, maxHeight + gapZ);

    const { minX, maxX, minY, maxY } = resolveArrangeFrame();

    const slotsPerLayer = countX * countY;
    const requiredLayers = Math.max(1, Math.ceil(visibleModels.length / slotsPerLayer));
    const usedCountZ = Math.max(countZ, requiredLayers);

    const totalWidth = (countX - 1) * stepX;
    const totalDepth = (countY - 1) * stepY;

    let startX = (minX + maxX) * 0.5 - totalWidth * 0.5;
    let startY = (minY + maxY) * 0.5 - totalDepth * 0.5;

    if (arrangeAnchorMode === 'front_left') {
      startX = minX + (maxWidth * 0.5);
      startY = minY + (maxDepth * 0.5);
    } else if (arrangeAnchorMode === 'front_right') {
      startX = maxX - (maxWidth * 0.5) - totalWidth;
      startY = minY + (maxDepth * 0.5);
    } else if (arrangeAnchorMode === 'back_left') {
      startX = minX + (maxWidth * 0.5);
      startY = maxY - (maxDepth * 0.5) - totalDepth;
    } else if (arrangeAnchorMode === 'back_right') {
      startX = maxX - (maxWidth * 0.5) - totalWidth;
      startY = maxY - (maxDepth * 0.5) - totalDepth;
    }

    const baseZ = Math.min(...visibleModels.map((model) => (modelTransformById.get(model.id) ?? model.transform).position.z));

    const updates = visibleModels.map((model, index) => {
      const t = modelTransformById.get(model.id) ?? model.transform;
      const xIndex = index % countX;
      const yIndex = Math.floor(index / countX) % countY;
      const zIndex = Math.floor(index / (countX * countY)) % usedCountZ;

      return {
        id: model.id,
        transform: {
          position: new THREE.Vector3(
            startX + (xIndex * stepX),
            startY + (yIndex * stepY),
            baseZ + (zIndex * stepZ),
          ),
          rotation: t.rotation.clone(),
          scale: t.scale.clone(),
        },
      };
    });

    return { models: visibleModels, updates };
  }, [
    arrangeAnchorMode,
    arrangeArrayCountX,
    arrangeArrayCountY,
    arrangeArrayCountZ,
    arrangeArrayGapX,
    arrangeArrayGapY,
    arrangeArrayGapZ,
    scene.models,
    scene.selectedModelIds,
    resolveArrangeFrame,
    getArrangeTransform,
    getModelSupportAwareDimensionsMm,
    resolveArrangeVisibleModels,
  ]);

  const handleManualArrayArrangeModels = React.useCallback(async (scope: 'all' | 'selected', explicitSelectedIds?: string[]) => {
    if (isAutoArranging) return;

    const visibleModels = resolveArrangeVisibleModels(scope, explicitSelectedIds);
    if (visibleModels.length <= 1) {
      if (visibleModels.length === 1) {
        const model = visibleModels[0];
        const t = getArrangeTransform(model);
        const dims = getModelSupportAwareDimensionsMm(model, undefined, t);

        const { minX, maxX, minY, maxY } = resolveArrangeFrame();
        const { x: centerX, y: centerY } = loneModelCenter({ minX, maxX, minY, maxY }, dims, arrangeAnchorMode);

        // Arrange and Duplicate previews should never overlap.
        setDuplicateApplySourceModel(null);
        setDuplicateApplySourceTransform(null);
        setDuplicateSourcePreviewTransform(null);
        setDuplicatePreviewTransforms([]);
        setDuplicateTotalCopies(1);

        applyArrangeTransforms([{
          id: model.id,
          transform: {
            position: new THREE.Vector3(centerX, centerY, t.position.z),
            rotation: t.rotation.clone(),
            scale: t.scale.clone(),
          },
        }]);
      }
      return;
    }

    // Arrange and Duplicate previews should never overlap.
    setDuplicateApplySourceModel(null);
    setDuplicateApplySourceTransform(null);
    setDuplicateSourcePreviewTransform(null);
    setDuplicatePreviewTransforms([]);
    setDuplicateTotalCopies(1);

    const minSpinnerMs = 220;
    const startedAt = performance.now();
    setActiveArrangeOperation('array');
    setArrangeOverlayModelCount(visibleModels.length);
    setIsAutoArranging(true);
    await sleep(0);

    try {
      const { updates } = computeManualArrayArrangeUpdates(scope, explicitSelectedIds);
      if (updates.length <= 1) return;

      applyArrangeTransforms(updates);
    } finally {
      const elapsed = performance.now() - startedAt;
      if (elapsed < minSpinnerMs) {
        await sleep(minSpinnerMs - elapsed);
      }
      setIsAutoArranging(false);
      setActiveArrangeOperation(null);
      setArrangeOverlayModelCount(null);
    }
  }, [
    arrangeAnchorMode,
    arrangeArrayCountX,
    arrangeArrayCountY,
    arrangeArrayCountZ,
    arrangeArrayGapX,
    arrangeArrayGapY,
    arrangeArrayGapZ,
    computeManualArrayArrangeUpdates,
    isAutoArranging,
    resolveArrangeFrame,
    scene,
    sleep,
    transformMgr,
    applyArrangeTransforms,
  ]);

  React.useEffect(() => {
    if (scene.mode !== 'prepare' || transformMgr.transformMode !== 'arrange' || arrangeLayoutMode !== 'array') {
      setArrangeArrayPreviewItems([]);
      return;
    }

    const selectedVisibleCount = scene.models.filter((m) => m.visible && scene.selectedModelIds.includes(m.id)).length;
    const previewScope: 'all' | 'selected' = selectedVisibleCount > 1 ? 'selected' : 'all';
    const { models: previewModels, updates } = computeManualArrayArrangeUpdates(previewScope);

    if (updates.length <= 1 || previewModels.length <= 1) {
      setArrangeArrayPreviewItems([]);
      return;
    }

    const updateMap = new Map(updates.map((update) => [update.id, update.transform]));
    const previewItems = previewModels
      .map((model) => {
        const previewTransform = updateMap.get(model.id);
        if (!previewTransform) return null;
        return {
          model,
          transform: {
            position: previewTransform.position.clone(),
            rotation: previewTransform.rotation.clone(),
            scale: previewTransform.scale.clone(),
          },
        };
      })
      .filter((item): item is { model: (typeof scene.models)[number]; transform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 } } => item !== null);

    setArrangeArrayPreviewItems(previewItems);
  }, [
    arrangeLayoutMode,
    computeManualArrayArrangeUpdates,
    scene.mode,
    scene.models,
    scene.selectedModelIds,
    transformMgr.transformMode,
  ]);

  const computeArrangeSlots = React.useCallback((count: number, stepX: number, stepY: number) => {
    const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
    const rows = Math.ceil(count / columns);
    const centerX = scene.view3dSettings.originMode === 'front_left' ? scene.view3dSettings.widthMm * 0.5 : 0;
    const centerY = scene.view3dSettings.originMode === 'front_left' ? scene.view3dSettings.depthMm * 0.5 : 0;
    const startX = centerX - ((columns - 1) * stepX) * 0.5;
    const startY = centerY - ((rows - 1) * stepY) * 0.5;

    return Array.from({ length: count }, (_, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      return new THREE.Vector3(startX + col * stepX, startY + row * stepY, 0);
    });
  }, [scene.view3dSettings.depthMm, scene.view3dSettings.originMode, scene.view3dSettings.widthMm]);
  const handleConfirmDuplicate = React.useCallback(async () => {
    if (isDuplicating) return;
    if (!scene.activeModelId) return;
    if (duplicatePreviewTransforms.length === 0) return;

    const sourceModelAtApplyStart = scene.activeModel;
    const sourcePreviewTransformAtApplyStart = duplicateSourcePreviewTransform;
    if (sourceModelAtApplyStart && sourcePreviewTransformAtApplyStart) {
      setDuplicateApplySourceModel(sourceModelAtApplyStart);
      setDuplicateApplySourceTransform({
        position: sourcePreviewTransformAtApplyStart.position.clone(),
        rotation: sourcePreviewTransformAtApplyStart.rotation.clone(),
        scale: sourcePreviewTransformAtApplyStart.scale.clone(),
      });
    } else {
      setDuplicateApplySourceModel(null);
      setDuplicateApplySourceTransform(null);
    }

    const minSpinnerMs = 220;
    const startedAt = performance.now();
    setIsDuplicating(true);
    await sleep(0);

    try {
      const createdIds = scene.duplicateModelWithTransforms(
        scene.activeModelId,
        duplicatePreviewTransforms,
        duplicateSourcePreviewTransform
          ? {
            position: duplicateSourcePreviewTransform.position.clone(),
            rotation: duplicateSourcePreviewTransform.rotation.clone(),
            scale: duplicateSourcePreviewTransform.scale.clone(),
          }
          : null,
        reserved
          ? {
              platesBefore,
              platesAfter: { plates: reserved.plates, activePlateId: scene.activePlateId },
            }
          : undefined,
      );

      const firstCreatedId = createdIds[0] ?? null;
      const firstCreatedTransform = duplicatePreviewTransforms[0] ?? null;
      if (firstCreatedId && firstCreatedTransform) {
        setDisplayActiveModelId(firstCreatedId);
        transformMgr.transformHook.setPosition(
          firstCreatedTransform.position.x,
          firstCreatedTransform.position.y,
          firstCreatedTransform.position.z,
        );
        transformMgr.transformHook.setRotation(
          firstCreatedTransform.rotation.x,
          firstCreatedTransform.rotation.y,
          firstCreatedTransform.rotation.z,
        );
        transformMgr.transformHook.setScale(
          firstCreatedTransform.scale.x,
          firstCreatedTransform.scale.y,
          firstCreatedTransform.scale.z,
        );
      }

      setDuplicateTotalCopies(1);
      setDuplicateSourcePreviewTransform(null);
      setDuplicatePreviewTransforms([]);
    } finally {
      const elapsed = performance.now() - startedAt;
      if (elapsed < minSpinnerMs) {
        await sleep(minSpinnerMs - elapsed);
      }
      setIsDuplicating(false);
      setDuplicateApplySourceModel(null);
      setDuplicateApplySourceTransform(null);
    }
  }, [duplicatePreviewTransforms, duplicateSourcePreviewTransform, isDuplicating, scene, sleep, transformMgr.transformHook]);

  const handleFillPlateDuplicate = React.useCallback(async () => {
    if (isDuplicating || isAutoArranging) return;
    if (duplicateLayoutMode !== 'auto') return;
    const model = scene.activeModel;
    if (!model) return;

    if (duplicatePrecisionMode === 'high_precision') {
      const minSpinnerMs = 220;
      const startedAt = performance.now();
      const maxProbeCopies = 128;

      setDuplicateApplySourceModel(null);
      setDuplicateApplySourceTransform(null);
      setDuplicateSourcePreviewTransform(null);
      setDuplicatePreviewTransforms([]);
      setIsDuplicating(true);
      setActiveArrangeOperation('high_precision_fill');
      setArrangeOverlayModelCount(maxProbeCopies);
      setIsAutoArranging(true);
      await sleep(0);

      try {
        const modelTransformById = new Map(
          scene.models.map((sceneModel) => [sceneModel.id, sceneModel.transform] as const),
        );
        const highPrecisionSceneModels = buildHighPrecisionArrangeModels(scene.models, modelTransformById);
        const highPrecisionSourceModel = highPrecisionSceneModels.find((candidate) => candidate.id === model.id);
        if (!highPrecisionSourceModel) return;

        const duplicateSceneModels: HighPrecisionArrangeModel[] = Array.from({ length: maxProbeCopies }, (_, index) => ({
          ...highPrecisionSourceModel,
          id: `${model.id}__duplicate_fill_${index}`,
          visible: true,
          transform: {
            position: highPrecisionSourceModel.transform.position.clone(),
            rotation: highPrecisionSourceModel.transform.rotation.clone(),
            scale: highPrecisionSourceModel.transform.scale.clone(),
          },
          geometry: {
            center: highPrecisionSourceModel.geometry.center.clone(),
            geometry: highPrecisionSourceModel.geometry.geometry,
            supportLocalPoints: highPrecisionSourceModel.geometry.supportLocalPoints?.map((point) => point.clone()),
            supportHullKey: highPrecisionSourceModel.geometry.supportHullKey,
          },
        }));

        const result = await computeHighPrecisionArrangeResultWorker({
          visibleModels: duplicateSceneModels,
          sceneModels: [...highPrecisionSceneModels.filter((sceneModel) => sceneModel.id !== model.id), ...duplicateSceneModels],
          widthMm: scene.view3dSettings.widthMm,
          depthMm: scene.view3dSettings.depthMm,
          originMode: scene.view3dSettings.originMode,
          arrangeSpacingMm: duplicateSpacingMm,
          arrangeAllowRotateOnZ: true,
          arrangeAnchorMode: 'center',
          getArrangeTransform: (arrangeModel) => arrangeModel.transform,
          hullCache: arrangeHullFootprintCacheRef.current,
          safetyMarginMm: scene.view3dSettings.safetyMarginMm,
        });

        const packedIdSet = new Set(result.packedIds);
        const packedUpdates = result.updates.filter((update) => packedIdSet.has(update.id));
        if (packedUpdates.length <= 1) return;

        let sourceUpdate = packedUpdates[0];
        let sourceDistanceSq = Number.POSITIVE_INFINITY;
        for (const update of packedUpdates) {
          const dx = update.transform.position.x - model.transform.position.x;
          const dy = update.transform.position.y - model.transform.position.y;
          const distanceSq = (dx * dx) + (dy * dy);
          if (distanceSq < sourceDistanceSq) {
            sourceDistanceSq = distanceSq;
            sourceUpdate = update;
          }
        }

        const duplicateTransforms = packedUpdates
          .filter((update) => update.id !== sourceUpdate.id)
          .map((update) => ({
            position: update.transform.position.clone(),
            rotation: update.transform.rotation.clone(),
            scale: update.transform.scale.clone(),
          }));

        if (duplicateTransforms.length === 0) return;

        const createdIds = scene.duplicateModelWithTransforms(
          model.id,
          duplicateTransforms,
          {
            position: sourceUpdate.transform.position.clone(),
            rotation: sourceUpdate.transform.rotation.clone(),
            scale: sourceUpdate.transform.scale.clone(),
          },
        );

        const firstCreatedId = createdIds[0] ?? null;
        const firstCreatedTransform = duplicateTransforms[0] ?? null;
        if (firstCreatedId && firstCreatedTransform) {
          setDisplayActiveModelId(firstCreatedId);
          transformMgr.transformHook.setPosition(
            firstCreatedTransform.position.x,
            firstCreatedTransform.position.y,
            firstCreatedTransform.position.z,
          );
          transformMgr.transformHook.setRotation(
            firstCreatedTransform.rotation.x,
            firstCreatedTransform.rotation.y,
            firstCreatedTransform.rotation.z,
          );
          transformMgr.transformHook.setScale(
            firstCreatedTransform.scale.x,
            firstCreatedTransform.scale.y,
            firstCreatedTransform.scale.z,
          );
        }

        setDuplicateTotalCopies(1);
      } catch (error) {
        console.warn('[Duplicate][HighPrecision] Failed applying fill-plate duplicate.', error);
      } finally {
        const elapsed = performance.now() - startedAt;
        if (elapsed < minSpinnerMs) {
          await sleep(minSpinnerMs - elapsed);
        }
        setIsDuplicating(false);
        setIsAutoArranging(false);
        setActiveArrangeOperation(null);
        setArrangeOverlayModelCount(null);
      }
      return;
    }

    const sourceDims = getModelSupportAwareDimensionsMm(model, undefined, model.transform);
    const width = sourceDims.width;
    const depth = sourceDims.depth;
    // Spacing may be negative (nesting); clamp so a step never collapses.
    const spacing = Math.max(-Math.min(width, depth) + 0.1, duplicateSpacingMm);

    const rawFillMinX = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.widthMm * 0.5;
    const rawFillMaxX = rawFillMinX + scene.view3dSettings.widthMm;
    const rawFillMinY = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.depthMm * 0.5;
    const rawFillMaxY = rawFillMinY + scene.view3dSettings.depthMm;
    const fillSm = scene.view3dSettings.safetyMarginMm;
    const minX = rawFillMinX + Math.max(0, fillSm?.left ?? 0);
    const maxX = rawFillMaxX - Math.max(0, fillSm?.right ?? 0);
    const minY = rawFillMinY + Math.max(0, fillSm?.front ?? 0);
    const maxY = rawFillMaxY - Math.max(0, fillSm?.back ?? 0);

    const plateWidth = Math.max(1, maxX - minX);
    const plateDepth = Math.max(1, maxY - minY);
    // Add small epsilon to prevent floating point edge cases when spacing is very small
    const gridSpacing = spacing > 0 ? spacing : 0.001;
    const maxCols = Math.max(1, Math.floor((plateWidth + gridSpacing) / (width + gridSpacing)));
    const maxRows = Math.max(1, Math.floor((plateDepth + gridSpacing) / (depth + gridSpacing)));

    // Use actual spacing (including 0) for layout, not gridSpacing
    const totalUsedWidth = (maxCols * width) + Math.max(0, maxCols - 1) * spacing;
    const totalUsedDepth = (maxRows * depth) + Math.max(0, maxRows - 1) * spacing;
    const startX = minX + ((plateWidth - totalUsedWidth) * 0.5) + (width * 0.5);
    const startY = minY + ((plateDepth - totalUsedDepth) * 0.5) + (depth * 0.5);

    const projectPolygon = (poly: THREE.Vector2[], axis: THREE.Vector2) => {
      let min = Infinity;
      let max = -Infinity;
      for (const point of poly) {
        const projected = point.dot(axis);
        min = Math.min(min, projected);
        max = Math.max(max, projected);
      }
      return { min, max };
    };

    const polygonsOverlap = (a: THREE.Vector2[], b: THREE.Vector2[]) => {
      const testAxes = (poly: THREE.Vector2[]) => {
        for (let i = 0; i < poly.length; i += 1) {
          const p0 = poly[i];
          const p1 = poly[(i + 1) % poly.length];
          const edge = new THREE.Vector2(p1.x - p0.x, p1.y - p0.y);
          if (edge.lengthSq() <= 1e-10) continue;
          const axis = new THREE.Vector2(-edge.y, edge.x).normalize();
          const pa = projectPolygon(a, axis);
          const pb = projectPolygon(b, axis);
          if (pa.max <= pb.min + spacing || pb.max <= pa.min + spacing) return false;
        }
        return true;
      };
      return testAxes(a) && testAxes(b);
    };

    const blockedPolygons = scene.models
      .filter((m) => m.visible && m.id !== model.id)
      .map((m) => getModelSupportAwareFootprintPolygonRef.current(m, undefined, m.transform));

    const candidateCenters: Array<{ x: number; y: number; distSq: number }> = [];
    for (let row = 0; row < maxRows; row += 1) {
      for (let col = 0; col < maxCols; col += 1) {
        const x = startX + col * (width + spacing);
        const y = startY + row * (depth + spacing);
        const dx = x - model.transform.position.x;
        const dy = y - model.transform.position.y;
        candidateCenters.push({ x, y, distSq: dx * dx + dy * dy });
      }
    }
    candidateCenters.sort((a, b) => a.distSq - b.distSq);

    let capacity = 0;
    for (const candidate of candidateCenters) {
      const candidateTransform = {
        position: new THREE.Vector3(candidate.x, candidate.y, model.transform.position.z),
        rotation: model.transform.rotation.clone(),
        scale: model.transform.scale.clone(),
      };
      const candidatePolygon = getModelSupportAwareFootprintPolygonRef.current(model, undefined, candidateTransform);

      if (blockedPolygons.some((blocked) => polygonsOverlap(candidatePolygon, blocked))) {
        continue;
      }

      blockedPolygons.push(candidatePolygon);
      capacity += 1;
    }

    const targetCopies = Math.min(128, Math.max(1, capacity));
    setDuplicateTotalCopies(targetCopies);
  }, [
    buildHighPrecisionArrangeModels,
    duplicateLayoutMode,
    duplicatePrecisionMode,
    duplicateSpacingMm,
    getModelSupportAwareDimensionsMm,
    isAutoArranging,
    isDuplicating,
    scene,
    sleep,
    transformMgr.transformHook,
  ]);

  return {
    arrangePrecisionMode,
    setArrangePrecisionMode,
    arrangePlateFillMode,
    setArrangePlateFillMode,
    arrangeAllowRotateOnZ,
    setArrangeAllowRotateOnZ,
    arrangeLayoutMode,
    setArrangeLayoutMode,
    arrangeAnchorMode,
    setArrangeAnchorMode,
    arrangeArrayCountX,
    setArrangeArrayCountX,
    arrangeArrayCountY,
    setArrangeArrayCountY,
    arrangeArrayCountZ,
    setArrangeArrayCountZ,
    arrangeArrayGapX,
    setArrangeArrayGapX,
    arrangeArrayGapY,
    setArrangeArrayGapY,
    arrangeArrayGapZ,
    setArrangeArrayGapZ,
    activeArrangeOperation,
    setActiveArrangeOperation,
    isAutoArranging,
    setIsAutoArranging,
    arrangeOverlayElapsedSec,
    setArrangeOverlayElapsedSec,
    arrangeOverlayModelCount,
    setArrangeOverlayModelCount,
    duplicateTotalCopies,
    setDuplicateTotalCopies,
    duplicateSpacingMm,
    setDuplicateSpacingMm,
    showArrangeBlockingOverlay,
    arrangeOverlayContent,
    arrangeOverlayElapsedLabel,
    duplicateLayoutMode,
    setDuplicateLayoutMode,
    duplicatePrecisionMode,
    setDuplicatePrecisionMode,
    duplicateArrayCountX,
    setDuplicateArrayCountX,
    duplicateArrayCountY,
    setDuplicateArrayCountY,
    duplicateArrayCountZ,
    setDuplicateArrayCountZ,
    duplicateArrayGapX,
    setDuplicateArrayGapX,
    duplicateArrayGapY,
    setDuplicateArrayGapY,
    duplicateArrayGapZ,
    setDuplicateArrayGapZ,
    isDuplicating,
    setIsDuplicating,
    duplicatePreviewTransforms,
    setDuplicatePreviewTransforms,
    arrangeArrayPreviewItems,
    setArrangeArrayPreviewItems,
    duplicateSourcePreviewTransform,
    setDuplicateSourcePreviewTransform,
    duplicateApplySourceModel,
    setDuplicateApplySourceModel,
    duplicateApplySourceTransform,
    setDuplicateApplySourceTransform,
    effectiveDuplicateTotalCopies,
    isDuplicateSetupBlockingArrange,
    buildHighPrecisionArrangeSupportLocalPoints,
    buildHighPrecisionArrangeModels,
    resolveArrangeVisibleModels,
    applyArrangeTransforms,
    handleAutoArrangeModels,
    handleHighPrecisionArrangeModels,
    computeManualArrayArrangeUpdates,
    handleManualArrayArrangeModels,
    computeArrangeSlots,
    handleConfirmDuplicate,
    handleFillPlateDuplicate,
  };
}

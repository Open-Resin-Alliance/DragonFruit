import { generateUuid } from '@/utils/uuid';
import type { SupportPreset } from '../../supports/Settings/types';
import type { ClientAdjacencyMap } from './useClientAdjacencyMap';

// ─── Brush Identity ─────────────────────────────────────────────────────────

export type BrushType = 'MacroFace' | 'TexturedFace' | 'Ridge' | 'Point' | 'RoughEdge' | 'SoftRidge' | 'Ring' | 'ManualCircle' | 'ManualSquare' | 'Marker' | 'PointPath' | 'PointPerimeter' | 'SharpCorner' | 'MinimaIslands' | 'Unk Legacy Brush';

export type CustomSupportOperationType = 'minima' | 'perimeter' | 'infill' | 'centerline';

export interface CustomSupportOperation {
  id?: string; // Unique step identifier (optional for compatibility)
  type: CustomSupportOperationType;
  enabled?: boolean; // backwards compatibility
  
  // Sizing Preset binding to Support Studio presets
  supportPresetId?: string; // Map to physical columns (Light, Medium, Heavy, etc.)
  
  // Direct edit tracking flags to enforce precedence
  isIntervalDirectlyEdited?: boolean; // lock interval from being auto-updated
  isEndIntervalDirectlyEdited?: boolean; // lock Z end interval from being auto-updated
  
  // Spatial offset configurations
  insetDistanceMm?: number; // default 0.0mm (ensures no alterations unless configured)
  wrapFraction?: number; // default 1.0 (range 0.1 -> 1.0)
  
  // Z-gradient density
  enableZHeightDensity?: boolean; // default false
  minimaStartInterval?: number; // default 0 (Start Offset Percentage 0-100%)
  minimaEndInterval?: number | 'auto'; // default 100 (End Offset Percentage 0-100% or 'auto')
  endSpacingMm?: number; // End Tip Spacing (mm)
  zFactor?: number; // default 2.0 (legacy, replaced by endSpacingMm)
  zFactorCurve?: 'linear' | 'sigmoid' | 'parabolic';

  // Suppression rules for this specific operation
  suppression: {
    enabled: boolean;
    distanceMm: number;
    suppressAgainst: CustomSupportOperationType[];
  };

  // Spacing configurations
  spacing: {
    baseSpacingMm: number;
    
    // Sequence-based spacing (e.g., [1.0, 2.0] for perimeter)
    sequence?: number[]; 
    
    // Advanced perimeter solver modes
    solverMode?: 'standard' | 'closest' | 'add' | 'remove';
    useInflectionPoints?: boolean;
    
    // Infill-specific configurations
    infillPattern?: 'PoissonDisc' | 'Grid' | 'Honeycomb' | 'Concentric';
    seedFromMinima?: boolean;
    
    // Leaf creation configurations
    attemptLeafCreation?: boolean;
    leafInterval?: number;

    // Branch consolidation configurations (Phase 4)
    attemptBranchCreation?: boolean;
    branchInterval?: number;
    branchBlendFactor?: number;
    maxBranchingAngle?: number;
    consolidationMinZ?: number;
    consolidationBaseDistance?: number;
    consolidationTipDistance?: number;
    consolidationThetaAngle?: number;
  };
}

export interface CustomBrushTemplate {
  id: string;
  name: string;
  color: string;
  baseBrush?: BrushType; // Selection algorithm base type
  
  // Topology selection parameters
  selection: {
    // Optional setting enablement switches
    enableSlopeLimit?: boolean;
    enableNormalConeLimit?: boolean;
    enableCurvatureLimit?: boolean;
    enableDihedralLimit?: boolean;

    // Symmetrical normal cone range relative to local vertex normal
    normalConeAngleMinDeg: number;
    normalConeAngleMaxDeg: number;
    // Overhang slope ranges relative to vertical Z-axis
    overhangSlopeMinDeg: number;
    overhangSlopeMaxDeg: number;
    
    curvatureMin: number;
    curvatureMax: number;
    dihedralAngleToleranceDeg: number;

    // Advanced Smart Brush Preset Tunables
    creaseSeedAngleDeg?: number;        // Ridge: seed dihedral threshold
    creasePropagateAngleDeg?: number;   // Ridge: propagate dihedral threshold
    ridgeAlignmentTolerance?: number;    // Ridge: path direction dot product limit
    geodesicPathType?: 'circle' | 'square'; // Point: Dijkstra vs Tangent clamp
    zHeightEnvelopeToleranceMm?: number; // Ring: Z window tolerance
    roughnessThreshold?: number;         // RoughEdge: entropy/roughness threshold
    alphaRadiusMm?: number;              // Alpha-Shape solver radius

    // Marker-specific parameters
    markerRadiusMm?: number;
    markerTipShape?: 'circle' | 'line' | 'rectangle' | 'square' | 'hexagon';
    markerTipRotationDeg?: number;
    markerEraserMode?: boolean;
    markerCollisionMode?: 'fence' | 'push' | 'merge';

    // Point-path specific parameters
    pointPathWidthMm?: number;
    pointPathMode?: 'line' | 'polygon';

    // Centerline constraints parameters
    enableCenterlineConstraints?: boolean;
    centerlineWidthSpreadMm?: number;
    centerlineCurvatureLimitDeg?: number;

    enableMacroNormalFiltering?: boolean;
    useMacroNormalForCone?: boolean;
    useMacroNormalForSlope?: boolean;
    macroNormalSmoothingIterations?: number;
    macroNormalSmoothingLambda?: number;
  };

  // Ordered operational pipeline
  operations: CustomSupportOperation[];
}

// Each brush type maps to a fixed display color in the shader.
// Colors are defined as CSS hex strings here; converted to vec3 for GLSL.
export const BRUSH_COLORS: Record<BrushType, string> = {
  MacroFace:      '#4A90E2',   // blue
  TexturedFace:   '#14B8A6',   // teal/turquoise
  Ridge:          '#E2844A',   // orange
  Point:          '#7ED321',   // green
  RoughEdge:      '#9B59B6',   // purple
  SoftRidge:      '#A569BD',   // light purple/lavender
  Ring:           '#FF5B6F',   // pink/red
  ManualCircle:   '#06B6D4',   // teal/cyan
  ManualSquare:   '#F59E0B',   // amber/gold
  Marker:         '#E11D48',   // premium rose/red
  PointPath:      '#10B981',   // emerald/mint green
  PointPerimeter: '#059669',   // dark emerald/green for perimeter
  SharpCorner:    '#D97706',   // dark amber/orange for sharp corner
  MinimaIslands:  '#7ED321',   // bright neon green of Point Geodesic
  'Unk Legacy Brush': '#E11D48', // same red as Marker
};

// ─── Interaction Phase State Machine ────────────────────────────────────────

// The user-interaction phases per the spec.
// Idle → Propose (hover/approach) → Expand (click+drag) → Idle (release)
// Idle/Propose + modifier key → Subtract
export type BrushInteractionPhase = 'Idle' | 'Propose' | 'Expand' | 'Subtract';

// Modifier keys tracked at the window level.
export interface BrushModifierKeys {
  alt:   boolean;   // Alt held → Subtract mode
  shift: boolean;   // Shift held → alternate expand behavior (TBD Phase 3)
}

// ─── ROI Region ─────────────────────────────────────────────────────────────

// One painted region of interest on the mesh.
export interface ROIRegion {
  id:              string;          // UUID
  brushType:       BrushType;
  seedTriangleId:  number;          // Triangle the user clicked on (raycasted)
  triangleIds:     Set<number>;     // Triangles belonging to this ROI
  color:           string;          // CSS hex, sourced from BRUSH_COLORS
  proposedOnly:    boolean;         // true if not yet committed (hover preview)
  createdAt:       number;          // Date.now()

  // ─── Version 2 Persistent Serialization Elements ───
  // [AGENT_NOTE] Pre-computed during commitment/generation when geometry is available.
  loops?:          VoxlROIBoundaryLoop[];
  rleSpans?:       VoxlROIRunLength[];
  brush?:          BrushMetadata;
  support?:        SupportGenerationMetadata;
  modelId?:        string;          // Optional model reference for multi-model sheets
  loadedFromVoxl?: boolean;         // True if imported from a VOXL file
  placedCount?:    number;
  attemptedCount?: number;

  // ─── Version 3 Custom Support Brushes ───
  customBrush?:    CustomBrushTemplate;
  placementScriptId?: string | null;

  // ─── Direct Coordinate Binding (Option 1B) ───
  vectorPath?: {
    point: [number, number, number]; // Local coordinates
    normal?: [number, number, number];
    faceIndex?: number;
  }[];
}

// ─── Stage-Based Suppression Configurations [STAGE_SUPPRESSION] ───────────────
// [AGENT_NOTE] Declarative suppression rules used by the scripting engine.
// Allows decoupling candidate generation from spacing/filtering strategies.

export interface StageSuppressionConfig {
  /**
   * Suppression scope:
   * - 'none': No proximity suppression
   * - 'current': Only suppress against accepted points in the same ROI region
   * - 'all': Suppress against accepted points in any ROI region (cross-ROI)
   */
  mode: 'none' | 'current' | 'all';
  /**
   * Candidate stages that will trigger suppression against this stage.
   */
  types: ('minima' | 'perimeter' | 'infill' | 'centerline')[];
}

export interface SuppressionSettings {
  minima: StageSuppressionConfig;
  perimeter: StageSuppressionConfig;
  infill: StageSuppressionConfig;
  centerline: StageSuppressionConfig;
}

export interface SupportPainterToast {
  id: number;
  lines: string[];
}

export interface LocalMinimum {
  vertexIndex: number;
  position: { x: number; y: number; z: number };
  seedTriangleId: number;
}

// ─── Shader Data Types ───────────────────────────────────────────────────────

// Flat map from triangle index → packed RGBA color (for DataTexture upload).
// Indices that appear in no ROI map to [0,0,0,0] (transparent / use base material).
export type TriangleColorMap = Map<number, [number, number, number, number]>;

// ─── Master Painter State ────────────────────────────────────────────────────

export interface SupportPainterState {
  isActive:               boolean;
  activeBrush:            BrushType;
  interactionPhase:       BrushInteractionPhase;
  modifierKeys:           BrushModifierKeys;
  regions:                Map<string, ROIRegion>;
  regionsByModel?:        Map<string, Map<string, ROIRegion>>;
  scannedMinima:          LocalMinimum[];

  // Derived / cached — recomputed by the store whenever `regions` changes.
  // Passed directly to the WebGL shader as a DataTexture.
  triangleColorMap:       TriangleColorMap;

  // Transient hover state — NOT committed to `regions` and NOT persisted.
  hoveredTriangleId:      number | null;
  hoveredWorldPoint:      [number, number, number] | null;
  proposedTriangleIds:    Set<number>;  // preview highlight before user commits

  directGenEnabled:       boolean; // Action B: Direct Click-to-Generate toggle

  // ─── Extended Spacing & Suppression Parameters ───
  // [AGENT_NOTE] Custom spacing values in mm. Null indicates fallback to default calculation.
  perimeterSpacingOverride: number | null;
  infillSpacingOverride:    number | null;
  suppressionSettings:      SuppressionSettings;
  toast:                    SupportPainterToast | null;

  // ─── Granular Storage / Tracking Mode ───
  // [AGENT_NOTE] Governs persistence of ROIs: 'none' (transient), 'session' (in-memory only), 'voxl' (serialized to file).
  roiTrackingMode:          'none' | 'session' | 'voxl';
  selectedRegionId:         string | null;
  selectedRegionIds:        Set<string>;
  lastSelectedIndex:        number | null;

  // ─── Version 3 Custom Support Brushes State ───
  customBrushes:          Map<string, CustomBrushTemplate>;
  activeCustomBrushId:    string | null;

  // ─── Client Adjacency Map ───
  clientAdjacencyMap:     ClientAdjacencyMap | null;


  // ─── Version 4 Manual Geodesic Brushes State ───
  brushRadiusMm:          number;

  // ─── Marker Brush State ───
  markerRadiusMm:         number;
  markerTipShape:         'circle' | 'line' | 'rectangle' | 'square' | 'hexagon';
  markerTipRotationDeg:   number;
  markerEraserMode:       boolean;
  markerCollisionMode:    'fence' | 'push' | 'merge';

  // ─── Point Path Brush State ───
  pointPathPoints:        { point: [number, number, number]; faceIndex: number; normal?: [number, number, number] }[];
  pointPathWidthMm:       number;
  pointPathMode:          'line' | 'polygon';
  pointPathClosed:        boolean;

  // ─── Sharp Corner Brush State ───
  sharpCornerDihedralThresholdDeg: number;
  sharpCornerWrapCurves:           boolean;

  // ─── Phase III Active Brush Pipeline Override State ───
  activeBrushPipeline:    CustomSupportOperation[] | null;

  // ─── Support Placement Scripts State ───
  placementScripts:       Map<string, SupportPlacementScript>;
  activePlacementScriptId: string | null;

  // ─── Phase 3 Config Pack / Import Conflict State ───
  conflictState:          { conflicts: ConflictItem[]; pendingRoiExt: VoxlROIExtension } | null;

  // ─── Phase 4 Failed Placements Tracking & Walker State ───
  failedCandidates:       FailedPlacementCandidate[];
  activeFailureIndex:     number | null;

  smartBrushesDisplayMode: 'std' | 'ext';
  modelStatsCardCollapsed: boolean;
}

export interface FailedPlacementCandidate {
  id: string;
  pos: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  stage: 'minima' | 'perimeter' | 'infill' | 'centerline';
  regionId: string;
  reason: string;
}

export interface ConflictItem {
  id: string;
  type: 'script' | 'preset';
  name: string;
  localName: string;
  importedValue: any;
  localValue: any;
}

// ─── Store Action Payloads ───────────────────────────────────────────────────

export interface CommitRegionPayload {
  seedTriangleId: number;
  brushType:      BrushType;
}

export interface SubtractRegionPayload {
  triangleId: number;   // Remove the ROI region that owns this triangle
}

// ─── VOXL Serialization Types ────────────────────────────────────────────────
// Used by voxlCodec.ts to round-trip ROI data through the EXTD chunk.

export interface VoxlROIBoundaryLoop {
  type: 'outer' | 'hole';
  vertexIds: number[]; // Directed closed loop vertex indices in local mesh space
}

export interface VoxlROIRunLength {
  start: number;
  count: number;
}

export interface BrushMetadata {
  brushType: BrushType;
  parameters: {
    coplanarityAngleDeg?: number; // MacroFace
    creaseAngleDeg?: number;      // Ridge
    radiusMm?: number;            // Point Geodesic
    zThresholdMm?: number;        // Ring
    pointPathMode?: 'line' | 'polygon'; // PointPath
    pointPathClosed?: boolean; // PointPath
  };
}

export interface SupportGenerationMetadata {
  presetId: string;
  presetName: string;
  parameters: {
    shaftDiameterMm: number;
    perimeterSpacingMm: number;
    infillSpacingMm: number;
    minimaSuppressionRadiusMm: number;
    suppressionSettings: SuppressionSettings;
    tipContactDiameterMm?: number;
    tipBodyDiameterMm?: number;
    tipLengthMm?: number;
    tipConeAngleDeg?: number;
    rootsDiameterMm?: number;
    rootsDiskHeightMm?: number;
    rootsConeHeightMm?: number;
    baseFlareEnabled?: boolean;
    baseFlareDiameterMm?: number;
    baseFlareHeightMm?: number;
    shaftMaxAngleDeg?: number;
  };
}

export interface VoxlROIRegion {
  id:              string;
  brushType:       BrushType;
  seedTriangleId:  number;
  color:           string;
  createdAt:       number;

  // ─── Version 2 Persistent Serialization Elements ───
  loops?:          VoxlROIBoundaryLoop[];
  rleSpans?:       VoxlROIRunLength[];
  brush?:          BrushMetadata;
  support?:        SupportGenerationMetadata;
  modelId?:        string;          // Optional model reference for multi-model sheets
  placedCount?:    number;
  attemptedCount?: number;

  // ─── Version 3 Custom Support Brushes Serialization ───
  customBrush?:    CustomBrushTemplate;
  placementScriptId?: string | null;

  // ─── Direct Coordinate Binding ───
  vectorPath?: {
    point: [number, number, number];
    normal?: [number, number, number];
    faceIndex?: number;
  }[];
}

export interface VoxlROIExtension {
  kind:     'support-painter-rois';
  version:  number; // Incremented to support boundary-loops/RLE fallback (version 2)
  modelId:  string;            // UUID of the model these ROIs belong to
  regions:  VoxlROIRegion[];
  customPlacementScripts?: SupportPlacementScript[];
  customSupportPresets?: SupportPreset[];
}

/**
 * Upgrades a pipeline of CustomSupportOperations to ensure all standard operations
 * (minima, perimeter, infill, centerline) are present, in the correct order.
 * This is crucial for backward-compatibility with legacy VOXL formats or older custom brushes.
 */
export function upgradePipeline(
  ops: CustomSupportOperation[] | undefined,
  brushType: BrushType,
  defaultSpacing: number = 4.0
): CustomSupportOperation[] {
  if (ops) {
    return ops.map(op => {
      const upgradedSpacing = { ...op.spacing };
      if (op.type === 'minima') {
        if (upgradedSpacing.attemptLeafCreation === undefined) {
          upgradedSpacing.attemptLeafCreation = true;
        }
        if (upgradedSpacing.leafInterval === undefined) {
          upgradedSpacing.leafInterval = 4.0;
        }
      }
      
      const upgradedSuppression = { ...op.suppression };
      if (op.type === 'minima') {
        if (upgradedSuppression.enabled === undefined) {
          upgradedSuppression.enabled = true;
        }
        if (upgradedSuppression.distanceMm === undefined) {
          upgradedSuppression.distanceMm = 0.8;
        }
      }

      return {
        ...op,
        id: op.id || generateUuid(),
        minimaStartInterval: op.minimaStartInterval ?? 0,     // Default to 0% Start Offset
        minimaEndInterval: op.minimaEndInterval ?? 100,       // Default to 100% End Offset
        endSpacingMm: op.endSpacingMm ?? defaultSpacing,      // Default to 4x trunk size
        wrapFraction: op.wrapFraction !== undefined
          ? (op.wrapFraction <= 1.0 ? Math.round(op.wrapFraction * 100) : op.wrapFraction)
          : 100,
        spacing: upgradedSpacing,
        suppression: upgradedSuppression,
      };
    });
  }

  let activeBrushType = brushType;
  if ((activeBrushType as string) === 'CylinderMinima') activeBrushType = 'SoftRidge';
  if ((activeBrushType as string) === 'CylinderSides') activeBrushType = 'RoughEdge';

  const isPointPathOrMarker = activeBrushType === 'PointPath' || activeBrushType === 'Marker' || activeBrushType === 'RoughEdge' || activeBrushType === 'Unk Legacy Brush';
  const isLineBrush = activeBrushType === 'Ridge' || activeBrushType === 'SoftRidge' || activeBrushType === 'PointPath';
  const isMinimaIslands = activeBrushType === 'MinimaIslands';

  const standardTypes: ('minima' | 'perimeter' | 'infill' | 'centerline')[] = [
    'minima',
    'perimeter',
    'infill',
    'centerline',
  ];

  const defaultOps: Record<'minima' | 'perimeter' | 'infill' | 'centerline', CustomSupportOperation> = {
    minima: {
      type: 'minima',
      enabled: isMinimaIslands || (!isPointPathOrMarker && !isLineBrush),
      suppression: {
        enabled: true,
        distanceMm: 0.8,
        suppressAgainst: ['minima'],
      },
      spacing: {
        baseSpacingMm: defaultSpacing,
        attemptLeafCreation: true,
        leafInterval: 4.0,
        attemptBranchCreation: false,
        branchInterval: defaultSpacing,
        branchBlendFactor: 0.5,
        maxBranchingAngle: 45,
        consolidationMinZ: 8.0,
        consolidationBaseDistance: 2.0,
        consolidationTipDistance: 5.0,
        consolidationThetaAngle: 20.0,
      },
    },
    perimeter: {
      type: 'perimeter',
      enabled: !isMinimaIslands && !isPointPathOrMarker && !isLineBrush,
      suppression: {
        enabled: false,
        distanceMm: defaultSpacing,
        suppressAgainst: [],
      },
      spacing: {
        baseSpacingMm: defaultSpacing,
        solverMode: 'standard',
        useInflectionPoints: false,
        attemptLeafCreation: false,
        leafInterval: defaultSpacing,
        attemptBranchCreation: false,
        branchInterval: defaultSpacing,
        branchBlendFactor: 0.5,
        maxBranchingAngle: 45,
        consolidationMinZ: 8.0,
        consolidationBaseDistance: 2.0,
        consolidationTipDistance: 5.0,
        consolidationThetaAngle: 20.0,
      },
    },
    infill: {
      type: 'infill',
      enabled: !isMinimaIslands && !isLineBrush,
      suppression: {
        enabled: true,
        distanceMm: defaultSpacing,
        suppressAgainst: ['minima', 'perimeter', 'infill'],
      },
      spacing: {
        baseSpacingMm: defaultSpacing,
        infillPattern: 'PoissonDisc',
        seedFromMinima: true,
        attemptLeafCreation: false,
        leafInterval: defaultSpacing,
        attemptBranchCreation: false,
        branchInterval: defaultSpacing,
        branchBlendFactor: 0.5,
        maxBranchingAngle: 45,
        consolidationMinZ: 8.0,
        consolidationBaseDistance: 2.0,
        consolidationTipDistance: 5.0,
        consolidationThetaAngle: 20.0,
      },
    },
    centerline: {
      type: 'centerline',
      enabled: !isMinimaIslands && isLineBrush,
      suppression: {
        enabled: true,
        distanceMm: defaultSpacing,
        suppressAgainst: ['minima', 'perimeter', 'infill', 'centerline'],
      },
      spacing: {
        baseSpacingMm: defaultSpacing,
        seedFromMinima: true,
        attemptLeafCreation: false,
        leafInterval: defaultSpacing,
        attemptBranchCreation: false,
        branchInterval: defaultSpacing,
        branchBlendFactor: 0.5,
        maxBranchingAngle: 45,
        consolidationMinZ: 8.0,
        consolidationBaseDistance: 2.0,
        consolidationTipDistance: 5.0,
        consolidationThetaAngle: 20.0,
      },
    },
  };

  return standardTypes.map(type => ({
    ...defaultOps[type],
    id: generateUuid(),
    minimaStartInterval: 0,
    minimaEndInterval: 100,
    endSpacingMm: defaultSpacing,
    wrapFraction: 100,
  })).filter(op => op.enabled);
}

export interface SupportPlacementScript {
  id: string;
  name: string;
  operations: CustomSupportOperation[];
  isBuiltIn?: boolean;
  isReadOnly?: boolean;
}

export function arePipelinesEquivalent(a: CustomSupportOperation[], b: CustomSupportOperation[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const opA = a[i];
    const opB = b[i];
    if (opA.type !== opB.type) return false;
    if (opA.enabled !== opB.enabled) return false;
    if (opA.supportPresetId !== opB.supportPresetId) return false;
    if (opA.insetDistanceMm !== opB.insetDistanceMm) return false;
    if (opA.wrapFraction !== opB.wrapFraction) return false;
    if (opA.enableZHeightDensity !== opB.enableZHeightDensity) return false;
    if (opA.minimaStartInterval !== opB.minimaStartInterval) return false;
    if (opA.minimaEndInterval !== opB.minimaEndInterval) return false;
    if (opA.endSpacingMm !== opB.endSpacingMm) return false;
    if (opA.zFactorCurve !== opB.zFactorCurve) return false;
    
    // Compare suppression
    const supA = opA.suppression;
    const supB = opB.suppression;
    if (supA.enabled !== supB.enabled) return false;
    if (supA.distanceMm !== supB.distanceMm) return false;
    if (supA.suppressAgainst.length !== supB.suppressAgainst.length) return false;
    for (let j = 0; j < supA.suppressAgainst.length; j++) {
      if (supA.suppressAgainst[j] !== supB.suppressAgainst[j]) return false;
    }

    // Compare spacing
    const spA = opA.spacing;
    const spB = opB.spacing;
    if (spA.baseSpacingMm !== spB.baseSpacingMm) return false;
    if (spA.solverMode !== spB.solverMode) return false;
    if (spA.useInflectionPoints !== spB.useInflectionPoints) return false;
    if (spA.infillPattern !== spB.infillPattern) return false;
    if (spA.seedFromMinima !== spB.seedFromMinima) return false;
    if (spA.attemptLeafCreation !== spB.attemptLeafCreation) return false;
    if (spA.leafInterval !== spB.leafInterval) return false;
    if (spA.attemptBranchCreation !== spB.attemptBranchCreation) return false;
    if (spA.branchInterval !== spB.branchInterval) return false;
    if (spA.branchBlendFactor !== spB.branchBlendFactor) return false;
    if (spA.maxBranchingAngle !== spB.maxBranchingAngle) return false;
    if (spA.consolidationMinZ !== spB.consolidationMinZ) return false;
    if (spA.consolidationBaseDistance !== spB.consolidationBaseDistance) return false;
    if (spA.consolidationTipDistance !== spB.consolidationTipDistance) return false;
    if (spA.consolidationThetaAngle !== spB.consolidationThetaAngle) return false;
  }
  return true;
}


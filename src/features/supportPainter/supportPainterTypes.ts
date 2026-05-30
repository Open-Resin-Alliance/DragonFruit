// ─── Brush Identity ─────────────────────────────────────────────────────────

export type BrushType = 'MacroFace' | 'Ridge' | 'Point' | 'CylinderSides' | 'CylinderMinima' | 'Ring' | 'ManualCircle' | 'ManualSquare' | 'Marker' | 'PointPath' | 'MinimaIslands';

// ─── Custom Support Operations & Pipeline Typings ───────────────────────────

export interface CustomSupportOperation {
  type: 'minima' | 'perimeter' | 'infill' | 'centerline';
  enabled: boolean;
  
  // Suppression rules for this specific operation
  suppression: {
    enabled: boolean;
    distanceMm: number;
    suppressAgainst: ('minima' | 'perimeter' | 'infill' | 'centerline')[];
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

    // Marker-specific parameters
    markerRadiusMm?: number;
    markerTipShape?: 'circle' | 'line' | 'rectangle' | 'square' | 'hexagon';
    markerTipRotationDeg?: number;
    markerEraserMode?: boolean;
    markerCollisionMode?: 'fence' | 'push' | 'merge';

    // Point-path specific parameters
    pointPathWidthMm?: number;
    pointPathMode?: 'line' | 'polygon';
  };

  // Ordered operational pipeline
  operations: CustomSupportOperation[];
}

// Each brush type maps to a fixed display color in the shader.
// Colors are defined as CSS hex strings here; converted to vec3 for GLSL.
export const BRUSH_COLORS: Record<BrushType, string> = {
  MacroFace:      '#4A90E2',   // blue
  Ridge:          '#E2844A',   // orange
  Point:          '#7ED321',   // green
  CylinderSides:  '#9B59B6',   // purple
  CylinderMinima: '#A569BD',   // light purple/lavender
  Ring:           '#FF5B6F',   // pink/red
  ManualCircle:   '#06B6D4',   // teal/cyan
  ManualSquare:   '#F59E0B',   // amber/gold
  Marker:         '#E11D48',   // premium rose/red
  PointPath:      '#10B981',   // emerald/mint green
  MinimaIslands:  '#7ED321',   // bright neon green of Point Geodesic
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

  // ─── Version 3 Custom Support Brushes State ───
  customBrushes:          Map<string, CustomBrushTemplate>;
  activeCustomBrushId:    string | null;

  // ─── Version 4 Manual Geodesic Brushes State ───
  brushRadiusMm:          number;

  // ─── Marker Brush State ───
  markerRadiusMm:         number;
  markerTipShape:         'circle' | 'line' | 'rectangle' | 'square' | 'hexagon';
  markerTipRotationDeg:   number;
  markerEraserMode:       boolean;
  markerCollisionMode:    'fence' | 'push' | 'merge';

  // ─── Point Path Brush State ───
  pointPathPoints:        { point: [number, number, number]; faceIndex: number }[];
  pointPathWidthMm:       number;
  pointPathMode:          'line' | 'polygon';
  pointPathClosed:        boolean;

  // ─── Phase III Active Brush Pipeline Override State ───
  activeBrushPipeline:    CustomSupportOperation[] | null;
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
}

export interface VoxlROIExtension {
  kind:     'support-painter-rois';
  version:  number; // Incremented to support boundary-loops/RLE fallback (version 2)
  modelId:  string;            // UUID of the model these ROIs belong to
  regions:  VoxlROIRegion[];
}

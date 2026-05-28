// ─── Brush Identity ─────────────────────────────────────────────────────────

export type BrushType = 'MacroFace' | 'Ridge' | 'Point' | 'CylinderSides' | 'CylinderMinima' | 'Ring';

// Each brush type maps to a fixed display color in the shader.
// Colors are defined as CSS hex strings here; converted to vec3 for GLSL.
export const BRUSH_COLORS: Record<BrushType, string> = {
  MacroFace:      '#4A90E2',   // blue
  Ridge:          '#E2844A',   // orange
  Point:          '#7ED321',   // green
  CylinderSides:  '#9B59B6',   // purple
  CylinderMinima: '#A569BD',   // light purple/lavender
  Ring:           '#FF5B6F',   // pink/red
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
  types: ('minima' | 'perimeter' | 'infill')[];
}

export interface SuppressionSettings {
  minima: StageSuppressionConfig;
  perimeter: StageSuppressionConfig;
  infill: StageSuppressionConfig;
}

export interface SupportPainterToast {
  id: number;
  lines: string[];
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

  // Derived / cached — recomputed by the store whenever `regions` changes.
  // Passed directly to the WebGL shader as a DataTexture.
  triangleColorMap:       TriangleColorMap;

  // Transient hover state — NOT committed to `regions` and NOT persisted.
  hoveredTriangleId:      number | null;
  proposedTriangleIds:    Set<number>;  // preview highlight before user commits

  directGenEnabled:       boolean; // Action B: Direct Click-to-Generate toggle

  // ─── Extended Spacing & Suppression Parameters ───
  // [AGENT_NOTE] Custom spacing values in mm. Null indicates fallback to default calculation.
  perimeterSpacingOverride: number | null;
  infillSpacingOverride:    number | null;
  suppressionSettings:      SuppressionSettings;
  toast:                    SupportPainterToast | null;
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

export interface VoxlROIRegion {
  id:              string;
  brushType:       BrushType;
  seedTriangleId:  number;
  triangleIds:     number[];   // Array for JSON (Set is not JSON-serializable)
  color:           string;
  createdAt:       number;
}

export interface VoxlROIExtension {
  kind:     'support-painter-rois';
  version:  1;
  modelId:  string;            // UUID of the model these ROIs belong to
  regions:  VoxlROIRegion[];
}
